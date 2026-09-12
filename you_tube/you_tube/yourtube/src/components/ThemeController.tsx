import React, { useEffect } from "react";
import { useUser } from "@/lib/AuthContext";

export default function ThemeController() {
  const { user } = useUser();

  useEffect(() => {
    const applyTheme = () => {
      // 1. If user has manually selected a theme
      if (user?.theme === "light") {
        document.documentElement.classList.remove("dark");
        return;
      }
      
      if (user?.theme === "dark") {
        document.documentElement.classList.add("dark");
        return;
      }

      // 2. Otherwise (Auto mode), use IST time
      const now = new Date();
      const istOptions = { timeZone: "Asia/Kolkata", hour: 'numeric', hour12: false } as const;
      const istHour = parseInt(new Intl.DateTimeFormat('en-US', istOptions).format(now), 10);
      
      if (istHour >= 5 && istHour < 12) {
        document.documentElement.classList.remove("dark");
      } else {
        document.documentElement.classList.add("dark");
      }
    };

    applyTheme();
    
    const interval = setInterval(applyTheme, 60000);
    return () => clearInterval(interval);
  }, [user?.theme]);

  return null;
}
