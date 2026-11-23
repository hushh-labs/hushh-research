"use client";

import { isNetworkOnline } from "@/lib/runtime/network-status";
import { useEffect, useState } from "react";

export function useNetworkStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const updateStatus = () => {
      setOnline(isNetworkOnline());
    };

    updateStatus();

    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);

    return () => {
      window.removeEventListener("online", updateStatus);
      window.removeEventListener("offline", updateStatus);
    };
  }, []);

  return {
    online,
    offline: !online,
  };
}