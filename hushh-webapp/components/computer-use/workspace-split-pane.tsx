"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Activity, Code2, Globe, Lock, X } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { isComputerUseActivelyStreaming, type ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { ComputerUsePreview } from "./computer-use-preview";
import { WorkspaceTerminalPanel } from "./workspace-terminal-panel";

export type WorkspacePaneTabId = "browser" | "activity" | "terminal";

export type WorkspaceExtraTab = Readonly<{
  id: string;
  label: string;
  render: () => ReactNode;
}>;

export type WorkspacePaneRegistration = Readonly<{
  id: string;
  render: () => ReactNode;
}>;

type WorkspaceSplitPaneActionsContextValue = Readonly<{
  setPane: (registration: WorkspacePaneRegistration) => void;
  clearPane: (id: string) => void;
}>;

const WorkspaceSplitPaneActionsContext =
  createContext<WorkspaceSplitPaneActionsContextValue | null>(null);
const WorkspaceSplitPaneStateContext =
  createContext<WorkspacePaneRegistration | null>(null);

export function WorkspaceSplitPaneProvider({ children }: { children: ReactNode }) {
  const [pane, setPaneState] = useState<WorkspacePaneRegistration | null>(null);
  const setPane = useCallback((registration: WorkspacePaneRegistration) => {
    setPaneState(registration);
  }, []);
  const clearPane = useCallback((id: string) => {
    setPaneState((current) => (current?.id === id ? null : current));
  }, []);
  const actions = useMemo(() => ({ setPane, clearPane }), [setPane, clearPane]);
  return (
    <WorkspaceSplitPaneActionsContext.Provider value={actions}>
      <WorkspaceSplitPaneStateContext.Provider value={pane}>
        {children}
      </WorkspaceSplitPaneStateContext.Provider>
    </WorkspaceSplitPaneActionsContext.Provider>
  );
}

export function useWorkspaceSplitPaneHost(): WorkspaceSplitPaneActionsContextValue | null {
  return useContext(WorkspaceSplitPaneActionsContext);
}

export function useWorkspaceSplitPaneOpen(): boolean {
  return useContext(WorkspaceSplitPaneStateContext) !== null;
}

export function WorkspaceSplitPaneDock() {
  const pane = useContext(WorkspaceSplitPaneStateContext);
  if (!pane) return null;
  return (
    <aside
      data-testid="workspace-split-pane-dock"
      className="hidden h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l border-[color:var(--app-separator)] bg-[color:var(--one-chat-canvas)] p-4 md:flex"
      aria-label="Browser preview"
    >
      {pane.render()}
    </aside>
  );
}

export function extractVerifiedDomain(snapshot: ComputerUseSnapshot | null): string | null {
  const candidates = [
    snapshot?.review?.destination,
    ...(snapshot?.review?.origins ?? []),
    ...(snapshot?.approvedOrigins ?? []),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "https:" && parsed.hostname) {
        return parsed.hostname;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function humanStateLabel(snapshot: ComputerUseSnapshot | null): string {
  if (!snapshot) return "Connecting";
  if (snapshot.controlOwner === "owner") return "You're in control";
  switch (snapshot.phase) {
    case "running":
      return "Working";
    case "needs_owner":
      return "Waiting for you";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Stopped";
    case "outcome_uncertain":
      return "Needs review";
    default:
      return "Unavailable";
  }
}

/** Composable Browser + Activity + Terminal workspace pane. Renders zero background loops when idle. */
export function WorkspaceSplitPaneSurface({
  controller,
  snapshot,
  verified,
  canPreview,
  statusMessage,
  controls,
  onClose,
  onOpenReview,
  onSaveDownload,
  downloadPending = false,
  extraTabs = [],
  showMobileHeaderClose = false,
  defaultTab = "browser",
}: {
  controller: ComputerUseTaskController;
  snapshot: ComputerUseSnapshot | null;
  verified: boolean;
  canPreview: boolean;
  statusMessage: string;
  controls: ReactNode;
  onClose: () => void;
  onOpenReview?: () => void;
  onSaveDownload?: (downloadId: string) => void;
  downloadPending?: boolean;
  extraTabs?: readonly WorkspaceExtraTab[];
  showMobileHeaderClose?: boolean;
  defaultTab?: WorkspacePaneTabId;
}) {
  const [activeTab, setActiveTab] = useState<string>(defaultTab);
  const domain = extractVerifiedDomain(snapshot);
  const stateLabel = humanStateLabel(snapshot);
  const subtitle = domain ? `${stateLabel} · ${domain}` : stateLabel;
  const activeStreaming = verified && isComputerUseActivelyStreaming(snapshot);

  const builtInTabs: ReadonlyArray<{ id: WorkspacePaneTabId; label: string; icon: ReactNode }> = [
    { id: "browser", label: "Browser", icon: <Globe className="size-3.5" aria-hidden /> },
    { id: "activity", label: "Activity", icon: <Activity className="size-3.5" aria-hidden /> },
    { id: "terminal", label: "Terminal", icon: <Code2 className="size-3.5" aria-hidden /> },
  ];

  const matchingExtraTab = extraTabs.find((tab) => tab.id === activeTab);

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="workspace-split-pane-surface">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{statusMessage}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          {!showMobileHeaderClose ? (
            <ShellActionSurface
              className="size-11"
              aria-label="Close browser preview"
              onClick={onClose}
            >
              <X className="size-4" aria-hidden />
            </ShellActionSurface>
          ) : null}
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Workspace views"
        className="flex flex-wrap items-center gap-1.5 border-b border-[color:var(--app-separator)] pb-2"
      >
        {builtInTabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
                selected
                  ? "bg-foreground text-background"
                  : "bg-foreground/[0.045] text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
        {extraTabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
                selected
                  ? "bg-foreground text-background"
                  : "bg-foreground/[0.045] text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "browser" ? (
        <div role="tabpanel" aria-label="Browser view" className="flex min-h-0 flex-col gap-3">
          {domain ? (
            <div
              className="flex min-w-0 items-center gap-2 rounded-full border border-[color:var(--app-separator)] bg-foreground/[0.03] px-3 py-1.5 text-xs text-muted-foreground"
              aria-label="Verified website"
            >
              <Lock className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate font-mono">{`https://${domain}`}</span>
            </div>
          ) : null}
          {canPreview ? (
            <>
              {!activeStreaming && snapshot?.phase === "needs_owner" ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Live preview paused while waiting for you. Select Take control to sign in
                  privately with agent observation off.
                </p>
              ) : null}
              <ComputerUsePreview controller={controller} />
            </>
          ) : (
            <div className="rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-4 text-sm text-muted-foreground">
              {snapshot?.summary || statusMessage}
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "activity" ? (
        <div
          role="tabpanel"
          aria-label="Activity summary"
          className="space-y-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-4 text-sm"
          data-testid="workspace-activity-panel"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-foreground">{statusMessage}</span>
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          </div>
          {snapshot ? (
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Control</dt>
                <dd className="font-medium text-foreground">{humanStateLabel(snapshot)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Turn epoch</dt>
                <dd className="font-medium text-foreground">
                  {snapshot.controlEpoch} · rev {snapshot.revision}
                </dd>
              </div>
            </dl>
          ) : null}
          {snapshot?.approvedOrigins?.length ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Approved websites</p>
              <ul className="space-y-1 text-xs font-mono text-foreground">
                {snapshot.approvedOrigins.map((origin) => (
                  <li key={origin} className="truncate">
                    {origin}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {snapshot?.summary ? (
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {snapshot.summary}
            </p>
          ) : null}
          {snapshot?.review && onOpenReview ? (
            <ShellActionSurface variant="pill" className="min-h-10" onClick={onOpenReview}>
              Review request
            </ShellActionSurface>
          ) : null}
          {snapshot?.downloads?.length && onSaveDownload ? (
            <div className="space-y-2">
              {snapshot.downloads.map((download) => (
                <div key={download.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {download.name}
                  </span>
                  <ShellActionSurface
                    variant="pill"
                    className="min-h-9"
                    disabled={downloadPending}
                    onClick={() => onSaveDownload(download.id)}
                  >
                    Save to Files
                  </ShellActionSurface>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {activeTab === "terminal" ? (
        <div role="tabpanel" aria-label="Terminal view" className="flex min-h-0 flex-col gap-3">
          <WorkspaceTerminalPanel
            ownerId={controller.binding.ownerId}
            active={activeTab === "terminal"}
          />
        </div>
      ) : null}

      {matchingExtraTab ? (
        <div role="tabpanel" aria-label={matchingExtraTab.label}>
          {matchingExtraTab.render()}
        </div>
      ) : null}
    </div>
  );
}
