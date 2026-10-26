"use client";
import { useEffect, useRef, useState } from "react";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { AuthService } from "@/lib/services/auth-service";
import { useVault } from "@/lib/vault/vault-context";
import { DocumentHostingService } from "@/lib/services/document-hosting-service";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { connectorKeyFingerprint } from "@/lib/consent/export-envelope-v2";
import { DriveSharingError, DriveSharingService } from "@/lib/services/drive-sharing-service";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { IDENTITY_REQUIRED, fileRequestError } from "./file-request-errors";
import type { DriveRequestQuote } from "@/lib/services/drive-request-pricing-service";
import { validFileRequest, normalizeFileRequestTerms as normalize, fileRequestFingerprint as fingerprintOf, type FileRequestTerms } from "./file-request-contract";

/**
 * Sends one exact-file request. Hosted-only requests use the current One sign-in;
 * Drive delivery also proves the linked Google identity. Neither authorizes an
 * owner copy. An unchanged retry reuses its key so it is not recorded twice.
 */
export function useFileRequest({
  userId,
  personRef,
  getToken,
  initial,
  onQuoteChanged,
  identityMissing = false,
  onIdentityLinked,
  canRequest = true,
}: {
  userId: string;
  personRef: string;
  getToken: () => string | null;
  initial?: { terms: FileRequestTerms; clientRequestId: string };
  onQuoteChanged?: () => void;
  /** The preview found no linked Google account: sending links one first. */
  identityMissing?: boolean;
  /** A Google account was linked while sending; the preview reads it again. */
  onIdentityLinked?: () => void;
  canRequest?: boolean;
}) {
  const { getVaultKey } = useVault();
  const [phase, setPhase] = useState<"idle" | "verifying" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsGoogleAfterSend, setNeedsGoogle] = useState(false);
  const [linked, setLinked] = useState(false);
  const needsGoogle = needsGoogleAfterSend || (identityMissing && !linked);
  const alive = useRef(false);
  const eligibility = useRef(canRequest);
  eligibility.current = canRequest;
  const serial = useRef(0);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string; quoteVersion: number | null } | null>(
    initial
      ? {
          fingerprint: fingerprintOf(personRef, initial.terms),
          id: initial.clientRequestId,
          quoteVersion: null,
        }
      : null,
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // This is a monotonic operation fence, not a captured DOM reference.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++;
      inFlight.current = false;
    };
  }, []);
  const send = async (terms: FileRequestTerms, quote: DriveRequestQuote | null): Promise<string | null> => {
    const hosted = terms.receiveThrough === "one" || terms.receiveThrough === "both";
    if (!eligibility.current || inFlight.current || !validFileRequest(terms) || (!hosted && !quote) || !alive.current) return null;
    const quoteVersion = hosted ? null : quote!.version;
    const token = getToken();
    if (!token) return null;
    const epoch = snapshotVaultSessionEpoch();
    const operation = ++serial.current;
    const current = () =>
      alive.current &&
      serial.current === operation &&
      isVaultSessionEpochCurrent(epoch) &&
      getToken() === token;
    const guard = Object.assign(() => {
      if (!current()) throw new DriveSharingError("session_changed");
    }, { canDispatch: () => eligibility.current });
    const clean = normalize(terms);
    const fingerprint = fingerprintOf(personRef, clean);
    if (attempt.current?.fingerprint !== fingerprint ||
        (attempt.current.quoteVersion !== null && attempt.current.quoteVersion !== quoteVersion)) {
      attempt.current = { fingerprint, id: crypto.randomUUID(), quoteVersion };
    } else {
      attempt.current.quoteVersion = quoteVersion;
    }
    const clientRequestId = attempt.current.id;
    const linkGoogle = needsGoogle;
    inFlight.current = true;
    setError(null);
    setPhase("verifying");
    try {
      if (clean.receiveThrough && clean.receiveThrough !== "drive") {
        const vaultKey = getVaultKey();
        if (!vaultKey) return null;
        const connector = await OneKycClientZkService.ensureConnector({ userId, vaultKey, vaultOwnerToken: token });
        guard();
        const firebaseToken = clean.receiveThrough === "both" ? await (linkGoogle
          ? AuthService.linkGoogleIdentity(userId, current) : AuthService.documentRequestIdentityToken(userId, current))
          : await AuthService.getIdTokenWithRetry({ expectedUserId: userId, retries: 0 });
        guard();
        if (!firebaseToken) throw new Error("session_changed");
        if (!eligibility.current) throw new DriveSharingError("connection_required");
        setPhase("sending");
        const result = await DocumentHostingService.create({ userId, vaultKey, vaultOwnerToken: token, isCurrent: current }, {
          version: 1, ownerPersonRef: personRef, clientRequestId,
          purpose: { purpose: clean.purpose, periodStart: clean.periodStart, periodEnd: clean.periodEnd },
          accessDays: clean.accessDays ?? 30, ...(clean.reason ? { reason: clean.reason } : {}),
          ...(clean.requesterActorType === undefined ? {} : { requesterActorType: clean.requesterActorType }),
          receiveThrough: clean.receiveThrough, activityDisclosureVersion: clean.activityDisclosureVersion, activityAccepted: true,
          recipientKeyId: connector.connector_key_id, recipientKeyFingerprint: (await connectorKeyFingerprint(connector.connector_public_key)).replace(/^sha256:/, ""),
        }, undefined, firebaseToken);
        guard(); attempt.current = null;
        window.dispatchEvent(new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, { detail: { reconcile: true } }));
        return result.requestId;
      }
      const firebaseToken = await (linkGoogle
        ? AuthService.linkGoogleIdentity(userId, current)
        : AuthService.documentRequestIdentityToken(userId, current));
      guard();
      if (!eligibility.current) {
        setError("Your connection needs to be confirmed before sending. Your details are kept.");
        return null;
      }
      if (linkGoogle) {
        setNeedsGoogle(false);
        setLinked(true);
        onIdentityLinked?.();
      }
      setPhase("sending");
      const result = await DriveSharingService.create(
        token,
        firebaseToken,
        { ownerPersonRef: personRef, clientRequestId, expectedQuoteVersion: quote!.version,
          ...(clean.accessDays === undefined ? {} : { accessDays: clean.accessDays }),
          ...(clean.requesterActorType === undefined ? {} : { requesterActorType: clean.requesterActorType }),
          ...(clean.reason === undefined ? {} : { reason: clean.reason }),
          ...(clean.oneCopyRequested ? { oneCopyRequested: true, activityAccepted: true, activityDisclosureVersion: "one-document-activity-v1" as const } : {}),
          purpose: {
            purpose: clean.purpose, periodStart: clean.periodStart, periodEnd: clean.periodEnd,
          } },
        guard,
      );
      guard();
      setNeedsGoogle(false);
      attempt.current = null;
      CacheSyncService.onConsentMutated(userId);
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, {
          detail: { reconcile: true },
        }),
      );
      return result.requestId;
    } catch (cause) {
      if (!current()) return null;
      const code =
        cause instanceof DriveSharingError
          ? cause.code
          : cause instanceof Error
            ? cause.message
            : "request_failed";
      if (IDENTITY_REQUIRED.has(code)) setNeedsGoogle(true);
      setError(fileRequestError(code));
      if (code === "price_changed") onQuoteChanged?.();
      return null;
    } finally {
      if (serial.current === operation) {
        inFlight.current = false;
        if (alive.current) setPhase("idle");
      }
    }
  };
  /** Drops any in-flight result; the server may still have accepted the POST. */
  const reset = () => {
    serial.current++;
    inFlight.current = false;
    setPhase("idle");
    setError(null);
  };
  return { phase, error, needsGoogle, send, reset };
}
