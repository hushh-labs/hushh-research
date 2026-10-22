/**
 * An own-cloud person's words never reach the hub.
 *
 * Before unlock, the agent bar used to send every typed message to the hub's public
 * intro tier, even for a person whose private agent runs in their own cloud. Their
 * chat is browser to agent, so the intro answers them on this device instead. The
 * old hub turn and close relays have no client at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: null as string | null,
  pinned: null as unknown,
  hosting: vi.fn(),
  agents: [] as Array<{ url: string }>,
  streamFetch: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => (state.uid ? { uid: state.uid } : null) },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: async () => state.pinned,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: () => state.hosting() },
}));
vi.mock("@/lib/services/native-sse-fetch", () => ({ nativeStreamFetch: state.streamFetch }));
vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(config: { url: string }) {
      state.agents.push(config);
    }
    abortRun() {}
    async runAgent(_parameters: unknown, subscriber: Record<string, (input: unknown) => void>) {
      subscriber.onRunStartedEvent?.({ event: { type: "RUN_STARTED" } });
      subscriber.onTextMessageContentEvent?.({ event: { delta: "Hello" } });
      subscriber.onRunFinishedEvent?.({ event: { type: "RUN_FINISHED" } });
    }
  },
}));

import { introMayReachHub } from "@/lib/services/pod-app-access";
import { PRIVATE_AGENT_INTRO_REPLY, streamAgentIntro } from "@/lib/services/agent-chat-client";

beforeEach(() => {
  state.uid = "owner";
  state.pinned = null;
  state.agents = [];
  state.hosting.mockReset();
  state.streamFetch.mockReset();
});

describe("introMayReachHub", () => {
  it("lets an anonymous visitor use the public tier without reading hosting", async () => {
    state.uid = null;
    await expect(introMayReachHub(state.hosting)).resolves.toBe(true);
    expect(state.hosting).not.toHaveBeenCalled();
  });

  it("keeps a pinned private agent's words on this device", async () => {
    state.pinned = { hushhId: "ha1_owner" };
    await expect(introMayReachHub(state.hosting)).resolves.toBe(false);
    expect(state.hosting).not.toHaveBeenCalled();
  });

  it.each([
    ["byoc", false],
    ["pending", false],
    ["unknown", false],
    [undefined, false],
    ["shared", true],
    ["hussh_pods", true],
  ])("hosting %s may reach the hub: %s", async (hostingMode, expected) => {
    state.hosting.mockResolvedValue({ hostingMode });
    await expect(introMayReachHub(state.hosting)).resolves.toBe(expected);
  });

  it("fails closed when hosting cannot be read", async () => {
    state.hosting.mockRejectedValue(new Error("AGENT_STATUS_UNAVAILABLE:503"));
    await expect(introMayReachHub(state.hosting)).resolves.toBe(false);
  });
});

describe("streamAgentIntro", () => {
  it("answers an own-cloud person on this device and never dials the hub", async () => {
    state.hosting.mockResolvedValue({ hostingMode: "byoc" });
    const onToken = vi.fn();
    const onComplete = vi.fn();

    const result = await streamAgentIntro({
      message: "my private words",
      handlers: { onToken, onComplete },
    });

    expect(result).toEqual({ conversationId: null, model: null, text: PRIVATE_AGENT_INTRO_REPLY });
    expect(onToken).toHaveBeenCalledWith(PRIVATE_AGENT_INTRO_REPLY);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(state.agents).toEqual([]);
    expect(state.streamFetch).not.toHaveBeenCalled();
  });

  it("still uses the public tier for a Shared person", async () => {
    state.hosting.mockResolvedValue({ hostingMode: "shared" });
    const result = await streamAgentIntro({ message: "What is Hussh?" });
    expect(result.text).toBe("Hello");
    expect(state.agents.map((agent) => agent.url)).toEqual(["/api/one/agent-chat"]);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the hub turn relay has no client", () => {
  it("no webapp source composes /api/one/u/{id}/turn or its close door", () => {
    const root = join(__dirname, "..", "..");
    const door = /\/api\/one\/u\/\$\{[^}]*\}\/(?:turn\b|conversation\/)/;
    const offenders = ["lib", "components", "app", "hooks"]
      .flatMap((dir) => sources(join(root, dir)))
      .filter((path) => door.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
