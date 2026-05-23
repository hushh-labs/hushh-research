"use client";

import { useEffect, useState } from "react";

export function useNetworkStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const updateStatus = () => {
      setOnline(window.navigator.onLine);
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