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
    const providers = read("app/providers.tsx");

    expect(workspace).toContain('"overflow-hidden"');
    expect(workspace).not.toContain('"sm:rounded-lg sm:border sm:border-border sm:shadow-sm"');
    expect(workspace).not.toContain("onNavigationActionComplete");
    expect(workspace).not.toContain("shouldMinimizeForNavigationResult");
    expect(providers).not.toContain("AgentPopoverProvider");
    expect(providers).not.toContain("useOptionalAgentPopover");
  });

  it("uses shared Morphy shell controls and motion in the conversation workspace", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const history = read("components/agent/agent-history-sidebar.tsx");

    expect(workspace).toContain("ShellActionSurface");
    expect(workspace).toContain('"motion-step-enter flex w-full items-start gap-2"');
    expect(workspace).not.toContain("animate-in fade-in slide-in-from-bottom-1");
    expect(workspace).toContain('data-testid="agent-chat-composer"');
    expect(workspace).toContain("bottom-chrome-surface min-h-14 rounded-[var(--app-input-radius)]");
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
    expect(workspace).toContain("px-0 py-2.5");
    expect(workspace).toContain("rounded-[var(--app-input-radius)]");
    expect(workspace).not.toContain("agent-chat-composer\"\n                      className=\"flex min-h-16 items-end gap-2 rounded-2xl border");
    expect(workspace).toContain('className="flex shrink-0 items-center gap-1.5"');
    expect(workspace).toContain("max-h-28");
    expect(workspace).toContain("sm:max-h-36");
    expect(workspace).toContain("h-[min(38dvh,18rem)]");
    expect(workspace).toContain("sm:h-[min(48dvh,30rem)]");
    // `composerLong` was removed from this file some time ago; the expanded
    // editor is driven by `composerExpanded` now. The stale name had left this
    // whole case red, which is how a red suite stops being read at all.
    expect(workspace).toContain("composerExpanded ?");
    expect(workspace).not.toContain("Expanded message</span>");
    expect(workspace).not.toContain("Writing in expanded composer");
  });

  it("captures a large paste as an editable in-memory text attachment", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("shouldCaptureLargePaste(pasted)");
    expect(workspace).toContain("event.preventDefault()");
    expect(workspace).toContain("createPendingTextAttachment(nextText)");
    expect(workspace).toContain('data-testid="agent-chat-text-attachment"');
    expect(workspace).toContain("getTextAttachmentTitle(longPromptAttachment.text)");
    expect(workspace).toContain('aria-label="Remove text attachment"');
    expect(workspace).toContain("openLongPromptAttachment");
    expect(workspace).toContain("collapseComposer");
    expect(workspace).toContain("combineAttachmentAndComposerText");
    expect(workspace).toContain("await submitComposerText()");
    expect(workspace).toContain('source: "agent_chat_auto_capture"');
    expect(workspace).toContain("saveEligiblePkmCardsInBackground({");
    expect(workspace).not.toContain("Long paste detected — choose where it belongs.");
    expect(workspace).not.toContain("composerPurpose");
    expect(workspace).not.toContain("Review for Memory");
    expect(workspace).not.toContain("Send as chat");
    expect(workspace).not.toContain("AgentPkmReviewPanel");
    expect(workspace).not.toContain("getPkmConfirmationCards");
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
    // The slot is a reserved fixed-width span now, rendered unconditionally so
    // the right-hand cluster cannot jump sideways when the status appears and
    // disappears. The old `{statusText ? (` assertion outlived that change and
    // had been failing ever since.
    expect(workspace).toContain('role="status"');
    expect(workspace).toContain("{statusText}");
  });

  it("keeps One's cloud model picker out of the Puppy One surface", () => {
    // The founder-reported defect: the header read "Puppy One / On your
    // machine" with a Gemini chip beside it, over a transcript whose model is
    // on-device. Two pickers disagreeing about which model is answering, on
    // the one surface whose entire claim is where the answer was generated.
    // Gated and not merely hidden, because choosing an item writes One's model
    // preference and that write must not stay reachable from this surface.
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    // Sliced around the trigger so the assertion is about THIS control, not
    // about `isPuppySurface` appearing anywhere in a 6,000-line file.
    const anchor = workspace.indexOf('data-testid="agent-chat-model-picker"');
    expect(anchor).toBeGreaterThan(0);
    const pickerBlock = workspace.slice(anchor - 1600, anchor);
    expect(pickerBlock).toContain("{!isPuppySurface ? (");
    // The ungated form the defect shipped as.
    expect(workspace).not.toContain(
      "{modelPreference && modelPreference.choices.length > 1 ? (",
    );
    // The slot the picker sits in keeps its width when the picker is gone, so
    // the "Puppy" chip does not slide out from under the thumb that pressed
    // it. This is the same jump the status slot beside it was widened to stop.
    expect(workspace).toContain(
      'className="flex w-[7.5rem] shrink-0 justify-end sm:w-[9.5rem]"',
    );
    // And the control names the agent it configures, not just "Model".
    expect(workspace).toContain('aria-label="One\'s model"');
  });

  it("pauses One command capture on the way into Puppy One", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const provider = read("components/agent/location-command-provider.tsx");

    expect(workspace).toContain("requestAgentConversationStop();");
    expect(workspace).toContain("enterPuppySurface();");
    expect(provider).toContain("AGENT_CONVERSATION_STOP_EVENT");
    expect(provider).toContain("cancelCapture();");
    expect(provider).toContain("command.pause();");
  });

  it("keeps both transcripts mounted and mounts Puppy One only once it is asked for", () => {
    // One's transcript was hidden (so a cloud turn in flight survives a
    // glance) while Puppy's was conditionally mounted, so an on-device answer
    // that can take tens of seconds, and the whole local conversation with it,
    // was destroyed by the same glance in the other direction.
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).not.toContain("{isPuppySurface ? <PuppyOneSurface /> : null}");
    expect(workspace).toContain("{puppyEverOpened ? (");
    expect(workspace).toContain("active={isPuppySurface}");
    // Lazily, so a workspace that never opens Puppy costs the loopback
    // gateway and the trusted-device list nothing.
    expect(workspace).toContain("setPuppyEverOpened(true);");
  });

  it("puts One's transcript back where the reader left it", () => {
    // display:none discards scrollTop, so returning from Puppy landed on the
    // first message of a long history, and `scroll-smooth` then crawled back
    // down on the next arriving message.
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toContain("oneScrollTopRef.current = scrollTop");
    expect(workspace).toContain('behavior: "instant" as ScrollBehavior');
    expect(workspace).toContain("beginTranscriptProgrammaticScroll(target);");
    expect(workspace).toContain("clearTranscriptProgrammaticScroll");
  });

  it("keeps Chat route-level and makes /agent a compatibility redirect", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const proxy = read("proxy.ts");

    expect(workspace).toContain(
      "var(--app-bottom-shell-height,calc(var(--app-bottom-fixed-ui,0px)+var(--app-safe-area-bottom-effective,0px)))",
    );
    expect(workspace).not.toContain('variant="popover"');
    expect(workspace).not.toContain("onMinimize");
    expect(workspace).not.toContain("windowControls");
    expect(proxy).toContain("ROUTES.LEGACY_AGENT");
    expect(proxy).toContain("ROUTES.HOME");
  });

  it("gives canonical Chat its own bottom-chrome and scroll ownership", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const shell = read("components/app-ui/app-bottom-shell.tsx");
    const providers = read("app/providers.tsx");

    expect(workspace).toContain('data-agent-chat-route={isCanonicalChatRoute ? "root" : "embedded"}');
    expect(workspace).toContain("onKaiBottomChromeScroll(scrollTop)");
    expect(shell).toContain("agentBarHidden?: boolean");
    expect(shell).toContain("!model.agentBarHidden || Boolean(command?.active) || voiceActive");
    expect(providers).toContain("pathname === ROUTES.HOME");
    expect(providers).toContain("agentBarHidden:");
  });

  it("lets root Chat use the top spacer and move its composer relatively with bottom chrome", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const styles = read("app/globals.css");

    expect(workspace).toContain("agent-chat-workspace--root");
    expect(workspace).toContain('data-agent-chat-composer-form={');
    expect(workspace).toContain("h-[calc(100dvh-var(--app-top-content-offset,0px)-var(--app-bottom-shell-height");
    expect(styles).toContain('[data-agent-chat-composer-form="root"]');
    expect(styles).toContain("var(--bottom-nav-travel, 0px)");
  });
});
