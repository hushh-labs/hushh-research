"use client";

/**
 * Public Wallet Profile page — `/c/[token]`.
 *
 * A stranger scans the QR on someone's Hussh One Wallet pass and lands here
 * with no session, no app, and no prior relationship. The route is
 * unauthenticated by design and resolves a share token to the owner-selected
 * projection; the token itself is never logged or echoed into the UI.
 *
 * Structure mirrors the repo's proven public route,
 * `app/one/location/request/[token]` — thin server page, all state in a client
 * component, one service call, explicit terminal states.
 *
 * This page emits no analytics.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  normalizePublicWalletCard,
  PublicWalletCardSkeleton,
  PublicWalletCardView,
  type PublicWalletCard,
} from "@/components/wallet-card/public-card-view";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { WalletCardService } from "@/lib/services/wallet-card-service";

/**
 * `secrets.token_urlsafe(32)` produces 43 URL-safe characters. Rejecting
 * anything outside that alphabet locally keeps obviously-malformed links off
 * the rate-limited public endpoint.
 */
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

type CardStatus =
  | "loading"
  | "ready"
  | "revoked"
  | "expired"
  | "not-found"
  | "error";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Read the honest status the public endpoint returns on 410, tolerating both
 * a bare `{"status":"revoked"}` body and FastAPI's `{"detail": {...}}` wrapper.
 */
function readPayloadStatus(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const direct = record.status;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toLowerCase();
  }
  return readPayloadStatus(record.detail);
}

/**
 * Map a failed resolve onto a terminal page state.
 *
 * Unknown and paused cards both arrive as a generic 404 — the page must not
 * be able to tell them apart, so both render the same generic message.
 */
/**
 * Terminal resolve states mapped onto page states.
 *
 * "not_found" covers both an unknown token and a paused card — the page must
 * not be able to tell them apart.
 */
const TERMINAL_STATUS_BY_STATE: Record<string, CardStatus> = {
  revoked: "revoked",
  expired: "expired",
  not_found: "not-found",
  unavailable: "error",
};

function resolveFailureStatus(error: unknown): CardStatus {
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 404) return "not-found";
  if (error.status === 410) {
    const declared =
      readPayloadStatus(error.payload) ??
      apiErrorCode(error)?.toLowerCase() ??
      null;
    return declared === "expired" ? "expired" : "revoked";
  }
  if (error.status === 400 || error.status === 422) return "not-found";
  return "error";
}

function CardMessage({
  title,
  body,
  onRetry,
}: {
  title: string;
  body?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="space-y-4 rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-5 text-center shadow-[var(--shadow-xs)] sm:p-7">
      <div
        className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]"
        aria-hidden="true"
      >
        <AlertTriangle className="size-5" />
      </div>
      <h1 className="text-[22px] font-medium leading-[1.2] tracking-tight sm:text-[24px]">
        {title}
      </h1>
      {body ? (
        <p className="text-sm leading-6 text-muted-foreground">{body}</p>
      ) : null}
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          onClick={onRetry}
          className="h-11 px-5"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export default function PublicWalletCardPageClient() {
  const params = useParams<{ token?: string }>();
  const shareToken = useMemo(
    () => String(params?.token || "").trim(),
    [params?.token],
  );
  const [status, setStatus] = useState<CardStatus>("loading");
  const [card, setCard] = useState<PublicWalletCard | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const loadCard = async () => {
      if (!SHARE_TOKEN_SHAPE.test(shareToken)) {
        setCard(null);
        setStatus("not-found");
        return;
      }
      setStatus("loading");
      try {
        const response = await WalletCardService.resolvePublicCard(shareToken);
        if (cancelled) return;

        // The service resolves terminal states rather than throwing, so branch
        // on the typed state. Unknown and paused both arrive as "not_found" and
        // must stay indistinguishable (contract §6); revoked and expired get
        // their own honest copy (contract §9).
        if (response.state !== "available") {
          setCard(null);
          setStatus(TERMINAL_STATUS_BY_STATE[response.state] ?? "error");
          return;
        }

        const normalized = normalizePublicWalletCard(response);
        if (!normalized) {
          setCard(null);
          setStatus("not-found");
          return;
        }
        setCard(normalized);
        setStatus("ready");
      } catch (loadError) {
        if (cancelled) return;
        setCard(null);
        setStatus(resolveFailureStatus(loadError));
      }
    };

    void loadCard();

    return () => {
      cancelled = true;
    };
  }, [shareToken, reloadKey]);

  const retry = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center px-4 py-8 sm:max-w-lg sm:px-6 sm:py-12">
        {status === "loading" ? <PublicWalletCardSkeleton /> : null}

        {status === "ready" && card ? <PublicWalletCardView card={card} /> : null}

        {status === "revoked" ? (
          <CardMessage title="This profile is no longer shared." />
        ) : null}

        {status === "expired" ? (
          <CardMessage title="This profile link has expired." />
        ) : null}

        {status === "not-found" ? (
          <CardMessage
            title="This profile isn't available."
            body="Check the link, or ask for a new one."
          />
        ) : null}

        {status === "error" ? (
          <CardMessage
            title="We couldn't load this profile."
            body="Check your connection and try again."
            onRetry={retry}
          />
        ) : null}
      </div>
    </main>
  );
}
