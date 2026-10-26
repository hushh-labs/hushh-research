"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

/** Permission prompts belong to this explicit action, never task creation or mount. */
export function TodoNotificationControl() {
  const { user } = useAuth();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  const currentOwner = useRef(user?.uid);
  currentOwner.current = user?.uid;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const enable = async () => {
    if (!user || pending.current) return;
    const epoch = snapshotVaultSessionEpoch();
    const ownerId = user.uid;
    const isCurrent = () => active.current && currentOwner.current === ownerId && isVaultSessionEpochCurrent(epoch);
    pending.current = true;
    setBusy(true);
    try {
      const { initializeFCM } = await import("@/lib/notifications/fcm-service");
      const token = await user.getIdToken();
      if (!isCurrent()) return;
      const result = await initializeFCM(ownerId, token, { requestPermission: true, getIdToken: () => user.getIdToken() });
      if (!isCurrent()) return;
      setStatus(result.status === "push_active" ? "Notifications are enabled on this device."
        : result.status === "push_blocked" ? "Notifications are blocked. Enable them in device or browser settings."
        : result.status === "unsupported" ? "This device cannot receive push notifications."
        : "Notifications could not be enabled. Try again.");
    } catch { if (isCurrent()) setStatus("Notifications could not be enabled. Try again."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return <div><Button type="button" variant="none" effect="fade" size="compact" disabled={busy} onClick={() => void enable()}>Enable reminder notifications</Button>
    {status ? <HelperText as="p" role="status">{status}</HelperText> : null}</div>;
}
