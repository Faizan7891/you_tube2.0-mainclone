import { getAuth } from "firebase-admin/auth";
import firebaseAdmin from "../firebaseAdmin.js";

const adminAuth = getAuth(firebaseAdmin);

export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    let token;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split("Bearer ")[1];
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const decodedToken = await adminAuth.verifyIdToken(token);

    req.firebaseUser = decodedToken;

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(401).json({
      message: "Invalid or expired authentication token",
    });
  }
};