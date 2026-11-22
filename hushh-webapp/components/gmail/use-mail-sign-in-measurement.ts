import { useEffect, useRef } from "react";

import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { trackEvent } from "@/lib/observability/client";

export function useMailSignInMeasurement(userId: string | null, promptVisible: boolean) {
  const measuredOwner = useRef<string | null>(null);

  useEffect(() => {
    if (measuredOwner.current !== userId) measuredOwner.current = null;
    if (!promptVisible || !userId || measuredOwner.current === userId) return;
    if (snapshotValidatedAuthSessionOwner()?.userId !== userId) return;

    measuredOwner.current = userId;
    trackEvent("hushh_mail_signin_screen_view", { result: "success" });
  }, [promptVisible, userId]);
}
