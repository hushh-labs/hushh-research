"use client"; // Note: This requires making it a client component

import { useState, useEffect } from "react";
import { HushhLoader } from "@/components/app-ui/hushh-loader";

export default function Loading() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Wait 250ms before showing the loader
    const timeout = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(timeout);
  }, []);

  if (!show) return null;

  return <HushhLoader variant="fullscreen" label="Loading..." />;
}