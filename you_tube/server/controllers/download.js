import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import download from "../Modals/download.js";
import downloadQuota from "../Modals/downloadQuota.js";
import user from "../Modals/Auth.js";

import {
  verifyEligibility,
  checkDuplicate,
  reserveQuota,
  releaseQuota,
  getStartOfDay,
  getStartOfMonth,
  getBrowser,
  getDevice,
  PLAN_LIMITS
} from "../services/downloadService.js";

export const checkDownloadEligibility = async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    const firebaseEmail = req.firebaseUser.email;
    const deviceId = req.headers["x-device-id"] || req.query.deviceId;

    const eligibility = await verifyEligibility(firebaseEmail, deviceId, videoId);
    if (eligibility.error) {
      return res.status(eligibility.status).json({ message: eligibility.error });
    }

    const { currentUser, plan, limits } = eligibility;

    const duplicateCheck = await checkDuplicate(currentUser._id, videoId);
    if (duplicateCheck.error) {
      return res.status(duplicateCheck.status).json({ message: duplicateCheck.error });
    }

    if (duplicateCheck.isDuplicate) {
      return res.status(200).json({ message: "Eligible (Duplicate, no quota used)" });
    }

    const dailyPeriodStart = getStartOfDay();
    const monthlyPeriodStart = getStartOfMonth();

    const dailyQuotaUsed = await downloadQuota.findOne({
      userId: currentUser._id,
      periodType: "daily",
      periodStart: dailyPeriodStart,
    });
    
    if (dailyQuotaUsed && dailyQuotaUsed.used >= limits.daily) {
      return res.status(403).json({ message: "Daily download limit reached. Upgrade your plan to download more videos." });
    }

    const monthlyQuotaUsed = await downloadQuota.findOne({
      userId: currentUser._id,
      periodType: "monthly",
      periodStart: monthlyPeriodStart,
    });

    if (monthlyQuotaUsed && monthlyQuotaUsed.used >= limits.monthly) {
      return res.status(403).json({ message: "Monthly download limit reached. Upgrade your plan to download more videos." });
    }

    return res.status(200).json({ message: "Eligible" });
  } catch (error) {
    console.error("Check eligibility error:", error);
    return res.status(500).json({ message: "Failed to check download eligibility" });
  }
};

export const downloadVideo = async (req, res) => {
  let downloadRecord = null;
  let dailyReserved = false;
  let monthlyReserved = false;
  let dailyPeriodStart = null;
  let monthlyPeriodStart = null;

  try {
    const { videoId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    const firebaseEmail = req.firebaseUser.email;
    const deviceId = req.headers["x-device-id"] || req.query.deviceId;

    console.log(`[downloadVideo] Request received for video ${videoId} from user ${firebaseEmail}`);

    const eligibility = await verifyEligibility(firebaseEmail, deviceId, videoId);
    if (eligibility.error) {
      console.log(`[downloadVideo] Eligibility failed: ${eligibility.error}`);
      return res.status(eligibility.status).json({ message: eligibility.error });
    }

    const { currentUser, selectedVideo, plan, limits } = eligibility;

    const idempotencyKey = req.headers["x-idempotency-key"] || req.query.idempotencyKey;
    if (idempotencyKey) {
      const duplicateRequest = await download.findOne({ idempotencyKey });
      if (duplicateRequest) {
        console.log(`[downloadVideo] Duplicate idempotency key detected: ${idempotencyKey}`);
        return res.status(409).json({ message: "Duplicate download request detected." });
      }
    }

    const duplicateCheck = await checkDuplicate(currentUser._id, videoId);
    if (duplicateCheck.error) {
      console.log(`[downloadVideo] Duplicate check error: ${duplicateCheck.error}`);
      return res.status(duplicateCheck.status).json({ message: duplicateCheck.error });
    }

    dailyPeriodStart = getStartOfDay();
    monthlyPeriodStart = getStartOfMonth();

    if (!duplicateCheck.isDuplicate) {
      console.log(`[downloadVideo] Reserving quota for user ${currentUser._id}`);
      const dailyQuota = await reserveQuota(currentUser._id, "daily", dailyPeriodStart, limits.daily);
      if (!dailyQuota) {
        console.log(`[downloadVideo] Daily quota exceeded`);
        return res.status(403).json({ message: "Daily download limit reached", remainingDailyQuota: 0 });
      }
      dailyReserved = true;

      const monthlyQuota = await reserveQuota(currentUser._id, "monthly", monthlyPeriodStart, limits.monthly);
      if (!monthlyQuota) {
        await releaseQuota(currentUser._id, "daily", dailyPeriodStart);
        dailyReserved = false;
        console.log(`[downloadVideo] Monthly quota exceeded`);
        return res.status(403).json({ message: "Monthly download limit reached", remainingMonthlyQuota: 0 });
      }
      monthlyReserved = true;
    } else {
      console.log(`[downloadVideo] Allowed as duplicate, no quota reserved`);
    }

    const userAgent = req.headers["user-agent"] || "unknown";
    const ipAddress = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";

    downloadRecord = await download.create({
      userId: currentUser._id,
      videoId: selectedVideo._id,
      downloadDate: new Date(),
      ipAddress,
      deviceId,
      deviceInfo: `${getDevice(userAgent)} | Device ID: ${deviceId}`,
      browser: getBrowser(userAgent),
      subscriptionPlan: plan,
      fileSize: selectedVideo.filesize,
      status: "pending",
      idempotencyKey: idempotencyKey || undefined,
    });

    const filePath = path.resolve(selectedVideo.filepath);
    const fileName = selectedVideo.filename || "video.mp4";

    console.log(`[downloadVideo] Starting file stream for ${filePath}`);
    
    try {
      const stat = fs.statSync(filePath);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', 'video/mp4');
      // Use encodeURIComponent to avoid header character crashing
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

      const readStream = fs.createReadStream(filePath);
      
      readStream.on('error', async (error) => {
        console.error("[downloadVideo] Stream read error:", error);
        if (downloadRecord) {
          downloadRecord.status = "failed";
          await downloadRecord.save();
        }
        if (!res.headersSent) {
          res.status(500).send(`Download failed: ${error.message}`);
        }
      });

      readStream.on('end', async () => {
        console.log(`[downloadVideo] Download finished successfully`);
        if (downloadRecord) {
          downloadRecord.status = "completed";
          await downloadRecord.save();
        }
      });

      req.on('close', async () => {
        if (!readStream.destroyed) {
          readStream.destroy();
          console.log(`[downloadVideo] Download interrupted by client`);
          if (downloadRecord && downloadRecord.status === "pending") {
            downloadRecord.status = "interrupted";
            await downloadRecord.save();
          }
        }
      });

      readStream.pipe(res);
    } catch (error) {
      console.error("[downloadVideo] File stream setup error:", error);
      if (dailyReserved) await releaseQuota(currentUser._id, "daily", dailyPeriodStart);
      if (monthlyReserved) await releaseQuota(currentUser._id, "monthly", monthlyPeriodStart);
      
      if (!res.headersSent) {
        res.status(500).send(`Download failed: ${error.message}`);
      }
    }

  } catch (error) {
    console.error("[downloadVideo] Controller error:", error);

    // If currentUser._id is not available yet, we can't release quota easily.
    // In a real app we'd keep track of userId earlier.
    if (downloadRecord) {
      downloadRecord.status = "failed";
      await downloadRecord.save();
    }

    if (!res.headersSent) {
      return res.status(500).json({ message: "Something went wrong while processing the download" });
    }
  }
};

export const getMyDownloads = async (req, res) => {
  try {
    const currentUser = await user.findOne({
      email: req.firebaseUser.email,
    });

    if (!currentUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    let plan = currentUser.subscriptionPlan || "free";

    // Expired paid subscription becomes free.
    if (plan !== "free") {
      if (
        !currentUser.subscriptionExpiryDate ||
        new Date(currentUser.subscriptionExpiryDate) <= new Date()
      ) {
        plan = "free";
        currentUser.subscriptionPlan = "free";
        await currentUser.save();
      }
    }

    const limits = PLAN_LIMITS[plan];

    const dailyPeriodStart = getStartOfDay();
    const monthlyPeriodStart = getStartOfMonth();

    const todayDownloads = await download.find({
      userId: currentUser._id,
      downloadDate: { $gte: dailyPeriodStart },
      status: { $in: ["pending", "completed"] },
    });

    const monthlyDownloads = await download.find({
      userId: currentUser._id,
      downloadDate: { $gte: monthlyPeriodStart },
      status: { $in: ["pending", "completed"] },
    });

    const myDownloads = await download
      .find({ userId: currentUser._id })
      .populate("videoId", "videotitle thumbnail")
      .sort({ downloadDate: -1 });

    const downloadsWithVideoDetails = myDownloads.filter(d => d.videoId);

    return res.status(200).json({
      downloads: downloadsWithVideoDetails,
      subscriptionPlan: plan,
      dailyDownloadLimit: limits.daily,
      monthlyDownloadLimit: limits.monthly,
      remainingDailyQuota: Math.max(0, limits.daily - todayDownloads.length),
      remainingMonthlyQuota: Math.max(0, limits.monthly - monthlyDownloads.length),
    });
  } catch (error) {
    console.error("Error fetching downloads:", error);
    return res.status(500).json({
      message: "Unable to fetch downloads",
    });
  }
};
