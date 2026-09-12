import React, { useEffect, useState } from "react";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Button } from "./ui/button";
import {
  Clock,
  Download,
  MoreHorizontal,
  Share,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useUser } from "@/lib/AuthContext";
import axiosInstance from "@/lib/axiosinstance";
import { getDeviceId } from "@/lib/deviceId";
import { auth } from "@/lib/firebase";

const VideoInfo = ({ video }: any) => {
  const [likes, setlikes] = useState(video.Like || 0);
  const [dislikes, setDislikes] = useState(video.Dislike || 0);
  const [isLiked, setIsLiked] = useState(false);
  const [isDisliked, setIsDisliked] = useState(false);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const { user } = useUser();
  const [isWatchLater, setIsWatchLater] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);

  // const user: any = {
  //   id: "1",
  //   name: "John Doe",
  //   email: "john@example.com",
  //   image: "https://github.com/shadcn.png?height=32&width=32",
  // };
  useEffect(() => {
    setlikes(video.Like || 0);
    setDislikes(video.Dislike || 0);
    setIsLiked(false);
    setIsDisliked(false);

    if (user && video.videochanel) {
      axiosInstance
        .get(`/subscriber/check/${video.videochanel}?userId=${user._id}`)
        .then((res) => setIsSubscribed(res.data.subscribed))
        .catch(console.error);
    }
  }, [video, user]);

  useEffect(() => {
    const handleviews = async () => {
      if (user) {
        try {
          return await axiosInstance.post(`/history/${video._id}`, {
            userId: user?._id,
          });
        } catch (error) {
          return console.log(error);
        }
      } else {
        return await axiosInstance.post(`/history/views/${video?._id}`);
      }
    };
    handleviews();
  }, [user]);
  const handleLike = async () => {
    if (!user) return;
    try {
      const res = await axiosInstance.post(`/like/${video._id}`, {
        userId: user?._id,
      });
      if (res.data.liked) {
        setlikes((prev: any) => prev + 1);
        setIsLiked(true);
        if (isDisliked) {
          setDislikes((prev: any) => Math.max(0, prev - 1));
          setIsDisliked(false);
        }
      } else {
        setlikes((prev: any) => Math.max(0, prev - 1));
        setIsLiked(false);
      }
    } catch (error) {
      console.log(error);
    }
  };
  const handleWatchLater = async () => {
    try {
      const res = await axiosInstance.post(`/watch/${video._id}`, {
        userId: user?._id,
      });
      if (res.data.watchlater) {
        setIsWatchLater(!isWatchLater);
      } else {
        setIsWatchLater(false);
      }
    } catch (error) {
      console.log(error);
    }
  };
  const handleDislike = async () => {
    if (!user) return;
    try {
      // Temporary frontend-only logic for dislike toggling
      // since there is no dedicated dislike endpoint.
      if (isDisliked) {
        setDislikes((prev: any) => Math.max(0, prev - 1));
        setIsDisliked(false);
      } else {
        setDislikes((prev: any) => prev + 1);
        setIsDisliked(true);
        if (isLiked) {
          setlikes((prev: any) => Math.max(0, prev - 1));
          setIsLiked(false);
          // Try to actually unlike in the backend to stay synced
          await axiosInstance.post(`/like/${video._id}`, {
            userId: user?._id,
          });
        }
      }
    } catch (error) {
      console.log(error);
    }
  };

  const handleDownload = async () => {
    if (!user) {
      alert("Please login to download videos.");
      return;
    }

    try {
      const deviceId = getDeviceId();
      const idempotencyKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' 
        ? crypto.randomUUID() 
        : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        
      let token = "";
      if (auth.currentUser) {
        token = await auth.currentUser.getIdToken();
      }

      // Check eligibility first to gracefully handle quota errors
      try {
        await axiosInstance.get(`/download/check/${video._id}?deviceId=${deviceId}`);
      } catch (checkError: any) {
        console.error("Eligibility check failed:", checkError);
        alert(checkError.response?.data?.message || "You are not eligible to download this video.");
        return;
      }

      const backendUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:5000";
      const downloadUrl = `${backendUrl}/download/${video._id}?token=${token}&deviceId=${deviceId}&idempotencyKey=${idempotencyKey}`;

      // Use fetch to download the video without navigating away from the page
      alert("Download started... please wait while it processes.");
      
      const response = await fetch(downloadUrl);
      
      if (!response.ok) {
        // If the backend returned an error (e.g. 500), read the error message and alert it
        const errorText = await response.text();
        alert(errorText || "Download failed due to a server error.");
        return;
      }
      
      // If successful, create a local blob and trigger the browser download
      const blob = await response.blob();
      const localUrl = window.URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = localUrl;
      link.download = video.filename || "video.mp4";
      document.body.appendChild(link);
      link.click();
      
      // Cleanup
      link.remove();
      window.URL.revokeObjectURL(localUrl);
      
    } catch (error: any) {
      console.error("Download failed:", error);
      alert(`Download failed: ${error.message || "Unknown error"}`);
    }
  };

  const handleSubscribe = async () => {
    if (!user) {
      alert("Please login to subscribe.");
      return;
    }
    try {
      const res = await axiosInstance.post(`/subscriber/toggle/${video.videochanel}`, {
        userId: user._id,
      });
      setIsSubscribed(res.data.subscribed);
    } catch (error) {
      console.error("Error toggling subscription:", error);
    }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{video.videotitle}</h1>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Avatar className="w-10 h-10">
            <AvatarFallback>{video.videochanel[0]}</AvatarFallback>
          </Avatar>
          <div>
            <h3 className="font-medium">{video.videochanel}</h3>
            <p className="text-sm text-muted-foreground">1.2M subscribers</p>
          </div>
          <Button 
            className="ml-4" 
            variant={isSubscribed ? "secondary" : "default"}
            onClick={handleSubscribe}
          >
            {isSubscribed ? "Subscribed" : "Subscribe"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-secondary text-secondary-foreground rounded-full">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-l-full"
              onClick={handleLike}
            >
              <ThumbsUp
                className={`w-5 h-5 mr-2 ${
                  isLiked ? "fill-foreground text-foreground" : ""
                }`}
              />
              {likes.toLocaleString()}
            </Button>
            <div className="w-px h-6 bg-border" />
            <Button
              variant="ghost"
              size="sm"
              className="rounded-r-full"
              onClick={handleDislike}
            >
              <ThumbsDown
                className={`w-5 h-5 mr-2 ${
                  isDisliked ? "fill-foreground text-foreground" : ""
                }`}
              />
              {dislikes.toLocaleString()}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className={`bg-secondary text-secondary-foreground rounded-full ${
              isWatchLater ? "text-primary" : ""
            }`}
            onClick={handleWatchLater}
          >
            <Clock className="w-5 h-5 mr-2" />
            {isWatchLater ? "Saved" : "Watch Later"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="bg-secondary text-secondary-foreground rounded-full"
          >
            <Share className="w-5 h-5 mr-2" />
            Share
          </Button>
         <Button
  variant="ghost"
  size="sm"
  className="bg-secondary text-secondary-foreground rounded-full"
  onClick={handleDownload}
>
  <Download className="w-5 h-5 mr-2" />
  Download
</Button>
          <Button
            variant="ghost"
            size="icon"
            className="bg-secondary text-secondary-foreground rounded-full"
          >
            <MoreHorizontal className="w-5 h-5" />
          </Button>
        </div>
      </div>
      <div className="bg-secondary text-secondary-foreground rounded-lg p-4">
        <div className="flex gap-4 text-sm font-medium mb-2">
          <span>{video.views.toLocaleString()} views</span>
          <span>{formatDistanceToNow(new Date(video.createdAt))} ago</span>
        </div>
        <div className={`text-sm ${showFullDescription ? "" : "line-clamp-3"}`}>
          <p>
            Sample video description. This would contain the actual video
            description from the database.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 p-0 h-auto font-medium"
          onClick={() => setShowFullDescription(!showFullDescription)}
        >
          {showFullDescription ? "Show less" : "Show more"}
        </Button>
      </div>
    </div>
  );
};

export default VideoInfo;
