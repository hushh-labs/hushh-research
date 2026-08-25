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
    expect(workspace).toContain('className="flex min-h-16 items-end gap-2 rounded-2xl');
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

  it("keeps compact composer controls inside a rectangular editor and opens a separate long-form editor", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("agent-chat-composer-expand");
    expect(workspace).toContain("agent-chat-composer-expanded");
    expect(workspace).toContain("agent-chat-composer-expanded-textarea");
    expect(workspace).toContain("overflow-y-auto");
    expect(workspace).toContain("px-7 py-3 pr-14");
    expect(workspace).toContain("sm:px-8 sm:pr-14");
    expect(workspace).toContain("rounded-2xl border border-border/70 bg-foreground/[0.04]");
    expect(workspace).toContain('className="flex shrink-0 self-end items-center gap-2"');
    expect(workspace).toContain("max-h-28");
    expect(workspace).toContain("sm:max-h-36");
    expect(workspace).toContain("h-[min(38dvh,18rem)]");
    expect(workspace).toContain("sm:h-[min(48dvh,30rem)]");
    expect(workspace).toContain("composerLong ?");
    expect(workspace).not.toContain("Expanded message</span>");
    expect(workspace).not.toContain("Writing in expanded composer");
  });

  it("keeps stream panels for normal assistant turns and bypasses them only for calendar status", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("const hasStreamContent =");
    expect(workspace).toContain("Boolean(message.text.trim());");
    expect(workspace).toContain("!message.renderAsPlainAssistantMessage;");
    expect(workspace).toContain("renderAsPlainAssistantMessage: true,");
  });

  it("minimizes the legacy full-page /agent route to One home, not Profile, when there is no referrer to retrace to", () => {
    // Issue #5921: falling back to Profile stranded someone who opened this
    // route with no browser history (e.g. a direct link) somewhere that is
    // not the section this screen lives under.
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("router.push(ROUTES.ONE_HOME);");
    expect(workspace).not.toContain("router.push(ROUTES.PROFILE);");
  });
});
