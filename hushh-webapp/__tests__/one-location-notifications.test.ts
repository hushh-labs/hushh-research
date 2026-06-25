import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the background-task store so the notification helpers run without the
// real (sessionStorage-backed) implementation. We only need to confirm the
// persistent de-dup + unwatch logic in notifications.ts.
const tasks = new Map<string, { taskId: string; dismissedAt: string | null }>();

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    getTask: (taskId: string) => tasks.get(taskId) ?? null,
    startTask: (params: { taskId: string }) => {
      tasks.set(params.taskId, { taskId: params.taskId, dismissedAt: null });
      return params.taskId;
    },
    completeTask: () => undefined,
    dismissTask: (taskId: string) => {
      const existing = tasks.get(taskId);
      if (existing) existing.dismissedAt = new Date().toISOString();
    },
  },
}));

import {
  hasSeenOneLocationNotification,
  isOneLocationGrantUnwatched,
  markOneLocationGrantUnwatched,
  recordOneLocationShareNotification,
  recordOneLocationWorkflowNotification,
} from "@/lib/one-location/notifications";

const USER = "user_recipient_1";
const GRANT = "grant_abc";

beforeEach(() => {
  tasks.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("One-Location persistent notification de-dup", () => {
  it("creates a share notification only once, even after the task is dismissed (refresh)", () => {
    const first = recordOneLocationShareNotification({
      userId: USER,
      grantId: GRANT,
      ownerLabel: "Alex",
    });
    expect(first).toBe(true);
    expect(hasSeenOneLocationNotification(USER, `share:${GRANT}`)).toBe(true);

    // Simulate dismiss + page refresh (sessionStorage task store forgets it).
    tasks.clear();

    const second = recordOneLocationShareNotification({
      userId: USER,
      grantId: GRANT,
      ownerLabel: "Alex",
    });
    // The persistent seen-set must block the duplicate.
    expect(second).toBe(false);
  });

  it("does not re-create a workflow notification for the same (type,id) after refresh", () => {
    const params = {
      userId: USER,
      notificationType: "location_share_revoked" as const,
      id: GRANT,
      title: "Location access removed",
      description: "Alex removed your location access.",
    };
    expect(recordOneLocationWorkflowNotification(params)).toBe(true);

    tasks.clear(); // refresh

    expect(recordOneLocationWorkflowNotification(params)).toBe(false);
  });
});

describe("One-Location consent-surface routing (not the general bell)", () => {
  const CONSENT_EVENT = "consent-state-changed";

  it("dispatches a consent refresh and does NOT create a bell task for a share", () => {
    const events: string[] = [];
    const handler = () => events.push("consent");
    window.addEventListener(CONSENT_EVENT, handler);
    try {
      const created = recordOneLocationShareNotification({
        userId: "user_routing_1",
        grantId: "grant_routing_1",
        ownerLabel: "Alex",
      });
      expect(created).toBe(true);
      // Routed to the consent surface...
      expect(events.length).toBe(1);
      // ...and NOT written to the general bell (AppBackgroundTaskService).
      expect(tasks.size).toBe(0);
    } finally {
      window.removeEventListener(CONSENT_EVENT, handler);
    }
  });

  it("dispatches a consent refresh for a workflow (approve/deny/request) event", () => {
    const events: string[] = [];
    const handler = () => events.push("consent");
    window.addEventListener(CONSENT_EVENT, handler);
    try {
      const created = recordOneLocationWorkflowNotification({
        userId: "user_routing_2",
        notificationType: "location_access_request",
        id: "req_routing_1",
        title: "Location request",
        description: "Someone is asking to view your location.",
      });
      expect(created).toBe(true);
      expect(events.length).toBe(1);
      expect(tasks.size).toBe(0);
    } finally {
      window.removeEventListener(CONSENT_EVENT, handler);
    }
  });
});

describe("One-Location unwatch", () => {
  it("hides a grant and suppresses its share notification", () => {
    expect(isOneLocationGrantUnwatched(USER, GRANT)).toBe(false);
    markOneLocationGrantUnwatched(USER, GRANT);
    expect(isOneLocationGrantUnwatched(USER, GRANT)).toBe(true);

    // An unwatched grant must never produce a share notification.
    const created = recordOneLocationShareNotification({
      userId: USER,
      grantId: GRANT,
      ownerLabel: "Alex",
    });
    expect(created).toBe(false);
  });

  it("persists the unwatch choice across reloads (localStorage)", () => {
    markOneLocationGrantUnwatched(USER, GRANT);
    // A fresh read (no in-memory state) still reports unwatched.
    expect(isOneLocationGrantUnwatched(USER, GRANT)).toBe(true);
  });
});
