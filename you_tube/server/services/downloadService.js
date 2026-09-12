import fs from "fs";
import download from "../Modals/download.js";
import downloadQuota from "../Modals/downloadQuota.js";
import video from "../Modals/video.js";
import user from "../Modals/Auth.js";

export const PLAN_LIMITS = {
  free: { daily: 1, monthly: 30 },
  bronze: { daily: 3, monthly: 90 },
  silver: { daily: 5, monthly: 150 },
  gold: { daily: 10, monthly: 300 },
};

export const getBrowser = (userAgent) => {
  if (!userAgent) return "unknown";
  if (userAgent.includes("Edg")) return "Edge";
  if (userAgent.includes("Chrome")) return "Chrome";
  if (userAgent.includes("Firefox")) return "Firefox";
  if (userAgent.includes("Safari")) return "Safari";
  if (userAgent.includes("Opera")) return "Opera";
  return "unknown";
};

export const getDevice = (userAgent) => {
  if (!userAgent) return "unknown";
  if (/mobile/i.test(userAgent)) return "Mobile";
  if (/tablet/i.test(userAgent)) return "Tablet";
  return "Desktop";
};

export const getStartOfDay = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

export const getStartOfMonth = () => {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
};

export const reserveQuota = async (userId, periodType, periodStart, limit) => {
  let quota = await downloadQuota.findOne({ userId, periodType, periodStart });

  if (!quota) {
    try {
      quota = await downloadQuota.create({
        userId,
        periodType,
        periodStart,
        used: 0,
        limit,
      });
    } catch (error) {
      if (error.code === 11000) {
        quota = await downloadQuota.findOne({ userId, periodType, periodStart });
      } else {
        throw error;
      }
    }
  }

  const updatedQuota = await downloadQuota.findOneAndUpdate(
    { _id: quota._id, used: { $lt: limit } },
    { $inc: { used: 1 }, $set: { limit } },
    { new: true }
  );

  return updatedQuota;
};

export const releaseQuota = async (userId, periodType, periodStart) => {
  await downloadQuota.findOneAndUpdate(
    { userId, periodType, periodStart, used: { $gt: 0 } },
    { $inc: { used: -1 } }
  );
};

export const verifyEligibility = async (firebaseEmail, deviceId, videoId) => {
  const currentUser = await user.findOne({ email: firebaseEmail });
  if (!currentUser) return { error: "User not found", status: 404 };

  if (!deviceId) return { error: "Device identification is required", status: 400 };

  if (!currentUser.registeredDeviceId) {
    currentUser.registeredDeviceId = deviceId;
    await currentUser.save();
  }

  if (currentUser.registeredDeviceId !== deviceId) {
    return { error: "Downloads are restricted to your registered device", status: 403 };
  }

  const selectedVideo = await video.findById(videoId);
  if (!selectedVideo) return { error: "Video not found", status: 404 };
  if (!selectedVideo.filepath || !fs.existsSync(selectedVideo.filepath)) {
    return { error: "Video file is not available", status: 404 };
  }

  let plan = currentUser.subscriptionPlan || "free";
  if (plan !== "free") {
    if (!currentUser.subscriptionExpiryDate || new Date(currentUser.subscriptionExpiryDate) <= new Date()) {
      plan = "free";
      currentUser.subscriptionPlan = "free";
      await currentUser.save();
    }
  }

  const limits = PLAN_LIMITS[plan];

  return { currentUser, selectedVideo, plan, limits };
};

export const checkDuplicate = async (userId, videoId) => {
  const duplicatePeriod = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentDuplicate = await download.findOne({
    userId,
    videoId,
    status: { $in: ["pending", "completed"] },
    downloadDate: { $gte: duplicatePeriod },
  });

  if (recentDuplicate) {
    if (recentDuplicate.status === "pending") {
      return { error: "This video is already being downloaded", status: 409 };
    }
    return { isDuplicate: true };
  }
  return { isDuplicate: false };
};
