"use client";
import { useCallback, useEffect, useState } from "react";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { AuthService } from "@/lib/services/auth-service";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";
import { DriveRequestRequesterService } from "@/lib/services/drive-request-requester-service";
import { IDENTITY_REQUIRED } from "./file-request-errors";
import { HelperText } from "@/components/app-ui/typography";

export type RecipientIdentityPreview = {
  state: "idle" | "loading" | "ready" | "missing" | "unavailable";
  email: string | null;
  refresh: () => void;
};

/**
 * The Google account a new request's files would go to, checked by the server
 * the way sending checks it, never from client providerData. A failed check
 * only hides the line: sending verifies the account again.
 */
export function useRecipientIdentityPreview({
  active,
  userId,
  getToken,
}: {
  active: boolean;
  userId: string;
  getToken: () => string | null;
}): RecipientIdentityPreview {
  const [result, setResult] = useState<Omit<RecipientIdentityPreview, "refresh">>({
    state: "idle",
    email: null,
  });
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((current) => current + 1), []);

  useEffect(() => {
    const token = active ? getToken() : null;
    if (!token) {
      setResult({ state: "idle", email: null });
      return;
    }
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    const current = () =>
      !cancelled && isVaultSessionEpochCurrent(epoch) && getToken() === token;
    const guard = () => {
      if (!current()) throw new DriveSharingError("session_changed");
    };
    setResult((previous) => ({ state: "loading", email: previous.email }));
    void Promise.resolve()
      .then(() => AuthService.documentRequestIdentityToken(userId, current))
      .then((firebaseToken) => {
        guard();
        return DriveRequestRequesterService.recipientIdentity(token, firebaseToken, guard);
      })
      .then((identity) => {
        if (current()) setResult({ state: "ready", email: identity.email });
      })
      .catch((cause) => {
        if (!current()) return;
        const code =
          cause instanceof DriveSharingError
            ? cause.code
            : cause instanceof Error
              ? cause.message
              : "";
        setResult({ state: IDENTITY_REQUIRED.has(code) ? "missing" : "unavailable", email: null });
      });
    return () => {
      cancelled = true;
    };
  }, [active, userId, getToken, reload]);

  return { ...result, refresh };
}

/** "Files will be shared with a@gmail.com", or what to add before sending. */
export function RecipientIdentityNotice({ preview }: { preview: RecipientIdentityPreview }) {
  if (preview.state === "ready" && preview.email)
    return (
      <HelperText className="[overflow-wrap:anywhere]">
        Files will be shared with {preview.email}
      </HelperText>
    );
  if (preview.state === "missing")
    return <HelperText role="status">Add a Google account to receive the files.</HelperText>;
  return null;
}
