"use client";

import { useInterfaceRevision } from "@/lib/capacitor/native-interface-revision";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

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
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import {
  AccountProfileIcon,
  Activity,
  ClipboardList,
  ConnectedSystemsAgentIcon,
  ConsentAgentIcon,
  FinanceAgentIcon,
  Fingerprint,
  Globe,
  LocationAgentIcon,
  MemoryAgentIcon,
  WalletAgentIcon,
  X,
} from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import { useOneDisplayName } from "@/lib/agent/use-one-display-name";
import { nativeDrawersPlatformEligible } from "@/lib/capacitor/native-drawers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { describeLiveActivity } from "@/lib/pkm/live-activity/live-activity-copy";
import {
  peekLiveActivity,
  subscribeLiveActivity,
} from "@/lib/pkm/live-activity/live-activity-journal";

import { useVault } from "@/lib/vault/vault-context";
import { OneAgentPresenceForOwner } from "@/components/dashboard/one-agent-presence";
import { OneTodoPreview } from "./one-todo-preview";

import styles from "./one-agent-profile-sheet.module.css";
import { OnePresenceAvatar, type OnePresenceState } from "./one-presence-avatar";
import { cn } from "@/lib/utils";

export type OneSessionActionIcon =
  | "action"
  | "connectors"
  | "memory"
  | "consent"
  | "finance"
  | "wallet"
  | "location"
  | "profile"
  | "web";

export type OneSessionActionEntry = {
  id: string;
  label: string;
  message: string;
  status: "running" | "waiting" | "done" | "blocked" | "error";
  tag?: string;
  icon?: OneSessionActionIcon;
  createdAtMs: number;
  durationMs?: number;
};

const ACTION_ICONS = {
  action: Activity,
  connectors: ConnectedSystemsAgentIcon,
  memory: MemoryAgentIcon,
  consent: ConsentAgentIcon,
  finance: FinanceAgentIcon,
  wallet: WalletAgentIcon,
  location: LocationAgentIcon,
  profile: AccountProfileIcon,
  web: Globe,
} as const;

function ActionStepIcon({ icon = "action" }: { icon?: OneSessionActionIcon }) {
  const Icon = ACTION_ICONS[icon] ?? Activity;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />;
}

const activityTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatActionTiming(event: OneSessionActionEntry): string {
  if (event.status === "running") return "Running";
  if (event.status === "waiting") return "Waiting";
  if (typeof event.durationMs === "number" && event.durationMs > 0) {
    if (event.durationMs < 1_000) return `${Math.round(event.durationMs)}ms`;
    return `${(event.durationMs / 1_000).toFixed(1)}s`;
  }
  if (Number.isFinite(event.createdAtMs) && event.createdAtMs > 0) {
    return activityTimeFormat.format(event.createdAtMs);
  }
  return "Done";
}

function startOfLocalDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function OneActivityWorkspace({
  ownerId,
  active,
  isVaultUnlocked,
  sessionActions = [],
}: {
  ownerId: string;
  active: boolean;
  isVaultUnlocked: boolean;
  sessionActions?: readonly OneSessionActionEntry[];
}) {
  const [journalTick, setJournalTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    return subscribeLiveActivity(() => setJournalTick((value) => value + 1));
  }, [active]);

  const todayJournalEvents = useMemo(() => {
    void journalTick;
    if (!isVaultUnlocked || !ownerId) return [];
    const since = startOfLocalDay(Date.now());
    return peekLiveActivity(ownerId)
      .filter((entry) => entry.lastAt >= since)
      .slice(0, 12);
  }, [isVaultUnlocked, journalTick, ownerId]);

  const hasActionRows = sessionActions.length > 0 || todayJournalEvents.length > 0;

  return (
    <div className={styles.activity} data-testid="one-activity-workspace">
      <section className="flex flex-col gap-2" aria-label="Action logs" data-testid="one-activity-action-logs">
        <div className={styles.sectionHeading}>
          <h3 data-app-pane-section-label>Action logs</h3>
          {sessionActions.some((step) => step.status === "running") ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--app-accent)]">
              <span className="size-1.5 rounded-full bg-[color:var(--app-accent)] motion-safe:animate-pulse" aria-hidden />
              Live
            </span>
          ) : null}
        </div>

        {hasActionRows ? (
          <SettingsPresentationProvider density="compact" separatorInset>
            <SettingsGroup>
              {sessionActions.map((step) => {
                const headline = step.message || step.label;
                const detail =
                  step.message && step.label && step.message !== step.label
                    ? step.label
                    : step.tag;
                const isRunning = step.status === "running" || step.status === "waiting";
                const isIssue = step.status === "error" || step.status === "blocked";
                return (
                  <SettingsRow
                    key={step.id}
                    leading={
                      <span
                        className={cn(
                          "inline-flex size-7 shrink-0 items-center justify-center rounded-full",
                          isRunning
                            ? "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]"
                            : isIssue
                              ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                              : "bg-[color:var(--app-neutral-fill)] text-muted-foreground",
                        )}
                      >
                        <ActionStepIcon icon={step.icon} />
                      </span>
                    }
                    title={headline}
                    description={detail}
                    trailing={
                      <span
                        className={cn(
                          "shrink-0 font-mono text-[11.5px] tabular-nums",
                          isRunning
                            ? "font-medium text-[color:var(--app-accent)]"
                            : "text-muted-foreground",
                        )}
                      >
                        {formatActionTiming(step)}
                      </span>
                    }
                  />
                );
              })}
              {todayJournalEvents.map((event) => {
                const line = describeLiveActivity(event);
                const title = event.count > 1 ? `${line} · ${event.count}×` : line;
                return (
                  <SettingsRow
                    key={`journal-${event.id}`}
                    leading={
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] text-muted-foreground">
                        <Activity className="size-3.5" aria-hidden />
                      </span>
                    }
                    title={title}
                    trailing={
                      <time
                        className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground"
                        dateTime={new Date(event.lastAt).toISOString()}
                      >
                        {activityTimeFormat.format(event.lastAt)}
                      </time>
                    }
                  />
                );
              })}
            </SettingsGroup>
          </SettingsPresentationProvider>
        ) : (
          <div className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-5 text-center">
            <p className="text-[13.5px] font-medium text-foreground">
              No actions recorded in this session yet.
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tool executions and memory updates stream here live.
            </p>
          </div>
        )}
      </section>
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
  sessionActions?: readonly OneSessionActionEntry[];
};

/** Rich One content uses the existing owned content plane, not a second
 * two-row menu. Native owns the header; the shared body owns Activity, Tasks, and Profile. */
function NativeOneAgentProfile({
  open,
  onOpenChange,
  modelControl,
  nativeReady = false,
  presenceState = "connected",
  sessionActions,
}: OneAgentProfileProps) {
  const { user, userId } = useAuth();
  const context = JSON.stringify([userId, snapshotVaultSessionEpoch(), "one-profile"]);
  const todoBack = useRef<(() => boolean) | null>(null);
  const close = () => onOpenChange(false);
  return (
    <NativeFeaturePage
      pane
      open={open && nativeReady && !!user}
      title="One"
      owner={userId}
      context={context}
      backLabel="Back to Chat"
      closeLabel="Close One profile"
      bodyClassName={styles.nativeBody}
      onBack={() => {
        if (!todoBack.current?.()) close();
      }}
      onClose={close}
    >
      <OneProfileContent
        open={open && nativeReady}
        onOpenChange={onOpenChange}
        modelControl={modelControl}
        presenceState={presenceState}
        sessionActions={sessionActions}
        onTodoBackChange={(handler) => {
          todoBack.current = handler;
        }}
      />
    </NativeFeaturePage>
  );
}

export function OneAgentProfileSheet(props: OneAgentProfileProps) {
  useInterfaceRevision();
  return nativeDrawersPlatformEligible() ? (
    <NativeOneAgentProfile {...props} />
  ) : (
    <WebOneAgentProfile {...props} />
  );
}

function WebOneAgentProfile({
  open,
  onOpenChange,
  triggerRef,
  modelControl,
  presenceState = "connected",
  sessionActions,
}: OneAgentProfileProps) {
  const todoBack = useRef<(() => boolean) | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent
        side="right"
        className={styles.sheet}
        data-app-side-pane
        showCloseButton={false}
        contentDragDismiss={false}
        onEscapeKeyDown={(event) => {
          if (todoBack.current?.()) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (triggerRef?.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <SheetClose asChild>
          <button
            type="button"
            aria-label="Close One profile"
            className="app-side-pane-close absolute right-5 z-10 inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-[22px]" aria-hidden />
          </button>
        </SheetClose>
        <SheetDescription className="sr-only">
          One workspace activity, tasks, and profile.
        </SheetDescription>
        <OneProfileContent
          open={open}
          onOpenChange={onOpenChange}
          modelControl={modelControl}
          presenceState={presenceState}
          sessionActions={sessionActions}
          sheet
          onTodoBackChange={(handler) => {
            todoBack.current = handler;
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

/** One content model and hierarchy across renderers; Feed stays strictly on its
 * dedicated bottom-bar route while One's character pane hosts live Activity. */
function OneProfileContent({
  open,
  onOpenChange,
  modelControl,
  presenceState = "connected",
  sessionActions,
  sheet = false,
  onTodoBackChange,
}: OneAgentProfileProps & {
  sheet?: boolean;
  onTodoBackChange?: (handler: (() => boolean) | null) => void;
}) {
  const { user, userId } = useAuth();
  const profileName = useOneDisplayName(open);
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [tab, setTab] = useState("activity");
  const scrollRef = useRef<HTMLDivElement>(null);
  const changeTab = (value: string) => {
    setTab(value);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  let activity: ReactNode = (
    <p className={styles.notice}>Sign in to view workspace activity.</p>
  );
  if (open && tab === "activity" && user && userId) {
    activity = (
      <OneActivityWorkspace
        key={userId}
        ownerId={userId}
        active={open && tab === "activity"}
        isVaultUnlocked={isVaultUnlocked}
        sessionActions={sessionActions}
      />
    );
  }

  let todo: ReactNode = (
    <p className={styles.notice}>Sign in to view your to-do list.</p>
  );
  if (open && tab === "todo" && user && userId) {
    todo = (
      <OneTodoPreview
        key={userId}
        user={user}
        ownerId={userId}
        vaultKey={vaultKey}
        vaultOwnerToken={vaultOwnerToken}
        isVaultUnlocked={isVaultUnlocked}
        onDetailBackChange={onTodoBackChange}
      />
    );
  }

  return (
    <div className={styles.content}>
      <div className={styles.hero}>
        <div className={styles.avatar}>
          <OnePresenceAvatar
            state={presenceState}
            presentation="profile"
            className={styles.artwork}
          />
        </div>
        {sheet ? (
          <SheetTitle className={styles.title}>{profileName}</SheetTitle>
        ) : (
          <h2 className={styles.title}>{profileName}</h2>
        )}
        <div className={styles.presenceSlot}>
          <OneAgentPresenceForOwner
            userId={userId}
            compact
            working={presenceState === "working"}
          />
        </div>
      </div>
      {modelControl ? <div className={styles.modelControl}>{modelControl}</div> : null}
      <Tabs value={tab} onValueChange={changeTab} className={styles.tabs}>
        <TabsList className={styles.tabList} aria-label="One profile sections">
          <TabsTrigger value="activity">
            <Activity aria-hidden /> Activity
          </TabsTrigger>
          <TabsTrigger value="todo">
            <ClipboardList aria-hidden /> Tasks
          </TabsTrigger>
          <TabsTrigger value="profile">
            <Fingerprint aria-hidden /> Profile
          </TabsTrigger>
        </TabsList>
        <div ref={scrollRef} className={styles.scroll} data-one-profile-scroll>
          <TabsContent value="activity">{activity}</TabsContent>
          <TabsContent value="todo">{todo}</TabsContent>
          <TabsContent value="profile">
            <div className={styles.profile}>
              <LiveMirrorPreview onNavigate={() => onOpenChange(false)} />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
