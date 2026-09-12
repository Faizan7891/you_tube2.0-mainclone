import express from "express";
import { checkSubscription, toggleSubscribe } from "../controllers/subscriber.js";

const routes = express.Router();

routes.post("/toggle/:channelId", toggleSubscribe);
routes.get("/check/:channelId", checkSubscription);

export default routes;
