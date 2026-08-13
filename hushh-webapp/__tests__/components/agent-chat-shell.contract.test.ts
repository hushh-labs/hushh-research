import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("private-agent chat shell contract", () => {
  it("keeps the floating frame singular and lets the workspace reach its edges", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const popover = read("components/agent/agent-popover-provider.tsx");

    expect(workspace).toContain('"overflow-hidden"');
    expect(workspace).not.toContain('"sm:rounded-lg sm:border sm:border-border sm:shadow-sm"');
    expect(popover).toContain("rounded-[var(--app-card-radius-feature)]");
    expect(popover).toContain("bg-background/95 text-foreground");
  });

  it("uses shared Morphy shell controls and motion in the conversation workspace", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const history = read("components/agent/agent-history-sidebar.tsx");

    expect(workspace).toContain("ShellActionSurface");
    expect(workspace).toContain('"motion-step-enter flex w-full"');
    expect(workspace).not.toContain("animate-in fade-in slide-in-from-bottom-1");
    expect(workspace).toContain("rounded-[var(--app-radius-pill)]");
    expect(history).toContain("bg-foreground/[0.025]");
  });

  it("rotates curated welcome prompts only when a new chat starts", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("getWelcomePromptSetIndex");
    expect(workspace).toContain("getWelcomePrompts");
    expect(workspace).toContain("setWelcomePromptSetIndex((current)");
    expect(workspace).toContain("prompts={welcomePrompts}");
  });

  it("keeps prompt and calendar work serialized while preserving an editable pending queue", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("drainOperationQueue");
    expect(workspace).toContain("agent-chat-prompt-queue");
    expect(workspace).toContain("enqueueCalendarDirective");
    expect(workspace).toContain('text: "Scheduling…"');
    expect(workspace).not.toContain("streamAbortControllerRef.current?.abort();\n    streamAbortControllerRef.current = streamAbortController");
  });

  it("bounds the responsive composer and only reveals the larger editor control for long input", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("agent-chat-composer-expand");
    expect(workspace).toContain("overflow-y-auto");
    expect(workspace).toContain("max-h-[min(40dvh,18rem)]");
    expect(workspace).toContain("max-h-28 sm:max-h-36");
    expect(workspace).toContain("composerLong ?");
  });
});
