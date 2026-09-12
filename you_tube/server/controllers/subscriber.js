import Subscriber from "../Modals/subscriber.js";

export const toggleSubscribe = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const existingSub = await Subscriber.findOne({
      subscriberId: userId,
      channelId,
    });

    if (existingSub) {
      // Unsubscribe
      await Subscriber.findByIdAndDelete(existingSub._id);
      return res.status(200).json({ subscribed: false, message: "Unsubscribed" });
    } else {
      // Subscribe
      await Subscriber.create({
        subscriberId: userId,
        channelId,
      });
      return res.status(200).json({ subscribed: true, message: "Subscribed" });
    }
  } catch (error) {
    console.error("Error toggling subscription:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const checkSubscription = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { userId } = req.query; // pass userId via query param

    if (!userId) {
      return res.status(200).json({ subscribed: false });
    }

    const existingSub = await Subscriber.findOne({
      subscriberId: userId,
      channelId,
    });

    return res.status(200).json({ subscribed: !!existingSub });
  } catch (error) {
    console.error("Error checking subscription:", error);
    res.status(500).json({ message: "Server error" });
  }
};
