"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { nativeFeedbackToast as toast } from "@/lib/capacitor/native-feedback";
import { ROUTES } from "@/lib/navigation/routes";

export function KaiMockSonnerNotice() {
  const router = useRouter();

  useEffect(() => {
    toast.info("Kai home is an exploratory mock surface.", {
      id: "kai-mock-home-notice",
      
      action: {
        label: "Go to Portfolio",
        onClick: () => router.push(ROUTES.KAI_PORTFOLIO),
      },
      duration: 7000,
    });
  }, [router]);

  return null;
}
