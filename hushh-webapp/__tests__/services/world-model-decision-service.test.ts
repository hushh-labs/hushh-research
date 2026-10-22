// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getStaleFirst, savePreparedDomain } = vi.hoisted(() => ({
  getStaleFirst: vi.fn(),
  savePreparedDomain: vi.fn(),
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { lookupMutationCommits: vi.fn() },
}));
vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {},
}));
vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  SecureDurableResourceService: {},
  subscribeDurableOwnerReset: () => () => {},
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { savePreparedDomain },
}));

import {
  clearMarkdownMemory,
  markdownMemoryToAgentContext,
  peekMarkdownMemory,
} from "@/lib/pkm/markdown-memory";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  WorldModelDecisionService,
  pwmClaimKey,
} from "@/lib/services/world-model-decision-service";

const owner = { userId: "user-1", vaultKey: "key", vaultOwnerToken: "token" };
let cloud: Record<string, unknown> | null;

beforeEach(() => {
  publishValidatedAuthSessionOwner("user-1");
  cloud = { markdown: "# memory.md\n\n## Facts\n- I live in Boston.\n" };
  getStaleFirst.mockImplementation(async () =>
    cloud ? { data: cloud } : null,
  );
  savePreparedDomain.mockImplementation(async (params) => {
    const plan = await params.build({ currentDomainData: cloud });
    cloud = plan.domainData;
    return { success: true };
  });
});
afterEach(() => {
  clearMarkdownMemory();
  publishValidatedAuthSessionOwner(null);
  vi.clearAllMocks();
});

const bullets = (text: string) =>
  String(cloud?.markdown)
    .split("\n")
    .filter((line) => line === `- ${text}`);

describe("PWM owner decisions in encrypted memory", () => {
  it("saves the exact statement only after the encrypted commit resolves", async () => {
    let release!: () => void;
    savePreparedDomain.mockImplementationOnce(async (params) => {
      const plan = await params.build({ currentDomainData: cloud });
      await new Promise<void>((resolve) => (release = resolve));
      cloud = plan.domainData;
      return { success: true };
    });
    let settled = false;
    const confirming = WorldModelDecisionService.confirm({
      ...owner,
      statement: "Alice leads the robotics club.",
      topic: "community",
    }).then((memory) => {
      settled = true;
      return memory;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    const memory = await confirming;
    const key = await pwmClaimKey("Alice leads the robotics club.");
    expect(bullets("Alice leads the robotics club.")).toHaveLength(1);
    expect(memory.saved.map((claim) => claim.key)).toEqual([key]);
    expect(memory.claims[key]).toMatchObject({
      decision: "accepted",
      text: "Alice leads the robotics club.",
      basis: "owner_declaration",
    });
    expect(savePreparedDomain.mock.calls[0][0].confirmation).toEqual({
      confirmedByUser: true,
      surface: "web",
      source: "pwm_owner_review",
    });
  });

  it("rejects and reports nothing saved when the commit fails", async () => {
    savePreparedDomain.mockImplementation(async (params) => {
      await params.build({ currentDomainData: cloud });
      return { success: false, message: "offline" };
    });
    await expect(
      WorldModelDecisionService.confirm({
        ...owner,
        statement: "Alice leads the robotics club.",
        topic: "community",
      }),
    ).rejects.toThrow();
    const memory = await WorldModelDecisionService.load(owner);
    expect(memory.saved).toEqual([]);
    expect(Object.values(memory.claims)).toEqual([]);
    expect(String(cloud?.markdown)).not.toContain("robotics");
  });

  it("remembers a rejection without writing any bullet or opposite", async () => {
    const before = String(cloud?.markdown);
    const memory = await WorldModelDecisionService.reject({
      ...owner,
      statement: "Alice likes blue.",
      topic: "style",
    });
    const key = await pwmClaimKey("Alice likes blue.");
    expect(cloud?.markdown).toBe(before);
    expect(memory.decidedKeys.has(key)).toBe(true);
    expect(memory.claims[key]?.decision).toBe("rejected");
    expect(WorldModelDecisionService.ownerDecisions(memory)).toEqual({
      confirmed: [],
      rejected: ["Alice likes blue."],
    });
    const context = markdownMemoryToAgentContext(peekMarkdownMemory("user-1")!);
    expect(context.text).not.toMatch(/blue/i);
  });

  it("carries every No from a full 269-statement draft into the next research request", () => {
    const claims = Object.fromEntries(
      Array.from({ length: 269 }, (_, index) => [
        `key-${index}`,
        {
          text: `Rejected statement ${index}`,
          decision: "rejected",
          decided_at: new Date(2026, 0, 1, 0, index).toISOString(),
        },
      ]),
    );
    const decisions = WorldModelDecisionService.ownerDecisions({
      claims,
      saved: [],
      decidedKeys: new Set(),
    } as unknown as Parameters<typeof WorldModelDecisionService.ownerDecisions>[0]);
    expect(decisions.rejected).toHaveLength(269);
    expect(decisions.rejected).toContain("Rejected statement 0");
  });

  it("keeps only the corrected wording after an edit", async () => {
    await WorldModelDecisionService.confirm({
      ...owner,
      statement: "Alice works at Acme.",
      topic: "career",
    });
    const key = await pwmClaimKey("Alice works at Acme.");
    const memory = await WorldModelDecisionService.edit({
      ...owner,
      claimKey: key,
      text: "Alice works at Acme Robotics.",
      topic: "career",
    });
    expect(bullets("Alice works at Acme.")).toHaveLength(0);
    expect(bullets("Alice works at Acme Robotics.")).toHaveLength(1);
    expect(memory.saved.map((claim) => claim.text)).toEqual([
      "Alice works at Acme Robotics.",
    ]);
    expect(memory.decidedKeys.has(key)).toBe(true);
  });

  it("keeps a removed statement suppressed after a fresh sign-in", async () => {
    await WorldModelDecisionService.confirm({
      ...owner,
      statement: "Alice runs marathons.",
      topic: "interests",
    });
    const key = await pwmClaimKey("Alice runs marathons.");
    await WorldModelDecisionService.remove({ ...owner, claimKey: key });
    expect(bullets("Alice runs marathons.")).toHaveLength(0);
    clearMarkdownMemory();
    const memory = await WorldModelDecisionService.load(owner);
    expect(memory.saved).toEqual([]);
    expect(memory.decidedKeys.has(key)).toBe(true);
    expect(memory.claims[key]?.decision).toBe("removed");
  });

  it("does not duplicate a repeated Yes", async () => {
    const input = {
      ...owner,
      statement: "Alice speaks Spanish.",
      topic: "personal" as const,
    };
    await WorldModelDecisionService.confirm(input);
    await WorldModelDecisionService.confirm(input);
    expect(bullets("Alice speaks Spanish.")).toHaveLength(1);
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
  });

  it("refuses a No decided on a stale view of a newer Yes", async () => {
    const statement = "Alice leads the robotics club.";
    const key = await pwmClaimKey(statement);
    // This device read memory before another tab or tap saved a Yes.
    await WorldModelDecisionService.load(owner);
    cloud = {
      markdown: `# memory.md\n\n## Facts\n- I live in Boston.\n- ${statement}\n`,
      _pwm_claims: {
        [key]: {
          key,
          decision: "accepted",
          text: statement,
          topic: "community",
          decided_at: "2026-10-15T04:00:00.000Z",
          basis: "owner_declaration",
        },
      },
    };
    await expect(
      WorldModelDecisionService.reject({ ...owner, statement, topic: "community" }),
    ).rejects.toThrow("Your memory wasn't updated. Try again.");
    // The newer Yes and its bullet survive; nothing is left half-applied.
    expect(bullets(statement)).toHaveLength(1);
    const claims = cloud?._pwm_claims as Record<string, { decision: string }>;
    expect(claims[key]?.decision).toBe("accepted");
  });
});
