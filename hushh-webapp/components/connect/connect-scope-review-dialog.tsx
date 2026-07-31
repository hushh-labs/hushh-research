"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/lib/morphy-ux/button";
import { humanizeConsentScope } from "@/lib/consent/consent-display";
import {
  ConnectionsService,
  type RequestableScope,
} from "@/lib/services/connections-service";

export interface ConnectScopeReviewDecision {
  /** Scopes the recipient chose to grant (checked). */
  grantedScopes: string[];
  /** Requested scopes the recipient chose not to grant (unchecked). */
  deniedScopes: string[];
}

export interface ConnectScopeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the person who sent the request (for the title). */
  personName: string;
  /** The scope keys the requester asked for. The recipient may grant any subset. */
  requestedScopes: string[];
  /** Firebase ID token loader (label catalog fetch is auth-gated). */
  getIdToken: () => Promise<string | undefined>;
  /** Called with the recipient's per-scope decision. The caller owns the accept
   * call + optimistic list update; this dialog only collects intent. */
  onConfirm: (decision: ConnectScopeReviewDecision) => Promise<void> | void;
  /** True while the caller's accept is in flight. */
  busy?: boolean;
}

/**
 * Recipient-side counterpart to {@link ConnectScopeRequestDialog}. When someone
 * receives a connection request that bundles a data ask (e.g. an RIA requesting
 * pick-related scopes), this lets them MODIFY the list — grant a subset instead
 * of the all-or-nothing Accept. Every scope starts checked, matching today's
 * "Accept = grant all" default; unchecking one records it as denied. Confirming
 * accepts the connection and mints a pending, zero-knowledge scope request only
 * for the checked scopes.
 */
export function ConnectScopeReviewDialog({
  open,
  onOpenChange,
  personName,
  requestedScopes,
  getIdToken,
  onConfirm,
  busy = false,
}: ConnectScopeReviewDialogProps) {
  const [catalog, setCatalog] = useState<Map<string, RequestableScope>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Selection starts with every requested scope checked (parity with the current
  // accept-all default); the recipient unchecks to narrow the grant.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Normalize + de-dupe the requested list once per set of props.
  const scopeKeys = useMemo(() => {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const raw of requestedScopes) {
      const key = String(raw || "").trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    return keys;
  }, [requestedScopes]);

  // Re-seed the selection whenever the dialog opens (or the request changes) so
  // each review starts from "share everything".
  useEffect(() => {
    if (open) setSelected(new Set(scopeKeys));
  }, [open, scopeKeys]);

  // Lazily fetch the global label catalog the first time the dialog opens; it is
  // presence-safe and reused across reopens within the same mount.
  useEffect(() => {
    if (!open || loaded || loading) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        const idToken = await getIdToken();
        if (!idToken) throw new Error("Not signed in");
        const result = await ConnectionsService.listRequestableScopes({ idToken });
        if (cancelled) return;
        setCatalog(new Map(result.scopes.map((s) => [s.scope, s])));
        setLoaded(true);
      } catch {
        // Non-fatal: fall back to humanized scope keys so review still works.
        if (!cancelled) setLoaded(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded, loading, getIdToken]);

  const toggleScope = useCallback((scope: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }, []);

  const grantedCount = selected.size;
  const total = scopeKeys.length;

  const handleConfirm = useCallback(async () => {
    const grantedScopes = scopeKeys.filter((s) => selected.has(s));
    const deniedScopes = scopeKeys.filter((s) => !selected.has(s));
    await onConfirm({ grantedScopes, deniedScopes });
  }, [onConfirm, scopeKeys, selected]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle>Choose what to share with {personName}</DialogTitle>
          <DialogDescription>
            They asked to see the data below. Pick only what you want to share —
            each grant is end-to-end encrypted to their device, and you can
            change your mind anytime.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[52vh] px-5">
          <div className="space-y-1 pb-2">
            {loading && !loaded ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading request…
              </div>
            ) : scopeKeys.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No specific data was requested.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {scopeKeys.map((key) => {
                  const meta = catalog.get(key);
                  const label = meta?.label || humanizeConsentScope(key);
                  const checked = selected.has(key);
                  return (
                    <li key={key}>
                      <label className="flex cursor-pointer items-start gap-3 py-2.5">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleScope(key)}
                          className="mt-0.5"
                          aria-label={label}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {label}
                            </span>
                            {meta?.sensitivity === "high" && (
                              <Badge
                                variant="outline"
                                className="shrink-0 gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
                              >
                                <ShieldCheck className="h-3 w-3" />
                                Sensitive
                              </Badge>
                            )}
                          </span>
                          {meta?.description && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {meta.description}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-row items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {total === 0
              ? "Connect only"
              : grantedCount === 0
                ? "Sharing nothing"
                : `Sharing ${grantedCount} of ${total}`}
          </span>
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="sm"
            disabled={busy}
            onClick={() => void handleConfirm()}
          >
            {busy ? "Accepting…" : "Accept"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
