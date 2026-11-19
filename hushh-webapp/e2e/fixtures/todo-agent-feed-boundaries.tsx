// Isolated browser-test boundaries. Never imported by an application route.
import React, { useSyncExternalStore, type ReactNode } from "react";
import type { FeedActionable } from "../../lib/feed/use-feed-actionables";
import { documentRequestTaskTitle } from "../../lib/consent/document-request-setup";

let state = {
  unlocked: true,
  error: false,
  failSave: false,
  hideAgent: false,
  preview: false,
  providerTasks: false,
  revision: 0,
  message: "",
  href: "",
};
const listeners = new Set<() => void>();
export function change(update: Partial<typeof state>) {
  state = { ...state, ...update, revision: state.revision + 1 };
  listeners.forEach((listener) => listener());
}
export function useFixture() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
export function useAuth() {
  return {
    user: { uid: "fixture-owner", getIdToken: async () => "fixture-only" },
    userId: "fixture-owner",
  };
}
export function useVault() {
  const { unlocked } = useFixture();
  return {
    isVaultUnlocked: unlocked,
    vaultKey: unlocked ? "fixture-only" : null,
    vaultOwnerToken: unlocked ? "fixture-only" : null,
  };
}
export const items = [
  {
    id: "connection:fixture-request",
    title: "Fixture connection request",
    todo: {
      source: "connections",
      title: "Review Alex's connection request",
      href: "/one/consent?requestId=fixture-request",
    },
    actions: [
      {
        key: "approve",
        run() {
          throw new Error("A To-do must never execute its source action");
        },
      },
    ],
  },
] as FeedActionable[];
const previewItems: FeedActionable[] = [items[0], {
  ...items[0],
  id: "connection:fixture-follow-up",
  todo: { source: "connections", title: "Review the team's follow-up request", href: "/one/consent?requestId=fixture-follow-up" },
}];
export function useFeedActionables({ enabled }: { enabled: boolean }) {
  const value = useFixture();
  return {
    actionables: enabled && !value.hideAgent ? [...(value.preview ? previewItems : items), ...(value.providerTasks ? [{
      id: "consent:fixture-document:setup:drive", todo: { source: "drive" as const,
        title: documentRequestTaskTitle("drive", "Saru"), href: "/one/profile?profile_panel=connectors" },
    }] : [])] : [],
    loading: false,
    progressLoading: false,
    progressError: null,
    error: value.error ? "synthetic private provider error" : null,
    retry: async () => change({ error: false }),
  };
}
export function useFeedBriefing() {
  return {
    pendingKyc: null,
    kycLoading: false,
    kycError: false,
    retryKyc: async () => {},
  };
}
export function useCalendarConnectionStatus() {
  const { providerTasks } = useFixture();
  return { connected: providerTasks, loaded: true, loading: false, error: null, refresh: () => {} };
}
// This persistence/lifecycle fixture has no linked Gmail account.
export function useGmailConnectorStatus() {
  const { providerTasks } = useFixture();
  return { status: providerTasks ? { connected: true } : null, loadingStatus: false, statusError: null };
}
export function getCachedGmailReceipts() {
  return null;
}
export function cachedGmailReceiptDisplayItems() {
  return [];
}
// This isolated fixture never contains Gmail receipts, so clearing is a no-op.
export function clearCachedGmailReceipts() {}
// Only the synthetic Feed task participates in this lifecycle fixture.
export async function readTodoCapabilities() {
  return state.providerTasks ? [{ coverage: { capability: "gmail", count: 1, status: "incomplete" }, evidence: [{
    capability: "gmail", key: "mail:fixture-metadata", summary: "Meeting details",
    pendingTitle: "Reply to Saru: Meeting details", href: "/one/gmail",
  }] }] : [];
}
export async function todoSuggestionsAvailable() {
  return false;
}
export async function suggestTodoTasks() {
  throw new Error("This lifecycle fixture must never request model suggestions");
}
export function useCalendarUpcomingEvents() {
  const { providerTasks } = useFixture();
  return { events: providerTasks ? [{ id: "fixture-event", title: "Planning meeting",
    start: { dateTime: "2099-01-01T23:30:00Z" }, end: { dateTime: "2099-01-02T00:00:00Z" } }] : [],
    loaded: true, loading: false, error: null, refresh: () => {} };
}
let domain: Record<string, unknown> = { _private: { tasks: [] } };
export const PersonalKnowledgeModelService = {
  loadDomainData: async () => domain,
};
export const PkmWriteCoordinator = {
  async saveMergedDomain(options: {
    build: (
      context: unknown,
    ) => Promise<{ domainData: Record<string, unknown> }>;
  }) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (state.failSave)
      return { success: false, saveState: "failed", fullBlob: {} };
    const plan = await options.build({ currentDomainData: domain });
    domain = plan.domainData;
    return { success: true, saveState: "saved", fullBlob: {} };
  },
};
export const morphyToast = {
  error: (message: string) => change({ message }),
  promise: (
    operation: Promise<unknown>,
    copy: { success: string; error: string },
  ) => {
    void operation.then(
      () => change({ message: copy.success }),
      () => change({ message: copy.error }),
    );
  },
};
export function AppPageShell({ children, ...props }: { children: ReactNode; [key: string]: unknown }) {
  return <main {...props} className="app-page-shell p-4">{children}</main>;
}
export function AppPageHeaderRegion({ children }: { children: ReactNode }) {
  return <header>{children}</header>;
}
export function AppPageContentRegion({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}
export default function Link({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        history.pushState({}, "", href!);
        change({ href: href! });
      }}
    >
      {children}
    </a>
  );
}
