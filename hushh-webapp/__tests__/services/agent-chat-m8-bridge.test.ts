import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import {
  clearFilesCache,
  peekFilesListCache,
  setFilesListCache,
} from "@/lib/files/files-cache";

const aguiState = vi.hoisted(() => ({
  runAgentImpl: vi.fn(),
  abortRun: vi.fn(),
  setMessages: vi.fn(),
}));

vi.mock("@ag-ui/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ag-ui/client")>();
  class MockHttpAgent {
    middlewares: unknown[] = [];
    use(mw: unknown) {
      this.middlewares.push(mw);
      return this;
    }
    setMessages(messages: unknown[]) {
      aguiState.setMessages(messages);
    }
    abortRun() {
      aguiState.abortRun();
    }
    async runAgent(params: unknown, subscriber: Record<string, (args: unknown) => unknown>) {
      return aguiState.runAgentImpl(params, subscriber);
    }
  }
  return { ...actual, HttpAgent: MockHttpAgent };
});

vi.mock("@/lib/agent/one-chat-transport", () => ({
  wakingChatTransport: vi.fn(),
}));

vi.mock("@/lib/kai/plaid-vault/agent-turn-nws", () => ({
  loadAgentTurnFinancialProjection: vi.fn().mockResolvedValue({
    nwsReport: null,
    plaidPosture: "",
  }),
}));

import { streamAgentChat } from "@/lib/services/agent-chat-client";
import { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import type { ComputerUseBinding, ComputerUseSnapshot, ComputerUseTransport } from "@/lib/computer-use/contracts";
import { ApiService } from "@/lib/services/api-service";

const OWNER_ID = "owner-m8-bridge";
const VAULT_KEY = "a".repeat(64);
const VAULT_TOKEN = "vault-owner-token";

async function runWithFakeTimersUntilSettled<T>(
  work: Promise<T>,
  options: { maxRealWaitMs?: number; maxFakeAdvanceMs?: number; stepMs?: number } = {},
): Promise<T> {
  const maxRealWaitMs = options.maxRealWaitMs ?? 4_000;
  const maxFakeAdvanceMs = options.maxFakeAdvanceMs ?? 10_000;
  const stepMs = options.stepMs ?? 100;
  let settled = false;
  const tracked = work.finally(() => {
    settled = true;
  });
  const startedAtRealMs = vi.getRealSystemTime();
  let fakeAdvancedMs = 0;

  while (!settled) {
    if (vi.getTimerCount() > 0) {
      if (fakeAdvancedMs >= maxFakeAdvanceMs) {
        throw new Error(
          `Timed out advancing fake timers (${fakeAdvancedMs}ms simulated) before stream settled.`,
        );
      }
      await vi.advanceTimersByTimeAsync(stepMs);
      fakeAdvancedMs += stepMs;
    } else {
      if (vi.getRealSystemTime() - startedAtRealMs >= maxRealWaitMs) {
        throw new Error(
          `Stream did not settle or schedule timers within ${maxRealWaitMs}ms real time.`,
        );
      }
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  return tracked;
}

describe("Milestone 8 agent chat and files cache bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFilesCache(OWNER_ID);
    publishValidatedAuthSessionPrincipal({
      firebaseUid: OWNER_ID,
      ownerId: OWNER_ID,
      accountGeneration: 0,
    });
    vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({
      hostingMode: "shared",
      state: "none",
    } as never);
    vi.spyOn(ApiService, "apiFetch").mockImplementation(async () => Response.json({}));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers all Private Files tools in SERVER_TOOL_PRESENTATION with exact 4-line entries", () => {
    const sourcePath = path.resolve(process.cwd(), "lib/services/agent-chat-client.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    const blockMatch = source.match(/const SERVER_TOOL_PRESENTATION[\s\S]*?\n\};/);
    expect(blockMatch).toBeTruthy();
    const block = blockMatch![0];
    for (const toolName of [
      "files",
      "search_files",
      "read_file",
      "write_file",
      "create_folder",
      "organize_file",
      "propose_file_schedule",
    ]) {
      const entryRegex = new RegExp(
        `^  ${toolName}: \\{\\n    label: "[^"]+",\\n    message: "[^"]+",\\n    activity: "[^"]+",\\n  \\},$`,
        "m",
      );
      expect(block).toMatch(entryRegex);
    }
  });

  it.each(["create_folder", "organize_file", "write_file", "optimize_personal_memory", "files"])(
    "invalidates /one/files cache when %s completes without error",
    async (toolName) => {
      setFilesListCache(OWNER_ID, "root", "", false, {
        entries: [
          {
            id: "f-old",
            name: "stale.txt",
            originalName: "stale.txt",
            parent: "root",
            kind: "file",
            size: 10,
            received: 10,
            receivedHash: "0".repeat(64),
            state: "ready",
            revision: 1,
          },
        ],
        cursor: "",
        chunkBytes: 4096,
      });
      expect(peekFilesListCache(OWNER_ID, "root", "", false)).not.toBeNull();

      aguiState.runAgentImpl.mockImplementationOnce(async (_params, sub) => {
        sub.onRunStartedEvent?.({});
        sub.onToolCallStartEvent?.({ event: { toolCallId: "call-1", toolCallName: toolName } });
        sub.onToolCallResultEvent?.({
          event: { toolCallId: "call-1", content: JSON.stringify({ status: "ok" }) },
        });
        sub.onRunFinishedEvent?.({ outcome: "success", result: {} });
      });

      await streamAgentChat({
        userId: OWNER_ID,
        message: "Organize my files",
        vaultOwnerToken: VAULT_TOKEN,
        vaultKey: VAULT_KEY,
        loadConnectorConfigurations: async () => [],
      });

      expect(peekFilesListCache(OWNER_ID, "root", "", false)).toBeNull();
    },
  );

  it("retries transient POD_CHAT_BUSY with bounded backoff before failing", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const onError = vi.fn();
      const onToken = vi.fn();

      aguiState.runAgentImpl.mockImplementation(async (_params, sub) => {
        attempt += 1;
        if (attempt <= 2) {
          sub.onRunErrorEvent?.({
            event: { code: "POD_CHAT_BUSY", message: "Pod is finishing prior run." },
          });
          return;
        }
        sub.onRunStartedEvent?.({});
        sub.onTextMessageContentEvent?.({ event: { delta: "Recovered after retry." } });
        sub.onRunFinishedEvent?.({ outcome: "success", result: {} });
      });

      const result = await runWithFakeTimersUntilSettled(
        streamAgentChat({
          userId: OWNER_ID,
          message: "Follow up immediately",
          vaultOwnerToken: VAULT_TOKEN,
          vaultKey: VAULT_KEY,
          loadConnectorConfigurations: async () => [],
          handlers: { onError, onToken },
        }),
      );

      expect(attempt).toBe(3);
      expect(onError).not.toHaveBeenCalled();
      expect(onToken).toHaveBeenCalledWith("Recovered after retry.");
      expect(result.text).toBe("Recovered after retry.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces POD_CHAT_BUSY error cleanly once bounded retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const onError = vi.fn();
      aguiState.runAgentImpl.mockImplementation(async (_params, sub) => {
        attempt += 1;
        sub.onRunErrorEvent?.({
          event: { code: "POD_CHAT_BUSY", message: "Still busy" },
        });
      });

      const err = await runWithFakeTimersUntilSettled(
        streamAgentChat({
          userId: OWNER_ID,
          message: "Still busy check",
          vaultOwnerToken: VAULT_TOKEN,
          vaultKey: VAULT_KEY,
          loadConnectorConfigurations: async () => [],
          handlers: { onError },
        }).catch((err: Error) => err),
      );
      expect(err).toBeInstanceOf(Error);
      expect(attempt).toBe(4);
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates /one/files cache after ComputerUseTaskController.saveDownload", async () => {
    setFilesListCache(OWNER_ID, "root", "", false, {
      entries: [],
      cursor: "",
      chunkBytes: 4096,
    });
    expect(peekFilesListCache(OWNER_ID, "root", "", false)).not.toBeNull();

    const binding: ComputerUseBinding = {
      ownerId: OWNER_ID,
      podOrigin: "https://pod.example",
      taskId: "task-dl-1",
      vaultOwnerToken: VAULT_TOKEN,
      isCurrent: () => true,
    };
    const snapshot: ComputerUseSnapshot = {
      binding: {
        ownerId: OWNER_ID,
        podOrigin: "https://pod.example",
        taskId: "task-dl-1",
      },
      taskId: "task-dl-1",
      state: "paused",
      target: "shared",
      url: "https://example.com",
      title: "Example",
      viewport: { width: 1280, height: 720 },
      control: "app",
      controlEpoch: 1,
      nextSequence: 1,
      revision: 1,
      stepCount: 1,
      stepBudget: 25,
      downloads: [
        {
          id: "dl-1",
          name: "statement.pdf",
          size: 42,
          sha256: "b".repeat(64),
        },
      ],
    } as unknown as ComputerUseSnapshot;
    const transport: ComputerUseTransport = {
      read: vi.fn().mockResolvedValue(snapshot),
      control: vi.fn().mockResolvedValue(snapshot),
      input: vi.fn().mockResolvedValue(snapshot),
      saveDownload: vi.fn().mockResolvedValue({
        fileId: "file-saved-1",
        bytes: 42,
        sha256: "b".repeat(64),
      }),
    };

    const controller = new ComputerUseTaskController(binding, transport);
    await controller.refresh();
    const saved = await controller.saveDownload("dl-1");
    expect(saved.fileId).toBe("file-saved-1");
    expect(peekFilesListCache(OWNER_ID, "root", "", false)).toBeNull();
  });

  it("clears activeToolCalls across terminal stream paths in agent-chat-workspace", () => {
    const workspacePath = path.resolve(
      process.cwd(),
      "components/agent/agent-chat-workspace.tsx",
    );
    const source = fs.readFileSync(workspacePath, "utf8");
    const stopMatches = source.match(/setActiveToolCalls\(\[\]\)/g) ?? [];
    expect(stopMatches.length).toBeGreaterThanOrEqual(10);
  });
});
