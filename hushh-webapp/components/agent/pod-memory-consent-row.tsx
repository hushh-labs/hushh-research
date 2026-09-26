"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "@/components/icons";

import { ApiService } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

type ConsentWord = "absent" | "granted" | "revoked";

/**
 * The one control that lets the owner allow their pod's provider Memory Bank to
 * process anything.
 *
 * The pod already keeps every remembered fact in its own sealed log regardless.
 * This decides only whether the PROVIDER (Vertex Memory Bank, in the owner's own
 * project) may also be asked to consolidate and recall. Without a recorded grant
 * the pod answers every provider write `skipped_no_consent`, which is correct and
 * was also, until this row existed, unreachable: nothing in the app could grant it.
 *
 * Reads the pod's own word for the current state rather than remembering one
 * locally, so the row can never claim a consent the pod has not recorded.
 */
export function PodMemoryConsentRow({
  hushhId,
  className,
}: {
  hushhId: string | null | undefined;
  className?: string;
}) {
  const [consent, setConsent] = useState<ConsentWord | null>(null);
  const [bank, setBank] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!hushhId) return;
    const status = await ApiService.getPodMemoryStatus(hushhId).catch(
      () => null,
    );
    const word = status?.provider?.consent;
    setConsent(
      word === "granted" || word === "revoked" || word === "absent"
        ? word
        : null,
    );
    setBank(
      typeof status?.provider?.bank === "boolean" ? status.provider.bank : null,
    );
  }, [hushhId]);

  useEffect(() => {
    let cancelled = false;
    if (!hushhId) {
      setConsent(null);
      setBank(null);
      return () => {
        cancelled = true;
      };
    }
    void refresh().catch(() => {
      if (!cancelled) setConsent(null);
    });
    return () => {
      cancelled = true;
    };
  }, [hushhId, refresh]);

  async function decide(granted: boolean) {
    if (!hushhId || busy) return;
    setBusy(true);
    setError("");
    try {
      await ApiService.setPodMemoryProviderConsent(hushhId, granted);
      // The pod's word, not ours: re-read rather than assume the write landed.
      await refresh();
    } catch {
      setError("Your pod did not record that change. Nothing was altered.");
    } finally {
      setBusy(false);
    }
  }

  if (!hushhId) return null;

  const granted = consent === "granted";
  const label =
    consent === null
      ? "Provider memory: checking"
      : granted
        ? "Provider memory: on"
        : "Provider memory: off";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs",
        className,
      )}
      data-testid="pod-memory-consent"
      data-consent={consent ?? "unknown"}
    >
      <span className="font-medium">{label}</span>
      {bank === false ? (
        <span className="text-muted-foreground">
          no provider bank on this pod
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void decide(!granted)}
        disabled={busy || consent === null || bank === false}
        aria-pressed={granted}
        className="ml-auto rounded-lg border border-border px-2.5 py-1 text-xs disabled:opacity-50"
        data-testid="pod-memory-consent-toggle"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : granted ? (
          "Turn off"
        ) : (
          "Allow"
        )}
      </button>
      {error ? (
        <p
          className="basis-full text-destructive"
          data-testid="pod-memory-consent-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
