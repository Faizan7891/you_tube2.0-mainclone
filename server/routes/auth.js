import express from "express";

import {
  login,
  updateprofile,
  sendLoginOTP,
  verifyLoginOTP,
  updateTheme,
} from "../controllers/auth.js";

const routes = express.Router();

routes.post("/login", login);

routes.post(
  "/login/send-otp",
  sendLoginOTP
);

routes.post(
  "/login/verify-otp",
  verifyLoginOTP
);

routes.patch(
  "/update/:id",
  updateprofile
);

routes.patch(
  "/theme/:id",
  updateTheme
);

export default routes;