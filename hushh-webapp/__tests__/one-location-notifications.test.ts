import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the background-task store so the notification helpers run without the
// real (sessionStorage-backed) implementation. We only need to confirm the
// persistent de-dup + unwatch logic in notifications.ts.
interface MockTask {
  taskId: string;
  routeHref: string | null;
  dismissedAt: string | null;
}
const tasks = new Map<string, MockTask>();

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    getTask: (taskId: string) => tasks.get(taskId) ?? null,
    startTask: (params: { taskId: string; routeHref?: string | null }) => {
      tasks.set(params.taskId, {
        taskId: params.taskId,
        routeHref: params.routeHref ?? null,
        dismissedAt: null,
      });
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
  buildOneLocationWorkflowHref,
  hasSeenOneLocationNotification,
  isOneLocationGrantUnwatched,
  locationShareNotificationCopy,
  markOneLocationGrantOpened,
  markOneLocationGrantUnwatched,
  oneLocationSectionForWorkflowNotificationType,
  recordOneLocationShareNotification,
  recordOneLocationWorkflowNotification,
  privacySafeOneLocationNotificationBody,
  privacySafeOneLocationNotificationLabel,
  resolveOneLocationNotificationHref,
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

describe("One-Location notification privacy", () => {
  it("uses the exact name-only copy for a plain location share", () => {
    expect(locationShareNotificationCopy({ ownerLabel: "hushh Social" })).toEqual({
      title: "Location shared",
      description: "hushh Social shared location access with you.",
    });
  });

  it("removes legacy masked-phone suffixes from labels and bodies", () => {
    expect(
      privacySafeOneLocationNotificationLabel("hushh Social - ********8014"),
    ).toBe("hushh Social");
    expect(
      privacySafeOneLocationNotificationBody(
        "hushh Social - ********8014 shared location access with you.",
        "A trusted person shared location access with you.",
      ),
    ).toBe("hushh Social shared location access with you.");
  });

  it("uses a generic fallback when a legacy label is only a masked phone", () => {
    expect(privacySafeOneLocationNotificationLabel("********8014")).toBe(
      "A trusted person",
    );
    expect(
      privacySafeOneLocationNotificationBody(
        "********8014 shared location access with you.",
        "A trusted person shared location access with you.",
      ),
    ).toBe("A trusted person shared location access with you.");
  });
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

describe("One-Location notification surfaces (bell + consent)", () => {
  const CONSENT_EVENT = "consent-state-changed";

  it("creates a bell task with a 'shared' deep-link AND a consent refresh for a share", () => {
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
      // Routed to the consent surface (shield icon + consent manager)...
      expect(events.length).toBe(1);
      // ...AND surfaced in the bell with an "Open" deep-link into the
      // recipient's "Shared with me" section so it is reachable from the bell.
      expect(tasks.size).toBe(1);
      const task = tasks.get("one_location_share:grant_routing_1");
      expect(task).toBeTruthy();
      expect(task?.routeHref).toContain("/one/location");
      expect(task?.routeHref).toContain("grantId=grant_routing_1");
      expect(task?.routeHref).toContain("section=shared");
    } finally {
      window.removeEventListener(CONSENT_EVENT, handler);
    }
  });

  it("creates a bell task AND a consent refresh for a workflow (approve/deny/request) event", () => {
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
        routeHref: "/one/location?requestId=req_routing_1&section=approvals",
      });
      expect(created).toBe(true);
      expect(events.length).toBe(1);
      expect(tasks.size).toBe(1);
      const task = tasks.get(
        "one_location_workflow:location_access_request:req_routing_1",
      );
      expect(task).toBeTruthy();
      expect(task?.routeHref).toBe(
        "/one/location?requestId=req_routing_1&section=approvals",
      );
    } finally {
      window.removeEventListener(CONSENT_EVENT, handler);
    }
  });
});


describe("One-Location workflow deep-link sections", () => {
  it("routes an access request to the Inbox 'Needs your review' (approvals) section", () => {
    const section = oneLocationSectionForWorkflowNotificationType(
      "location_access_request",
    );
    expect(section).toBe("approvals");

    const href = buildOneLocationWorkflowHref({
      requestId: "req_xyz",
      section,
    });
    expect(href).toContain("/one/location");
    expect(href).toContain("requestId=req_xyz");
    expect(href).toContain("section=approvals");
  });

  it("maps each workflow type to its owning section", () => {
    expect(oneLocationSectionForWorkflowNotificationType("location_access_approved")).toBe("shared");
    expect(oneLocationSectionForWorkflowNotificationType("location_access_denied")).toBe("my_requests");
    expect(oneLocationSectionForWorkflowNotificationType("location_public_invite_submitted")).toBe("public_responses");
    expect(oneLocationSectionForWorkflowNotificationType("location_one_network_joined")).toBe("people");
  });
});

describe("One-Location native notification routing", () => {
  it("keeps a relative request URL and all routing parameters", () => {
    expect(
      resolveOneLocationNotificationHref({
        request_url:
          "/one/location?grantId=grant_1&section=shared&notification=open",
      }),
    ).toBe(
      "/one/location?grantId=grant_1&section=shared&notification=open",
    );
  });

  it("normalizes an absolute app URL into an internal native route", () => {
    expect(
      resolveOneLocationNotificationHref({
        request_url:
          "https://uat.one.hushh.ai/one/location?requestId=req_1&section=approvals",
      }),
    ).toBe("/one/location?requestId=req_1&section=approvals");
  });

  it("falls back to a valid deep link when request_url is unrelated", () => {
    expect(
      resolveOneLocationNotificationHref({
        request_url: "https://example.com/account",
        deep_link: "/one/location?submissionId=sub_1&section=public_responses",
      }),
    ).toBe(
      "/one/location?submissionId=sub_1&section=public_responses",
    );
  });

  it("uses the Location hub for malformed or unsafe payload URLs", () => {
    expect(
      resolveOneLocationNotificationHref({
        request_url: "javascript:alert(1)",
        deep_link: "//example.com/one/location",
      }),
    ).toBe("/one/location");
  });
});

describe("One-Location share notification copy", () => {
  it("preserves drive-share intent during state reconciliation", () => {
    expect(
      locationShareNotificationCopy({
        ownerLabel: "Alex",
        shareKind: "drive_to",
      }),
    ).toEqual({
      title: "Drive shared",
      description: "Alex started sharing their drive and live ETA with you.",
    });
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

describe("One-Location opened-share suppression", () => {
  it("does not recreate a popup/bell entry after the share was opened", () => {
    markOneLocationGrantOpened(USER, GRANT);
    expect(
      recordOneLocationShareNotification({
        userId: USER,
        grantId: GRANT,
        ownerLabel: "Alex",
      }),
    ).toBe(false);
    expect(tasks.size).toBe(0);
  });
});
