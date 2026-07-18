import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs
    .readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("AgentChatWorkspace", () => {
  it("covers streaming message live region", async () => {
    const { AgentChatWorkspace } = await import(
      "@/components/agent/agent-chat-workspace"
    );
    const source = read("components/agent/agent-chat-workspace.tsx");

    expect(AgentChatWorkspace).toEqual(expect.any(Function));
    expect(source).toContain('const isUser = message.role === "user";');
    expect(source).toContain('const isStreaming = message.status === "streaming";');
    expect(source).toContain(
      'aria-live={!isUser && isStreaming ? "polite" : undefined}',
    );
    expect(source).toContain("const showStreamingAffordance = !isUser && animated.isAnimating;");
    expect(source).toContain("<StreamingCursor");
    expect(source).toContain("isStreaming={isStreaming}");
  });
});
