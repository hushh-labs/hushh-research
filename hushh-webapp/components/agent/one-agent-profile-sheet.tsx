"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";

import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SettingsGroup,
  SettingsPresentationProvider,
} from "@/components/app-ui/settings-ui";
import { FeedRow } from "@/components/feed/feed-row";
import {
  ClipboardList,
  Fingerprint,
  Heart,
  Newspaper,
  ArrowUpRight,
  X,
} from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { ownerStyleFromBranch } from "@/lib/agent/owner-style-settings";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import {
  FeedService,
  type FeedItem,
  type FeedListResponse,
} from "@/lib/services/feed-service";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { collapseConsentBundleRows } from "@/lib/feed/feed-consent-grouping";
import { collapseDriveLifecycleRows } from "@/lib/feed/feed-drive-grouping";
import { isFeedItemHidden } from "@/lib/feed/feed-visibility";
import { isFeedIdAtOrBefore } from "@/lib/feed/feed-pagination";
import { readFeedClearedThroughId } from "@/lib/feed/feed-clear-watermark";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import { ROUTES } from "@/lib/navigation/routes";
import { OnePresenceAvatar, type OnePresenceState } from "@/components/agent/one-presence-avatar";
import {
  TodoListPkmService,
  openTodoItems,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import {
  TodoRow,
  DueReceiptRow,
  extractDueReceipts,
  groupByDate,
} from "@/components/todos/todo-list-page";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  getCachedGmailReceipts,
  cachedGmailReceiptDisplayItems,
} from "@/lib/profile/gmail-receipts-cache";

import styles from "./one-agent-profile-sheet.module.css";

/** A read-only feed preview; the full Feed owns actions and read acknowledgements. */
function OneFeedPreview({
  user,
  onNavigate,
}: {
  user: User;
  onNavigate: (href: string) => void;
}) {
  const { data, loading, error, refresh } = useStaleResource<FeedListResponse>({
    cacheKey: CACHE_KEYS.FEED_LIST(user.uid),
    resourceLabel: "one_profile_feed",
    retainOnInvalidate: true,
    load: async (options) =>
      FeedService.list({
        idToken: await user.getIdToken(),
        userId: user.uid,
        limit: 20,
        force: options?.force,
      }),
  });
  useFeedLiveRefresh(() => {
    void refresh({ force: true });
  });
  const clearedThrough = readFeedClearedThroughId(user.uid);
  const visibleItems = (data?.items ?? []).filter(
    (item) =>
      !isFeedItemHidden(item, isLocalCrmBuildEnabled()) &&
      (!clearedThrough || !isFeedIdAtOrBefore(item.id, clearedThrough)),
  );
  const items = collapseDriveLifecycleRows(
    collapseConsentBundleRows(visibleItems),
  );
  const openFullFeed = (_item: FeedItem) => onNavigate(ROUTES.ONE_FEED);

  return (
    <div className={`${styles.feed} profile-home-content`}>
      <div className={styles.sectionHeading}>
        <h3>Latest activity</h3>
        <button type="button" onClick={() => onNavigate(ROUTES.ONE_FEED)}>
          Open Feed <ArrowUpRight className="size-4" aria-hidden />
        </button>
      </div>
      {loading && !data ? (
        <p role="status" className={styles.notice}>
          Loading your feed…
        </p>
      ) : null}
      {error && !data ? (
        <div className={styles.notice}>
          <p>Your feed couldn’t load.</p>
          <button
            type="button"
            onClick={() => {
              void refresh({ force: true });
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <div className={styles.empty}>
          <Newspaper className="size-7" aria-hidden />
          <p>No recent activity.</p>
          <span>New activity will appear here.</span>
        </div>
      ) : null}
      {items.length ? (
        <SettingsPresentationProvider density="compact" separatorInset>
          <SettingsGroup>
            {items.map((item) => (
              <FeedRow key={item.id} item={item} onOpen={openFullFeed} />
            ))}
          </SettingsGroup>
        </SettingsPresentationProvider>
      ) : null}
    </div>
  );
}

function OneTodoPreview({
  user,
  vaultKey,
  vaultOwnerToken,
  isVaultUnlocked,
}: {
  user: User;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isVaultUnlocked: boolean;
}) {
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const loadTasks = useCallback(async () => {
    if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setTasks([]);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const state = await TodoListPkmService.load({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      setTasks(state.tasks);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [isVaultUnlocked, user.uid, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const idTokenProvider = useCallback(
    () => user.getIdToken(),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: user.uid,
    idTokenProvider,
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  const cachedReceipts = useMemo(() => {
    if (!isVaultUnlocked || !receiptAccountKey) return null;
    return getCachedGmailReceipts(user.uid, receiptAccountKey);
  }, [isVaultUnlocked, receiptAccountKey, user.uid]);

  const dueReceipts = useMemo(() => {
    if (!cachedReceipts) return [];
    return extractDueReceipts(cachedGmailReceiptDisplayItems(cachedReceipts));
  }, [cachedReceipts]);

  const openTasks = useMemo(() => openTodoItems(tasks), [tasks]);
  const groups = useMemo(() => groupByDate(openTasks), [openTasks]);
  const anytimeGroup = useMemo(
    () => groups.find((g) => g.id === "anytime"),
    [groups],
  );
  const datedGroups = useMemo(
    () => groups.filter((g) => g.id !== "anytime"),
    [groups],
  );

  const toggleTask = useCallback(
    async (task: TodoItem, complete: boolean) => {
      if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) return;
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? { ...t, status: complete ? "done" : "pending" }
            : t,
        ),
      );
      try {
        await TodoListPkmService.setStatus({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
          task,
          status: complete ? "done" : "pending",
        });
      } catch {
        void loadTasks();
      }
    },
    [isVaultUnlocked, loadTasks, user.uid, vaultKey, vaultOwnerToken],
  );

  const deleteTask = useCallback(
    async (task: TodoItem) => {
      if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) return;
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      try {
        await TodoListPkmService.remove({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
          task,
        });
      } catch {
        void loadTasks();
      }
    },
    [isVaultUnlocked, loadTasks, user.uid, vaultKey, vaultOwnerToken],
  );

  return (
    <div className={`${styles.todo} profile-home-content`}>
      <div className={styles.sectionHeading}>
        <h3>To-do list</h3>
      </div>

      {!isVaultUnlocked ? (
        <p role="status" className={styles.notice}>
          Unlock your vault to view your to-do list.
        </p>
      ) : loading && !tasks.length ? (
        <p role="status" className={styles.notice}>
          Loading your to-do list…
        </p>
      ) : error && !tasks.length ? (
        <div className={styles.notice}>
          <p>Your to-do list couldn’t load.</p>
          <button type="button" onClick={() => void loadTasks()}>
            Try again
          </button>
        </div>
      ) : !openTasks.length && !dueReceipts.length ? (
        <div className={styles.empty}>
          <ClipboardList className="size-7" aria-hidden />
          <p>All clear.</p>
          <span>Tasks and due payments will appear here.</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 1. Any time section comes FIRST */}
          {anytimeGroup ? (
            <section key={anytimeGroup.id} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                {anytimeGroup.label}
              </h4>
              <div className="space-y-2">
                {anytimeGroup.tasks.map((task) => (
                  <TodoRow
                    key={task.id}
                    task={task}
                    saving={false}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {/* 2. Receipts in between */}
          {dueReceipts.length > 0 ? (
            <section className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                Receipts & Due Payments
              </h4>
              <div className="space-y-2">
                {dueReceipts.map((receipt) => (
                  <DueReceiptRow key={receipt.id} receipt={receipt} />
                ))}
              </div>
            </section>
          ) : null}

          {/* 3. Dated events below */}
          {datedGroups.map((group) => (
            <section key={group.id} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                {group.label}
              </h4>
              <div className="space-y-2">
                {group.tasks.map((task) => (
                  <TodoRow
                    key={task.id}
                    task={task}
                    saving={false}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileCards({ close }: { close: () => void }) {
  return (
    <div className={styles.profile}>
      <div className={styles.cards}>
        <article
          className={`${styles.fileCard} ${styles.soul}`}
          aria-label="soul.md preview"
        >
          <div>
            <Heart className="size-5" aria-hidden />
            <h4>soul.md</h4>
            <p>Voice, values, and personality.</p>
          </div>
          <div className={styles.cardFooter}>
            <span>Soul preview</span>
            <Heart className="size-5" fill="currentColor" aria-hidden />
          </div>
        </article>
        <Link
          href={ROUTES.PKM}
          onClick={close}
          className={`${styles.fileCard} ${styles.memory}`}
          aria-label="Open memory.md in Memory"
        >
          <div>
            <Fingerprint className="size-5" aria-hidden />
            <h4>memory.md</h4>
            <p>What you’ve chosen to remember.</p>
          </div>
          <div className={styles.cardFooter}>
            <span>Open Memory</span>
            <ArrowUpRight className="size-5" aria-hidden />
          </div>
        </Link>
      </div>
    </div>
  );
}

export function OneAgentProfileSheet({
  open,
  onOpenChange,
  triggerRef,
  presenceState = "connected",
}: {
  presenceState?: OnePresenceState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const identity = usePkmDomainResource({
    userId: user?.uid ?? "",
    domain: "identity",
    vaultKey,
    vaultOwnerToken,
    enabled: open && isVaultUnlocked && Boolean(vaultKey && vaultOwnerToken),
  });
  const profileName = isVaultUnlocked && vaultKey && vaultOwnerToken &&
    identity.data?.key.userId === user?.uid
    ? ownerStyleFromBranch(identity.data?.data.communication_preferences).preferred_name || "One"
    : "One";
  const router = useRouter();
  const [tab, setTab] = useState("feed");
  const scrollRef = useRef<HTMLDivElement>(null);
  const changeTab = (value: string) => {
    setTab(value);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const navigate = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  let feed: ReactNode = (
    <p className={styles.notice}>Sign in to view your feed.</p>
  );
  if (open && tab === "feed" && user)
    feed = <OneFeedPreview key={user.uid} user={user} onNavigate={navigate} />;

  let todo: ReactNode = (
    <p className={styles.notice}>Sign in to view your to-do list.</p>
  );
  if (open && tab === "todo" && user) {
    todo = (
      <OneTodoPreview
        key={user.uid}
        user={user}
        vaultKey={vaultKey}
        vaultOwnerToken={vaultOwnerToken}
        isVaultUnlocked={isVaultUnlocked}
      />
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        className={styles.sheet}
        data-app-side-pane
        showCloseButton={false}
        contentDragDismiss={false}
        onCloseAutoFocus={(event) => {
          if (triggerRef?.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <SheetClose asChild>
          <button type="button" aria-label="Close One profile" className={styles.close}>
            <X className="size-4" aria-hidden />
          </button>
        </SheetClose>
        <div className={styles.hero}>
          <div className={styles.avatar}>
            <OnePresenceAvatar state={presenceState} presentation="profile" className={styles.artwork} />
          </div>
          <SheetTitle className={styles.title}>{profileName}</SheetTitle>
        </div>
        <Tabs value={tab} onValueChange={changeTab} className={styles.tabs}>
          <TabsList
            className={styles.tabList}
            aria-label="One profile sections"
          >
            <TabsTrigger value="feed">
              <Newspaper aria-hidden /> Feed
            </TabsTrigger>
            <TabsTrigger value="todo">
              <ClipboardList aria-hidden /> To-do
            </TabsTrigger>
            <TabsTrigger value="profile">
              <Fingerprint aria-hidden /> Profile
            </TabsTrigger>
          </TabsList>
          <div ref={scrollRef} className={styles.scroll} data-one-profile-scroll>
            <TabsContent value="feed">{feed}</TabsContent>
            <TabsContent value="todo">{todo}</TabsContent>
            <TabsContent value="profile">
              <ProfileCards close={() => onOpenChange(false)} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
