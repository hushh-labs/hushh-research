"use client";

import { useEffect, useState } from "react";

export function useVisibilityState() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const updateVisibility = () => {
      setVisible(document.visibilityState === "visible");
    };

    updateVisibility();

    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("focus", updateVisibility);
    window.addEventListener("blur", updateVisibility);

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", updateVisibility);
      window.removeEventListener("blur", updateVisibility);
    };
  }, []);

  return {
    visible,
    hidden: !visible,
  };
}