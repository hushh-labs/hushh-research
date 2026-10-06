import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CHAT_USER_BUBBLE_CLASSNAME } from "@/components/agent/chat-message-styles";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("private-agent chat shell contract", () => {
  it("keeps recent Drive searches out of the chat workspace", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).not.toContain("<DriveBackgroundSearches");
  });
  // Connectors is a Profile section (founder, 2026-10-02): every chat entry
  // opens it in the Profile pane over the chat, never in a drawer of its own,
  // and the chat lends the pane its draft saver for sign-ins that leave.
  it("opens Connectors from chat in the Profile pane, never in its own drawer", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    expect(workspace).toContain("<AgentConnectionsDrawer");
    expect(workspace).toContain("connections={null}");
    expect(workspace).not.toContain("<ConnectorsPanel");
    expect(workspace).not.toContain('setDrawerMode("connections")');
    expect(workspace).toContain("openProfilePane(");
    expect(workspace).toContain("profileConnectorsLocation(");
    expect(workspace).toContain("registerChatConnectorRecoveryHost(");
  });
  it("keeps the connector manager bounded, scrollable, and on the shared modal scrim", () => {
    const drawer = read("components/agent/agent-connections-drawer.tsx");
    const panel = read("components/agent/connectors-panel.tsx");
    const dialog = read("components/ui/dialog.tsx");

    expect(drawer).toContain('contentDragDismiss={false}');
    expect(drawer).toContain('className="agent-connections-dialog h-[min(42rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-md"');
    expect(panel).toContain("min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto overscroll-contain");
    expect(dialog).toContain("[backdrop-filter:var(--app-scrim-filter)]");
    expect(dialog).toContain("[-webkit-backdrop-filter:var(--app-scrim-filter)]");
  });
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
    expect(workspace).toContain('"agent-chat-composer"');
    expect(workspace).toContain("agent-chat-composer-compact");
    // Persistent desktop column (2026-09-29): one solid chat-scoped surface
    // beside the conversation, separated by a hairline, never glass.
    expect(history).toContain('"border-r border-[color:var(--one-chat-divider)] bg-[color:var(--one-chat-sidebar)]"');
    expect(history).toContain("ShellActionSurface");
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
    expect(workspace).toContain("<AgentQueuedStack");
    expect(read("components/agent/agent-queued-stack.tsx")).toContain("agent-chat-prompt-queue");
    // Queued text reaches the running turn only through enqueuePrompt, which
    // the secret guard calls; an edit is screened the same way.
    const edit = workspace.slice(
      workspace.indexOf("const editQueuedPrompt = async"),
      workspace.indexOf("const removeQueuedPrompt = async"),
    );
    expect(edit).toContain("containsSecretSpan(text)");
    expect(edit).toContain("keepSecretsFromTurn([text])");
    expect(edit.indexOf("containsSecretSpan(text)")).toBeLessThan(edit.indexOf("reclaimQueuedPrompt(id)"));
    expect(workspace.match(/queue\.offer\(/g)).toHaveLength(1);
    expect(workspace).toContain("enqueueCalendarDirective");
    // Calendar and reviewed Gmail changes share one serialized runner.
    expect(workspace).toContain('pendingText: "Scheduling…"');
    expect(workspace).toContain("enqueueWorkspaceOperation({");
    expect(workspace).not.toContain("streamAbortControllerRef.current?.abort();\n    streamAbortControllerRef.current = streamAbortController");
  });

  it("keeps one composer that grows line by line, with no resize control", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    // Founder direction (2026-09-29): no expand/collapse icon, and a second
    // line no longer jumps into the tall editor. The tall editor remains only
    // for opening a pasted-text attachment from its chip.
    expect(workspace).not.toContain('"agent-chat-composer-expand"');
    expect(workspace).not.toContain("Expand message editor");
    expect(workspace).not.toContain("shouldAutoExpand");
    expect(workspace).not.toContain("manuallyCollapsedComposerDraftsRef");
    expect(workspace).toContain("agent-chat-composer-expanded");
    expect(workspace).toContain("agent-chat-composer-expanded-textarea");
    expect(workspace).toContain("overflow-y-auto");
    expect(workspace).toContain("agent-chat-composer-surface");
    expect(workspace).toContain("agent-chat-composer-field");
    expect(workspace).not.toContain("<Sparkles className=\"h-3.5 w-3.5\" />");
    expect(workspace).not.toContain("agent-chat-composer\"\n                      className=\"flex min-h-16 items-end gap-2 rounded-2xl border");
    expect(workspace).toContain('"flex shrink-0 items-center gap-1.5"');
    // One text box serves both sizes: two separate ones were swapped when a
    // long draft auto-expanded and keystrokes in that frame were lost.
    expect(workspace.match(/ref=\{composerTextareaRef\}/g) ?? []).toHaveLength(1);
    expect(read("app/globals.css")).toContain("max-height: min(10rem, 24dvh)");
    // The transcript's bottom band follows the composer's measured height.
    expect(workspace).toContain("--agent-chat-composer-stack-height");
    expect(workspace).toContain("h-[30dvh]");
    expect(workspace).toContain("{ duration: 120, easing, fill: \"none\" }");
    expect(workspace).toContain("transformOrigin: \"left bottom\"");
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
    // The chip and its editor live in their own module; the workspace only
    // hands them the draft and the edit, remove and collapse callbacks.
    const chip = read("components/agent/agent-text-attachment-editor.tsx");
    expect(workspace).toContain("<AgentComposerTextAttachment");
    expect(workspace).toContain("onChange={editLongPromptAttachment}");
    expect(workspace).toContain("onRemove={removeLongPromptAttachment}");
    expect(chip).toContain('data-testid="agent-chat-text-attachment"');
    expect(chip).toContain("getTextAttachmentTitle(attachment.text)");
    expect(chip).toContain('aria-label="Remove text attachment"');
    expect(workspace).toContain("collapseComposer");
    expect(workspace).toContain("combineAttachmentAndComposerText");
    expect(workspace).toContain("await submitComposerText()");
    expect(workspace).toContain("keepSecretsFromTurn");
    expect(workspace).toContain("const [submittedText");
    expect(workspace).toContain('source: "agent_chat_auto_capture"');
    expect(workspace).toContain("captureEligiblePkmFactsInBackground({");
    expect(workspace).toContain("beforeEffect: guard.assertCurrent");
    expect(workspace).toContain("mayPublish: guard.isCurrent");
    expect(workspace).not.toContain("Long paste detected — choose where it belongs.");
    expect(workspace).not.toContain("composerPurpose");
    expect(workspace).not.toContain("Review for Memory");
    expect(workspace).not.toContain("Send as chat");
    expect(workspace).not.toContain("AgentPkmReviewPanel");
    expect(workspace).toContain("getPkmConfirmationCards");
    expect(workspace).toContain("const reviewRequired =");
    expect(workspace).toContain('phase: reviewRequired ? "review" : "skipped"');
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

  it("keeps the header profile control, drops per-message avatars, and removes idle status chrome", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    // The top-right profile control stays, with the canonical avatar source.
    expect(workspace).toContain("useEffectiveAvatarUrl");
    expect(workspace).toContain('data-testid="profile-open-button"');
    expect(workspace).toContain('onClick={() => requestProfilePaneOpen("tap")}');
    expect(workspace).toContain("<AvatarImage src={userAvatarUrl}");
    // No avatar beside individual user bubbles (founder direction, 2026-09-29).
    expect(workspace).not.toContain('data-testid="agent-chat-self-avatar"');
    expect(workspace).not.toContain("<AvatarBubble");
    // Real times move to centered separators above each group of messages.
    expect(workspace).toContain("computeChatTimeSeparators(timelineItems)");
    expect(workspace).toContain("<ChatTimeSeparatorRow separator=");
    expect(workspace).not.toContain("<span>{message.timestamp}</span>");
    expect(workspace).not.toContain('return "Ready";');
    // Status belongs below One, not beside the profile avatar. The subtitle
    // crossfades without moving the right-hand controls.
    expect(workspace).toContain('IDLE_AGENT_SUBTITLE = "Your private agent"');
    expect(workspace).toContain("return input.statusText || IDLE_AGENT_SUBTITLE;");
    expect(workspace).toContain("<ChatAgentSubtitle text={chatHeaderSubtitle({");
    expect(workspace).not.toContain('title={statusText || undefined}');
  });

  it("keeps the active-agent mark visible in the compact chat header", () => {
    const workspace = read("components/agent/agent-chat-workspace.tsx");
    const brandTileStart = workspace.indexOf('data-agent-chat-brand-tile');
    const brandTile = workspace.slice(brandTileStart, brandTileStart + 700);

    expect(brandTileStart).toBeGreaterThan(0);
    expect(brandTile).toContain("<HushhMark");
    expect(brandTile).toContain('className="grid h-8 w-8 shrink-0 place-items-center sm:h-9 sm:w-9"');
    expect(brandTile).toContain('className="h-7 w-7 items-center justify-center overflow-visible"');
    expect(brandTile).toContain('imageClassName="!h-[23px] !w-[23px]"');
    expect(brandTile).not.toContain("max-sm:hidden");
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
    expect(pickerBlock).toContain("modelPreference && !isPuppySurface ? (");
    // The ungated form the defect shipped as.
    expect(workspace).not.toContain(
      "{modelPreference && modelPreference.choices.length > 1 ? (",
    );
    // The picker disappearing must not slide the "Puppy" chip out from under
    // the thumb that pressed it. That is now held by order (picker, toggle,
    // profile: the toggle is anchored to the right edge), not by a reserved
    // fixed-width slot; agent-chat-header-layout.contract.test.ts pins it.
    expect(workspace).not.toContain("w-[7.5rem] shrink-0 justify-end");
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
    expect(shell).not.toContain("const agentBarVisible = !model.agentBarHidden");
    expect(shell).toContain("<AgentDockVoiceBoundary>");
    expect(workspace).toContain("<AgentDockPortal enabled={isCanonicalChatRoute}");
    expect(workspace).toContain('<AgentBar layout="slot" />');
    expect(workspace).toContain("<AgentBarSurface");
    expect(workspace).not.toContain("<AgentVoiceWaveInput");
    // A command result can outlive capture. Never measure the hidden editor;
    // its visibility change must trigger sizing when that result is dismissed.
    expect(workspace).toContain("if (!textarea || showVoiceBar) return;");
    expect(workspace).toContain("[agentDockHost, composerExpanded, input, setComposerExpanded, showVoiceBar]");
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

  it("keeps selected text visible on the person's own accent bubble", () => {
    // Regression: the theme highlight is the accent at 28%, so on the accent
    // bubble selected text vanished. The on-accent rule is keyed to the
    // bubble's exact fill class; renaming the fill must carry the rule with it.
    const styles = read("app/globals.css");
    const fill = CHAT_USER_BUBBLE_CLASSNAME.split(/\s+/).find((name) => name.startsWith("bg-"));

    expect(fill).toBe("bg-[linear-gradient(145deg,var(--app-accent),var(--app-accent-deep))]");
    expect(styles).toContain(`[class~="${fill}"]`);
    expect(styles).toMatch(/\)\s*::selection\s*\{\s*background-color: var\(--app-accent-selection-bg\);\s*color: var\(--app-accent-selection-fg\);/);
    expect(styles).toContain("--app-accent-selection-bg:");
    expect(styles).toContain("--app-accent-selection-fg:");
  });

  it("does not render the welcome panel while voice is live", () => {
    // Regression (phone browser, 2026-10-02): on a fresh conversation the
    // "One workspace" welcome panel and the "Voice connecting" card both
    // rendered, and the card -- an `absolute bottom-0` overlay in the composer
    // stack -- cut through the panel centred in the scroll area behind it.
    // Desktop had the vertical room to hide it; a short phone viewport did not.
    //
    // The guard is co-rendering, not spacing: two states that both claim the
    // canvas must not both be on it, because any gap we leave holds only until
    // the next shorter viewport. Both gates have to stay on this condition.
    const workspace = read("components/agent/agent-chat-workspace.tsx");

    expect(workspace).toMatch(
      /:\s*!hasStartedConversation\s*&&\s*!voiceActive\s*\?/,
    );
    // The two facts that made them collide, so this reads as a real constraint
    // rather than a copy of the line above: the card is a bottom overlay, and
    // `voiceActive` is the same gate the card itself renders on.
    expect(workspace).toContain("absolute inset-x-0 bottom-0 z-10");
    expect(workspace).toContain('const voiceActive = voiceState !== "idle"');
  });
});
