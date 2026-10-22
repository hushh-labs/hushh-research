"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";

import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SettingsGroup,
  SettingsPresentationProvider,
} from "@/components/app-ui/settings-ui";
import { FeedRow } from "@/components/feed/feed-row";
import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import {
  ClipboardList,
  Fingerprint,
  X,
  Newspaper,
  ArrowUpRight,
} from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import { useOneDisplayName } from "@/lib/agent/use-one-display-name";
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
import { nativeDrawersPlatformEligible } from "@/lib/capacitor/native-drawers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";

import { PrivateTextApprovalControl } from "@/components/agent/private-text-approval-control";
import { useVault } from "@/lib/vault/vault-context";
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
import { OnePresenceAvatar, type OnePresenceState } from "./one-presence-avatar";

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
    <div className={styles.feed}>
      <div className={styles.sectionHeading}>
        <h3 data-app-pane-section-label>Latest activity</h3>
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

type OneAgentProfileProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  modelControl?: ReactNode;
  nativeReady?: boolean;
  presenceState?: OnePresenceState;
};

/** Rich One content uses the existing owned content plane, not a second
 * two-row menu. Native owns the header; the shared body owns Feed and tabs. */
function NativeOneAgentProfile({ open, onOpenChange, modelControl, nativeReady = false, presenceState = "connected" }: OneAgentProfileProps) {
  const { user } = useAuth();
  const context = JSON.stringify([user?.uid, snapshotVaultSessionEpoch(), "one-profile"]);
  const close = () => onOpenChange(false);
  return <NativeFeaturePage pane open={open && nativeReady && !!user} title="One"
    owner={user?.uid ?? null} context={context} backLabel="Back to Chat" closeLabel="Close One profile"
    bodyClassName={styles.nativeBody} onBack={close} onClose={close}>
    <OneProfileContent open={open && nativeReady} onOpenChange={onOpenChange} modelControl={modelControl} presenceState={presenceState} />
  </NativeFeaturePage>;
}

export function OneAgentProfileSheet(props: OneAgentProfileProps) {
  return nativeDrawersPlatformEligible() ? <NativeOneAgentProfile {...props} /> : <WebOneAgentProfile {...props} />;
}

function WebOneAgentProfile({
  open,
  onOpenChange,
  triggerRef,
  modelControl,
  presenceState = "connected",
}: OneAgentProfileProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent side="right" className={styles.sheet} data-app-side-pane showCloseButton={false} contentDragDismiss={false}
        onCloseAutoFocus={event => {
          if (triggerRef?.current?.isConnected) { event.preventDefault(); triggerRef.current.focus(); }
        }}>
        <SheetClose asChild>
          <button type="button" aria-label="Close One profile"
            className="app-side-pane-close absolute right-5 z-10 inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-4" aria-hidden />
          </button>
        </SheetClose>
        <SheetDescription className="sr-only">One profile and activity.</SheetDescription>
        <OneProfileContent open={open} onOpenChange={onOpenChange} modelControl={modelControl} presenceState={presenceState} sheet />
      </SheetContent>
    </Sheet>
  );
}

/** One content model and hierarchy across renderers; no duplicated identity,
 * feed policy, private-name projection or tab/action authority. */
function OneProfileContent({ open, onOpenChange, modelControl, presenceState = "connected", sheet = false }: OneAgentProfileProps & { sheet?: boolean }) {
  const { user } = useAuth();
  const profileName = useOneDisplayName(open);
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
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


  return <div className={styles.content}>
        <div className={styles.hero}>
          <div className={styles.avatar}>
            <OnePresenceAvatar state={presenceState} presentation="profile" className={styles.artwork} />
          </div>
          {sheet ? <SheetTitle className={styles.title}>{profileName}</SheetTitle> : <h2 className={styles.title}>{profileName}</h2>}
        </div>
        {modelControl ? <div className={styles.modelControl}>{modelControl}</div> : null}
        {open && user ? <PrivateTextApprovalControl key={user.uid} user={user} /> : null}
        <Tabs value={tab} onValueChange={changeTab} className={styles.tabs}>
          <TabsList
            className={styles.tabList}
            aria-label="One profile sections"
          >
            <TabsTrigger value="feed">
              <Newspaper aria-hidden /> Feed
            </TabsTrigger>
            <TabsTrigger value="todo"><ClipboardList aria-hidden /> To-do</TabsTrigger>
            <TabsTrigger value="profile">
              <Fingerprint aria-hidden /> Profile
            </TabsTrigger>
          </TabsList>
          <div ref={scrollRef} className={styles.scroll} data-one-profile-scroll>
            <TabsContent value="feed">{feed}</TabsContent>
            <TabsContent value="todo">{todo}</TabsContent>
            <TabsContent value="profile">
              <div className={styles.profile}>
                <LiveMirrorPreview onNavigate={() => onOpenChange(false)} />
              </div>
            </TabsContent>
          </div>
        </Tabs>
  </div>;
}
