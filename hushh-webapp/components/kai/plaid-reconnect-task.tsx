"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { loadFinancialForVault, relinkVaultPlaid, vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";

export function PlaidReconnectTask({ itemId }: { itemId: string }) {
  const { capture, ready, session } = useFinanceShareContext();
  const [result, setResult] = useState<{
    session: string;
    name: string | null;
    state: "action" | "active" | "unavailable";
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!ready) return;
    const context = capture();
    if (!context?.isCurrent()) return;
    let mounted = true;
    void loadFinancialForVault(context).then(financial => {
      if (!mounted || !context.isCurrent()) return;
      const connection = Object.hasOwn(vaultConnections(financial), itemId)
        ? vaultConnections(financial)[itemId] : undefined;
      setResult({
        session,
        name: connection?.institution_name || null,
        state: connection?.status === "active" ? "active"
          : connection?.status === "needs_relink" && connection.reconnect_required_at ? "action" : "unavailable",
      });
    }).catch(() => {
      if (mounted && context.isCurrent()) setResult({ session, name: null, state: "unavailable" });
    });
    return () => { mounted = false; };
  }, [capture, itemId, ready, session]);

  const current = result?.session === session && ready ? result : null;
  async function reconnect() {
    if (working || current?.state !== "action") return;
    const context = capture();
    if (!context?.isCurrent()) return;
    setWorking(true);
    setNotice("");
    try {
      const response = await relinkVaultPlaid({ ...context, itemId });
      if (!context.isCurrent()) return;
      if (response.status === "repaired") {
        setResult({ ...current, state: "active" });
      } else if (response.status === "blocked") setNotice(response.reason);
    } catch {
      if (context.isCurrent()) setNotice("Your connection could not be checked. Try again.");
    } finally {
      setWorking(false);
    }
  }

  return <article className="mx-auto max-w-lg space-y-3 p-6">
    <h1 className="text-xl font-semibold">{current?.state === "action" ? `Reconnect ${current.name || "your institution"}` : current?.name || "Institution connection"}</h1>
    {!ready ? <p>Unlock your vault to check this connection.</p>
      : !current ? <p role="status">Checking your connection…</p>
      : current.state === "active" ? <p role="status">This connection is active.</p>
      : current.state === "unavailable" ? <p role="status">This reconnection is no longer available.</p>
      : <Button onClick={() => void reconnect()} disabled={working}>{working ? "Checking…" : "Reconnect"}</Button>}
    {notice && ready ? <p role="status">{notice}</p> : null}
  </article>;
}
