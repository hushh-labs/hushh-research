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
    expect(workspace).toContain('"motion-step-enter flex w-full items-start gap-2"');
    expect(workspace).not.toContain("animate-in fade-in slide-in-from-bottom-1");
    expect(workspace).toContain('className="flex min-h-16 items-center gap-2 rounded-[24px]');
    expect(history).toContain("bg-[linear-gradient(180deg");
    expect(history).not.toContain('"border-r border-border/70');
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
    expect(workspace).toContain("rounded-[24px] bg-foreground/[0.045]");
    expect(workspace).not.toContain("agent-chat-composer\"\n                      className=\"flex min-h-16 items-end gap-2 rounded-2xl border");
    expect(workspace).toContain('className="flex shrink-0 items-center gap-2"');
    expect(workspace).not.toContain('className="flex shrink-0 self-end items-center gap-2"');
    expect(workspace).toContain("max-h-28");
    expect(workspace).toContain("sm:max-h-36");
    expect(workspace).toContain("h-[min(38dvh,18rem)]");
    expect(workspace).toContain("sm:h-[min(48dvh,30rem)]");
    expect(workspace).toContain("composerExpanded ?");
    expect(workspace).not.toContain("composerLong ?");
    expect(workspace).not.toContain("Expanded message</span>");
    expect(workspace).not.toContain("Writing in expanded composer");
  });

  it("keeps active assistant streams full-width and errors compact", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("const hasStreamContent =");
    expect(workspace).toContain("streamEvents.length > 0");
    expect(workspace).toContain("Boolean(message.sources?.length)");
    expect(workspace).toContain("!isError && hasStreamContent");
    expect(workspace).toContain("!message.renderAsPlainAssistantMessage;");
    expect(workspace).toContain("renderAsPlainAssistantMessage: true,");
  });

  it("uses the canonical self avatar and removes idle status chrome", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("useEffectiveAvatarUrl");
    expect(workspace).toContain('data-testid="agent-chat-self-avatar"');
    expect(workspace).toContain("<AvatarBubble");
    expect(workspace).not.toContain('return "Ready";');
    // Reserve the status slot so a transition cannot move the header controls.
    expect(workspace).toContain('className="hidden w-28 shrink-0 truncate text-right');
    expect(workspace).toContain('role="status"');
    expect(workspace).toContain('aria-live="polite"');
    expect(workspace).toContain("title={statusText || undefined}");
    expect(workspace).not.toContain("{statusText ? (");
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
