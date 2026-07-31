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
import {
  ConnectionsService,
  type RequestableScope,
  type RequestableScopeBundle,
} from "@/lib/services/connections-service";

export interface ConnectScopeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the person being connected with (for the title). */
  personName: string;
  /** Firebase ID token loader (catalog fetch is auth-gated). */
  getIdToken: () => Promise<string | undefined>;
  /** Called with the chosen scopes (possibly empty = plain connect). The caller
   * owns key generation + the actual send; this dialog only collects intent. */
  onConfirm: (scopes: string[]) => Promise<void> | void;
  /** True while the caller's send is in flight. */
  busy?: boolean;
}

/**
 * Bottom-anchored picker shown when a user taps "Connect". It lets the requester
 * bundle a granular data-scope ask with the connection request. Selecting scopes
 * is entirely optional — sending with none is a plain connect. Each scope the
 * addressee later grants flows through the zero-knowledge export pipeline, so the
 * catalog here is global and presence-safe (it never reveals what the other
 * person actually holds).
 */
export function ConnectScopeRequestDialog({
  open,
  onOpenChange,
  personName,
  getIdToken,
  onConfirm,
  busy = false,
}: ConnectScopeRequestDialogProps) {
  const [bundles, setBundles] = useState<RequestableScopeBundle[]>([]);
  const [scopes, setScopes] = useState<RequestableScope[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Lazy-load the catalog the first time the dialog opens; keep it cached across
  // reopens within the same mount.
  useEffect(() => {
    if (!open || loaded || loading) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const idToken = await getIdToken();
        if (!idToken) throw new Error("Not signed in");
        const catalog = await ConnectionsService.listRequestableScopes({ idToken });
        if (cancelled) return;
        setBundles(catalog.bundles);
        setScopes(catalog.scopes);
        setLoaded(true);
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Couldn't load data options",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded, loading, getIdToken]);

  // Reset the selection whenever the dialog is dismissed so the next person
  // starts clean.
  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  const scopeByKey = useMemo(
    () => new Map(scopes.map((s) => [s.scope, s])),
    [scopes],
  );

  const toggleScope = useCallback((scope: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }, []);

  const bundleState = useCallback(
    (bundle: RequestableScopeBundle): "all" | "some" | "none" => {
      const inCatalog = bundle.scopes.filter((s) => scopeByKey.has(s));
      if (inCatalog.length === 0) return "none";
      const chosen = inCatalog.filter((s) => selected.has(s)).length;
      if (chosen === 0) return "none";
      if (chosen === inCatalog.length) return "all";
      return "some";
    },
    [scopeByKey, selected],
  );

  const toggleBundle = useCallback(
    (bundle: RequestableScopeBundle) => {
      const inCatalog = bundle.scopes.filter((s) => scopeByKey.has(s));
      setSelected((prev) => {
        const next = new Set(prev);
        const allOn = inCatalog.every((s) => next.has(s));
        for (const s of inCatalog) {
          if (allOn) next.delete(s);
          else next.add(s);
        }
        return next;
      });
    },
    [scopeByKey],
  );

  const count = selected.size;

  const handleConfirm = useCallback(async () => {
    await onConfirm(Array.from(selected));
  }, [onConfirm, selected]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 pt-5 pb-3 text-left">
          <DialogTitle>Connect with {personName}</DialogTitle>
          <DialogDescription>
            Optionally ask to see some of their data. They choose what to share —
            each grant is end-to-end encrypted to your device.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[52vh] px-5">
          <div className="space-y-4 pb-2">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading data options…
              </div>
            ) : loadError ? (
              <p className="py-6 text-sm text-muted-foreground">
                {loadError}. You can still connect without requesting data.
              </p>
            ) : (
              <>
                {bundles.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Quick bundles
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {bundles.map((bundle) => {
                        const state = bundleState(bundle);
                        return (
                          <button
                            key={bundle.id}
                            type="button"
                            onClick={() => toggleBundle(bundle)}
                            aria-pressed={state !== "none"}
                            className={[
                              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                              state === "all"
                                ? "border-primary bg-primary text-primary-foreground"
                                : state === "some"
                                  ? "border-primary/60 bg-primary/10 text-foreground"
                                  : "border-input bg-background text-muted-foreground hover:text-foreground",
                            ].join(" ")}
                          >
                            {bundle.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {scopes.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Individual data
                    </p>
                    <ul className="divide-y divide-border/60">
                      {scopes.map((scope) => {
                        const checked = selected.has(scope.scope);
                        return (
                          <li key={scope.scope}>
                            <label className="flex cursor-pointer items-start gap-3 py-2.5">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleScope(scope.scope)}
                                className="mt-0.5"
                                aria-label={scope.label || scope.scope}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {scope.label || scope.scope}
                                  </span>
                                  {scope.sensitivity === "high" && (
                                    <Badge
                                      variant="outline"
                                      className="shrink-0 gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
                                    >
                                      <ShieldCheck className="h-3 w-3" />
                                      Sensitive
                                    </Badge>
                                  )}
                                </span>
                                {scope.description && (
                                  <span className="mt-0.5 block text-xs text-muted-foreground">
                                    {scope.description}
                                  </span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-row items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {count === 0
              ? "No data requested"
              : `${count} scope${count === 1 ? "" : "s"} requested`}
          </span>
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="sm"
            disabled={busy}
            onClick={() => void handleConfirm()}
          >
            {busy
              ? "Sending…"
              : count === 0
                ? "Connect"
                : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
