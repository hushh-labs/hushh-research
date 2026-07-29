"use client";

import { useEffect, useState } from "react";

export function useTabActivity() {
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const updateActivity = () => {
      const nextVisible = document.visibilityState === "visible";

      setVisible(nextVisible);
      setActive(nextVisible && document.hasFocus());
    };

    updateActivity();

    window.addEventListener("focus", updateActivity);
    window.addEventListener("blur", updateActivity);
    document.addEventListener("visibilitychange", updateActivity);

    return () => {
      window.removeEventListener("focus", updateActivity);
      window.removeEventListener("blur", updateActivity);
      document.removeEventListener("visibilitychange", updateActivity);
    };
  }, []);

  return {
    active,
    inactive: !active,
    visible,
    hidden: !visible,
  };
}