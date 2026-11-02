import { useEffect, useState } from "react";

import { morphyToast } from "@/lib/morphy-ux/morphy";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

type Owner = { getIdToken: () => Promise<string> };

/**
 * First-time Calendar setup ends with one Mail step, so sending a reviewed
 * decline or reschedule note never needs another Google prompt later.
 */
export function useCalendarMailStep({ identity, user, userId, connected, connectMail }: {
  identity: symbol;
  user: Owner | null | undefined;
  userId: string | null | undefined;
  connected: boolean;
  connectMail: (options?: { onboarding?: boolean }) => Promise<void>;
}) {
  const [step, setStep] = useState<"idle" | "offer" | "done">("idle");
  useEffect(() => { setStep("idle"); }, [identity]);
  const showMailStep = step === "offer" && connected;

  const mailAllowed = async (owner: Owner, id: string) => {
    const status = await GmailReceiptsService.getStatus({ idToken: await owner.getIdToken(), userId: id, force: true });
    return status.connected === true && status.send_permission_granted === true;
  };

  // Already allowed (for example from Mail): skip the step instead of asking twice.
  useEffect(() => {
    if (!showMailStep || !user || !userId) return;
    let live = true;
    void mailAllowed(user, userId).then(allowed => { if (live && allowed) setStep("done"); }).catch(() => undefined);
    return () => { live = false; };
  }, [showMailStep, user, userId]);

  const allowMailStep = async () => {
    await connectMail({ onboarding: true }).catch(error => {
      morphyToast.error(error instanceof Error ? error.message : "Mail access could not be allowed.");
    });
    if (!user || !userId) return;
    // The step stays when this fails, so the person can retry or skip.
    if (await mailAllowed(user, userId).catch(() => false)) setStep("done");
  };

  return { showMailStep, offerMailStep: () => setStep("offer"), skipMailStep: () => setStep("done"), allowMailStep };
}
