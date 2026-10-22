"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ProfilePaneCardIcon } from "@/components/profile/profile-pane-icons";
import { SettingsRow } from "@/components/profile/settings-ui";
import { isWalletSecurityCode } from "@/lib/wallet/card-security-code";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

type CodeView = { kind: "hidden" | "reading" | "missing" | "error" } | { kind: "visible"; value: string };

/** Mount only in owner Wallet details. Never copy the code into shared readers. */
export function WalletSecurityCode({ onRead, active }: { onRead: () => Promise<string | undefined>; active: boolean }) {
  const [view, setView] = useState<CodeView>({ kind: "hidden" });
  const revision = useRef(0);
  const hide = useCallback(() => { revision.current++; setView({ kind: "hidden" }); }, []);
  useEffect(() => subscribeVaultSessionEpoch(hide), [hide]);
  useLayoutEffect(() => { if (!active) { revision.current++; setView({ kind: "hidden" }); } }, [active]);
  useEffect(() => {
    const lifecycle = revision;
    const hidden = () => { if (document.visibilityState === "hidden") hide(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { lifecycle.current++; document.removeEventListener("visibilitychange", hidden); };
  }, [hide]);
  useEffect(() => {
    if (view.kind !== "visible") return;
    const timer = window.setTimeout(hide, 45_000);
    return () => window.clearTimeout(timer);
  }, [view.kind, hide]);
  const visible = active && view.kind === "visible";
  const toggle = async () => {
    if (!active || document.visibilityState === "hidden" || view.kind === "reading") return;
    if (visible) { hide(); return; }
    const operation = ++revision.current; setView({ kind: "reading" });
    try {
      const value = await onRead();
      if (operation === revision.current) setView(isWalletSecurityCode(value) ? { kind: "visible", value } : { kind: "missing" });
    } catch { if (operation === revision.current) setView({ kind: "error" }); }
  };
  return <SettingsRow icon={ProfilePaneCardIcon} iconTone="transparent" density="compact" title="CVV"
    description={active && view.kind === "error" ? "Could not show CVV. Try again." : undefined}
    trailing={<span className="flex min-w-0 items-center justify-end gap-2">
      <span className="font-mono tabular-nums" data-testid="wallet-owner-cvv">{visible && view.kind === "visible" ? view.value : active && view.kind === "missing" ? "Not saved" : "•••"}</span>
      <button type="button" className="min-h-11 min-w-11 rounded-full px-2 text-[color:var(--app-accent)] focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
        disabled={!active || view.kind === "reading"} onClick={() => void toggle()} aria-label={visible ? "Hide CVV" : "Show CVV"}>
        {visible ? "Hide" : view.kind === "reading" ? "Reading…" : "Show"}
      </button>
    </span>} />;
}
