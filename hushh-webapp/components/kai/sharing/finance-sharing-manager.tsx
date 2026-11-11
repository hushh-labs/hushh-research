"use client";

import { FinanceGrantDetails } from "./finance-grant-details";
import { PersonProfileButton } from "@/components/connections/person-profile-button";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname } from "next/navigation";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import type {
  FinanceGrant,
  FinanceSource,
} from "@/lib/finance-sharing/contract";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import {
  FinanceShareFlow,
  type FinanceShareUpdate,
} from "./finance-share-flow";
import { FinanceSharingService } from "@/lib/services/finance-sharing-service";
import {
  financePublicationRevision,
  subscribeFinancePublication,
} from "@/lib/finance-sharing/publication-state";
import { FinanceSharedDetail } from "./finance-shared-detail";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";

const directionTabs: { value: "outgoing" | "received"; label: string }[] = [
  { value: "outgoing", label: "Shared by you" },
  { value: "received", label: "Shared with you" },
];

export function FinanceSharingManager({
  open,
  onOpenChange,
  hasPortfolio = true,
  preferredSource,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPortfolio?: boolean;
  preferredSource?: FinanceSource;
}) {
  const { capture, session, ready } = useFinanceShareContext();
  const [items, setItems] = useState<FinanceGrant[]>([]);
  const [chosenDirection, setDirection] = useState<"outgoing" | "received">(
    hasPortfolio ? "outgoing" : "received",
  );
  const [existingOutgoing, setExistingOutgoing] = useState<{
    session: string;
    available: boolean;
  } | null>(null);
  const canManageOutgoing =
    hasPortfolio ||
    (existingOutgoing?.session === session && existingOutgoing.available);
  const direction = canManageOutgoing ? chosenDirection : "received";
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [stopping, setStopping] = useState<FinanceGrant | null>(null);
  const [updateData, setUpdateData] = useState<{
    session: string;
    model: DashboardViewModel;
    initialShare: FinanceShareUpdate;
  } | null>(null);
  const visit = useMemo(
    () => ({ open, direction, session }),
    [open, direction, session],
  );
  const currentVisit = useRef(visit);
  currentVisit.current = visit;
  useSyncExternalStore(
    subscribeFinancePublication,
    financePublicationRevision,
    () => 0,
  );
  const owner = capture()?.userId;
  const pathname = usePathname();
  useBackLayer(pathname, open ? 1 : 0, () => {
    onOpenChange(false);
    return true;
  });
  useEffect(() => {
    setDirection(hasPortfolio ? "outgoing" : "received");
  }, [hasPortfolio, session]);
  useEffect(() => {
    if (!open || hasPortfolio || !ready) return;
    const context = capture();
    if (!context) return;
    let disposed = false;
    // Source removal keeps the last approved view. Preserve its revocation route.
    void FinanceSharingService.history(context, "outgoing")
      .then((result) => {
        if (!disposed && context.isCurrent())
          setExistingOutgoing({ session, available: result.items.length > 0 });
      })
      .catch(() => {
        // An unread history must not hide potentially active outgoing access.
        if (!disposed && context.isCurrent())
          setExistingOutgoing({ session, available: true });
      });
    return () => {
      disposed = true;
    };
  }, [capture, open, hasPortfolio, ready, session, reload]);
  useEffect(() => {
    setItems([]);
    setUpdateData(null);
    setSelected(null);
    setStopping(null);
    setCursor(null);
    setError(null);
  }, [open, session, direction]);
  useEffect(() => {
    if (!open) return;
    const resume = () => {
      if (!document.hidden) setReload((n) => n + 1);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("finance-sharing-changed", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("finance-sharing-changed", resume);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !ready) return;
    const context = capture();
    if (!context) return;
    let disposed = false;
    setBusy(true);
    void FinanceSharingService.history(context, direction)
      .then((result) => {
        if (!disposed && context.isCurrent()) {
          setItems(result.items);
          setCursor(result.nextCursor);
          setError(null);
        }
      })
      .catch((e) => {
        if (!disposed && context.isCurrent())
          setError(
            e instanceof Error ? e.message : "Sharing history is unavailable.",
          );
      })
      .finally(() => {
        if (!disposed && context.isCurrent()) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [capture, open, direction, ready, session, reload]);
  const loadMore = async () => {
    const context = capture();
    if (!context || !cursor) return;
    const started = currentVisit.current;
    setBusy(true);
    try {
      const result = await FinanceSharingService.history(
        context,
        direction,
        cursor,
      );
      if (context.isCurrent() && currentVisit.current === started) {
        setItems((p) => [
          ...p,
          ...result.items.filter(
            (item) => !p.some((existing) => existing.id === item.id),
          ),
        ]);
        setCursor(result.nextCursor);
      }
    } catch (e) {
      if (context.isCurrent() && currentVisit.current === started)
        setError(
          e instanceof Error ? e.message : "Sharing history is unavailable.",
        );
    } finally {
      if (context.isCurrent() && currentVisit.current === started)
        setBusy(false);
    }
  };
  const stop = async () => {
    const context = capture();
    if (!context || !stopping) return;
    setBusy(true);
    setError(null);
    try {
      await FinanceSharingService.stop(context, stopping.id);
      if (!context.isCurrent()) return;
      setStopping(null);
      setReload((n) => n + 1);
      window.dispatchEvent(new Event("finance-sharing-changed"));
    } catch (e) {
      if (context.isCurrent())
        setError(
          e instanceof Error
            ? e.message
            : "Stopping access could not be confirmed.",
        );
    } finally {
      if (context.isCurrent()) setBusy(false);
    }
  };
  const updateAccess = async (item: FinanceGrant) => {
    const context = capture();
    if (!context || busy) return;
    const started = currentVisit.current;
    setBusy(true);
    setError(null);
    try {
      const grant = await FinanceSharingService.view(context, item.id);
      if (
        grant.direction !== "outgoing" ||
        grant.ownerUserId !== context.userId ||
        grant.status !== "active"
      )
        throw new Error("This access changed. Refresh Manage sharing.");
      const config = await FinanceSharingService.ownerConfig(context, grant);
      const [saved, recipient] = await Promise.all([
        readSavedFinance(context, preferredSource ?? config.source),
        FinanceSharingService.recipient(context, grant.recipientPersonRef),
      ]);
      if (
        !context.isCurrent() ||
        currentVisit.current !== started ||
        document.hidden
      )
        return;
      setUpdateData({
        session,
        model: saved.model,
        initialShare: {
          grant,
          config: {
            ...config,
            source: saved.source,
            sourceFence: saved.sourceFence,
          },
          recipient,
        },
      });
    } catch (e) {
      if (context.isCurrent() && currentVisit.current === started)
        setError(
          e instanceof Error
            ? e.message
            : "Access could not be opened for updating.",
        );
    } finally {
      if (context.isCurrent() && currentVisit.current === started)
        setBusy(false);
    }
  };
  const groupedItems = useMemo(() => {
    const groups = new Map<string, FinanceGrant[]>();
    for (const item of items) {
      const key =
        direction === "outgoing" ? item.recipientUserId : item.ownerUserId;
      const list = groups.get(key) ?? [];
      if (!list.some((share) => share.id === item.id)) list.push(item);
      groups.set(key, list);
    }
    return [...groups.values()].map((shares) =>
      shares.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      ),
    );
  }, [items, direction]);
  const renderGrant = (item: FinanceGrant) => (
    <FinanceGrantDetails
      key={item.id}
      item={item}
      direction={direction}
      owner={owner}
      busy={busy}
      hasPortfolio={hasPortfolio}
      setSelected={setSelected}
      setStopping={setStopping}
      updateAccess={updateAccess}
    />
  );
  return (
    <>
      <KaiControlSurface
        open={open && !updateData && !selected}
        onOpenChange={onOpenChange}
        title="Finance sharing"
        description="Review access person by person."
        presentation="sheet"
        surfaceClassName={finance.detail}
      >
        <SegmentedTabs
          value={direction}
          options={canManageOutgoing ? directionTabs : directionTabs.slice(1)}
          ariaLabel="Sharing direction"
          onValueChange={(value) => setDirection(value === "received" ? "received" : "outgoing")}
        />
        {!hasPortfolio ? (
          <p className={`${styles.caption} mt-3`}>
            {canManageOutgoing
              ? "Add a portfolio to share again. You can still manage previous shares."
              : "Add a portfolio to share."}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="my-4 text-sm text-destructive">
            <p>{error}</p>
            <ShellActionSurface
              variant="pill"
              onClick={() => setReload((n) => n + 1)}
            >
              Retry
            </ShellActionSurface>
          </div>
        ) : null}
        {busy && !items.length ? (
          <p role="status" className="py-8 text-sm">
            Checking access…
          </p>
        ) : null}
        {!busy && !items.length && !error ? (
          <p className="py-8 text-sm text-muted-foreground">
            {ready
              ? "No Finance shares yet."
              : "Unlock your vault to manage sharing."}
          </p>
        ) : null}
        {groupedItems.map((shares) => {
          const item = shares[0]!;
          return (
            <article
              key={
                direction === "outgoing"
                  ? item.recipientUserId
                  : item.ownerUserId
              }
              className={styles.grantRow}
              data-testid="finance-sharing-person"
            >
              <div className={styles.grantHeader}>
                <div className={styles.grantPerson}>
                  <PersonProfileButton
                    personRef={
                      direction === "outgoing"
                        ? item.recipientPersonRef
                        : undefined
                    }
                    userId={
                      direction === "outgoing"
                        ? item.recipientUserId
                        : item.ownerUserId
                    }
                    label={
                      (direction === "outgoing"
                        ? item.recipientName
                        : item.senderName) || "this person"
                    }
                    className={styles.grantAvatar}
                  >
                    {(direction === "outgoing"
                      ? item.recipientName
                      : item.senderName
                    )
                      ?.trim()
                      .slice(0, 1)
                      .toUpperCase() || "?"}
                  </PersonProfileButton>
                  <div>
                    <h3 className="text-sm font-semibold">
                      {direction === "outgoing"
                        ? item.recipientName
                        : item.senderName}
                    </h3>
                  </div>
                </div>
                <span className={styles.chip}>
                  {shares.length} {shares.length === 1 ? "share" : "shares"}
                </span>
              </div>
              {renderGrant(item)}
              {shares.length > 1 ? (
                <details className="mt-4 border-t border-border pt-4">
                  <summary className="cursor-pointer text-sm">
                    Earlier shares ({shares.length - 1})
                  </summary>
                  {shares.slice(1).map(renderGrant)}
                </details>
              ) : null}
            </article>
          );
        })}
        {cursor ? (
          <div className="mt-4">
            <ShellActionSurface
              variant="pill"
              disabled={busy}
              onClick={() => void loadMore()}
            >
              More shares
            </ShellActionSurface>
          </div>
        ) : null}
      </KaiControlSurface>
      <FinanceSharedDetail
        grantId={selected}
        onClose={() => setSelected(null)}
      />
      <KaiControlSurface
        open={Boolean(stopping)}
        onOpenChange={(value) => {
          if (!value) setStopping(null);
        }}
        title={`Stop sharing with ${stopping?.recipientName || "this person"}?`}
        description="Access to this shared view and its Agent One review will end. Other shares keep their own access."
        surfaceClassName={finance.detail}
        footer={
          <div className={styles.toolbar}>
            <ShellActionSurface
              variant="pill"
              disabled={busy}
              onClick={() => setStopping(null)}
            >
              Keep sharing
            </ShellActionSurface>
            <ShellActionSurface
              variant="pill"
              disabled={busy}
              onClick={() => void stop()}
            >
              {busy ? "Stopping…" : "Stop sharing"}
            </ShellActionSurface>
          </div>
        }
      >
        <p className="text-sm leading-[21px]">
          Other recipients keep their own access. Information already copied or
          saved cannot be recalled.
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </KaiControlSurface>
      {open && ready && updateData?.session === session ? (
        <FinanceShareFlow
          open
          onOpenChange={(value) => {
            if (!value) setUpdateData(null);
          }}
          model={updateData.model}
          source={updateData.initialShare.config.source}
          initialShare={updateData.initialShare}
        />
      ) : null}
    </>
  );
}
