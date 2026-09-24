import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionChip } from "@/components/agent/selection-chip";
import {
  mergePendingConsentMessages,
  storedMessageToAgentMessage,
  storedMessagesToAgentMessages,
  upsertAgentStructuredExperience,
} from "@/components/agent/agent-chat-workspace";
import type { AgentChatMessage } from "@/lib/services/agent-chat-client";

// History mapping is the load-bearing behavior: on reload a persisted selection
// must become a chip (kind:"selection") showing the clean display label, never
// the raw `I selected:` seed. These tests exercise the real mapping helper the
// workspace uses to hydrate history.
describe("storedMessageToAgentMessage — selection history mapping", () => {
  it("retains the validated Mail receipt on reload without tool text", () => {
    const receipt = { type: "one.connector_read.v1" as const, connector: "mail" as const,
      status: "ok" as const, sourceRefs: ["mail:1"], metadataOnly: true as const, truncated: false };
    const mapped = storedMessageToAgentMessage({ id: "a", conversation_id: "c", role: "assistant",
      status: "complete", content: "Saved answer", metadata: { connectorRead: receipt } });
    expect(mapped?.structuredExperience).toEqual(receipt);
  });
  const base = {
    id: "m1",
    conversation_id: "c1",
    status: "complete" as const,
    created_at: null,
    completed_at: null,
  };

  it("maps a selection message to a chip using metadata.display, not the raw seed", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content: "I selected: {recipientKeyId:abc123}",
      metadata: { kind: "selection", display: "Abdul Zalil" },
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped).not.toBeNull();
    expect(mapped?.kind).toBe("selection");
    expect(mapped?.text).toBe("Abdul Zalil");
    expect(mapped?.text).not.toContain("I selected:");
  });

  it("does not treat plain assistant/user messages as selection chips", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "assistant",
      content: "Here is your answer.",
      metadata: null,
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.kind).toBeUndefined();
    expect(mapped?.text).toBe("Here is your answer.");
  });

  it("falls back gracefully to content when a selection lacks a display label", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content: "Cancelled",
      metadata: { kind: "selection" },
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.kind).toBe("selection");
    expect(mapped?.text).toBe("Cancelled");
  });

  it("drops non user/assistant roles", () => {
    const stored = {
      ...base,
      role: "system",
      content: "system prompt",
      metadata: null,
    } as unknown as AgentChatMessage;
    expect(storedMessageToAgentMessage(stored)).toBeNull();
  });

  // Fix 1: legacy-row safety-net — raw selection seed with no metadata
  it("maps legacy raw selection seed (no metadata) to a selection chip with generic label", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content:
        "I selected: recipientUserId=u_abc123; recipientKeyId=k_xyz789. Use exactly these ids — do not guess — and proceed.",
      metadata: null,
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped).not.toBeNull();
    expect(mapped?.kind).toBe("selection");
    expect(mapped?.text).toBe("Your selection");
    expect(mapped?.text).not.toContain("I selected:");
    expect(mapped?.text).not.toContain("recipientUserId");
    expect(mapped?.text).not.toContain("do not guess");
  });

  it("does not reclassify a normal user message (hello) as a selection", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content: "hello",
      metadata: null,
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.kind).toBeUndefined();
    expect(mapped?.text).toBe("hello");
  });

  it("does not reclassify 'Yes, go ahead.' acknowledgement seed as a selection", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "user",
      content: "Yes, go ahead.",
      metadata: null,
    };
    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.kind).toBeUndefined();
    expect(mapped?.text).toBe("Yes, go ahead.");
  });

  it("restores a safe structured card from history metadata without replaying the raw text", () => {
    const stored: AgentChatMessage = {
      ...base,
      role: "assistant",
      content: "I found several things you can request.",
      metadata: {
        kind: "structured_experience",
        structuredExperienceId: "event-discovery-1",
        structuredExperience: {
          activityType: "one.scope_discovery.v1",
          content: {
            status: "ok",
            person: {
              displayName: "Alex Morgan",
              profilePath: "/people/1234567890abcdef",
              relationship: "connected",
            },
            requestableScopes: [
              {
                scopeRef: "attr.professional.employment_status",
                label: "Employment status",
                domain: "professional",
              },
            ],
          },
        },
      },
    };

    const mapped = storedMessageToAgentMessage(stored);
    expect(mapped?.structuredExperiences).toHaveLength(1);
    expect(mapped?.structuredExperiences?.[0]?.id).toBe("event-discovery-1");
    expect(mapped?.structuredExperiences?.[0]?.experience.type).toBe("one.scope_discovery.v1");
    expect(mapped?.text).toBe("I found several things you can request.");
  });
});

describe("ordered retained cards", () => {
  const descriptor = {activityType: "one.scope_discovery.v1", content: {
    status: "ok", person: {displayName: "Alex", profilePath: "/people/1234567890abcdef", relationship: "connected"},
    requestableScopes: [],
  }};
  const message = (id: string, ids: string[], content = ""): AgentChatMessage => ({
    id, conversation_id: "c1", role: "assistant", status: "complete", created_at: null, completed_at: null,
    content, metadata: {structuredExperiences: ids.map(id => ({id, ...descriptor}))},
  });

  it("deduplicates restored IDs within and across messages", () => {
    const result = storedMessagesToAgentMessages([message("m1", [" card-1 ", "card-1"]), message("m2", ["card-1"])]);
    expect(result).toHaveLength(1);
    expect(result[0].structuredExperiences?.map(x => x.id)).toEqual(["card-1"]);
  });
  it("preserves distinct card order and assistant prose", () => {
    const result = storedMessagesToAgentMessages([message("m1", ["c1", "c2"]), message("m2", ["c1", "c3"], "An important warning.")]);
    expect(result.flatMap(x => x.structuredExperiences?.map(y => y.id) || [])).toEqual(["c1", "c2", "c3"]);
    expect(result[1].text).toBe("An important warning.");
  });
  it("does not resurrect duplicates through legacy fallback", () => {
    const duplicate = message("m2", ["c1"]);
    duplicate.metadata = {...duplicate.metadata, structuredExperience: descriptor, structuredExperienceId: "legacy"};
    expect(storedMessagesToAgentMessages([message("m1", ["c1"]), duplicate])).toHaveLength(1);
  });
  it("does not let malformed descriptors reserve an ID", () => {
    const malformed = message("m1", ["c1"]);
    malformed.metadata!.structuredExperiences![0].activityType = "unsupported";
    const result = storedMessagesToAgentMessages([malformed, message("m2", ["c1"])]);
    expect(result.at(-1)?.structuredExperiences?.[0].id).toBe("c1");
  });

  it("restores the submitted metadata-only card after Chat remount", () => {
    const bundleId = "11111111-1111-1111-1111-111111111111";
    const restored = storedMessagesToAgentMessages([{ ...message("receipt-event", [], ""), metadata: {
      structuredExperiences: [{ id: "request_submission_source", activityType: "one.information_request_review.v1", content: {
        direction: "outgoing", phase: "submitted", status: "pending",
        personName: "Synthetic Recipient", purpose: "Synthetic professional review",
        durationLabel: "1 day", subjectRef: "1234567890abcdef", bundleId,
        fields: [{ requestId: "request_12345678", label: "Professional Domain",
          domain: "Information", sensitivity: "standard", status: "pending" }],
      } }],
    } }]);
    expect(restored).toHaveLength(1);
    expect(restored[0].structuredExperiences?.[0].experience).toMatchObject({
      type: "one.information_request_review.v1", phase: "submitted", bundleId,
      subjectRef: "1234567890abcdef",
    });
    expect(JSON.stringify(restored)).not.toContain("decryptedExport");
  });

  it("retains more than eight distinct live cards while revising by identity", () => {
    const first = {
      type: "one.scope_discovery.v1" as const,
      person: {
        displayName: "Alex Morgan",
        profilePath: "/people/profile-1234567890",
        relationship: "Connected",
      },
      domainFilter: null,
      scopes: [],
    };
    const all = Array.from({ length: 9 }, (_, index) =>
      upsertAgentStructuredExperience(
        index === 0
          ? []
          : Array.from({ length: index }, (_, prior) => ({
              id: `card-${prior}`,
              experience: first,
            })),
        `card-${index}`,
        first,
      ),
    ).at(-1);
    expect(all).toHaveLength(9);
    expect(
      upsertAgentStructuredExperience(all ?? [], "card-3", {
        ...first,
        person: { ...first.person, displayName: "Alex Morgan (updated)" },
      }).find((entry) => entry.id === "card-3")?.experience.person.displayName,
    ).toBe("Alex Morgan (updated)");
  });
});

describe("pending consent cards during history restore", () => {
  type WorkspaceMessage = Parameters<typeof mergePendingConsentMessages>[0][number];

  const pendingMessage = (
    id: string,
    requestId: string,
    status: "pending" | "approved" = "pending",
    bundledRequestIds: string[] = [],
  ): WorkspaceMessage => ({
    id,
    role: "assistant",
    text: "Review this request.",
    timestamp: "Just now",
    status: "done",
    specialistDirective: {
      delegateAgentId: "agent_nav",
      directive: {
        kind: "prompt",
        payload: {
          kind: "pending_consent_request",
          item: {
            id: requestId,
            requesterLabel: "Alex Morgan",
            scope: "professional.employment_status",
            status,
            bundledRequestIds,
          },
        },
      },
      message: "Review the request.",
      stateChanged: true,
    },
  });

  it("keeps a live hydrated card when a later history snapshot omits it", () => {
    const live = pendingMessage("live-card", "request-1");
    const merged = mergePendingConsentMessages(
      [{ id: "history-answer", role: "assistant", text: "Earlier answer.", timestamp: "Earlier", status: "done" }],
      [live],
    );
    expect(merged.map((message) => message.id)).toEqual(["history-answer", "live-card"]);
  });

  it("keeps a newer local approval over a stale restored pending card", () => {
    const merged = mergePendingConsentMessages(
      [pendingMessage("history-card", "request-1")],
      [pendingMessage("live-card", "request-1", "approved")],
    );
    expect(merged).toHaveLength(1);
    expect(
      merged[0]?.specialistDirective?.directive.payload.item,
    ).toMatchObject({ id: "request-1", status: "approved" });
  });

  it("matches folded cards by every request id, not only the head id", () => {
    const merged = mergePendingConsentMessages(
      [pendingMessage("history-card", "request-1", "pending", ["request-2"])],
      [pendingMessage("live-card", "request-2", "approved")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("live-card");
  });
});

describe("SelectionChip render branch", () => {
  it("renders a chip for a selection message label", () => {
    render(<SelectionChip label="Abdul Zalil" />);
    const chip = screen.getByTestId("selection-chip");
    expect(chip.textContent).toContain("Abdul Zalil");
  });
});
