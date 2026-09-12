import Header from "@/components/Header";
import Sidebar from "@/components/Sidebar";
import { Toaster } from "@/components/ui/sonner";
import "../styles/globals.css";
import type { AppProps } from "next/app";
import { UserProvider } from "../lib/AuthContext";
import LoginOTP from "@/components/LoginOTP";
import { useEffect } from "react";

import ThemeController from "@/components/ThemeController";

export default function App({ Component, pageProps }: AppProps) {

  return (
    <UserProvider>
      <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
        <ThemeController />
        <title>Your-Tube Clone</title>
        <Header />
        <Toaster />
        <div className="flex">
          <Sidebar />
          <Component {...pageProps} />
        </div>
        <LoginOTP />
      </div>
    </UserProvider>
  );
}
