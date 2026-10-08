"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CalendarAgentIcon,
  LocationAgentIcon,
  Mic,
} from "@/components/icons";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { ConnectorBrandMark } from "@/components/agent/connector-brand-mark";
import { AppStreamSection } from "@/components/app-ui/stream-progress-panel";
import {
  CHAT_USER_BUBBLE_CLASSNAME,
  CHAT_ASSISTANT_BODY_CLASSNAME,
} from "@/components/agent/chat-message-styles";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhWordmark } from "@/components/app-ui/hushh-wordmark";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import {
  BodyText,
  CaptionText,
  RowDescription,
  MediumRowLabel,
} from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { getGsap } from "@/lib/morphy-ux/gsap";
import {
  ensureMorphyGsapReady,
  getMorphyEaseName,
} from "@/lib/morphy-ux/gsap-init";
import {
  ONE_CAPABILITIES,
  isOneCapabilityEnabled,
} from "@/lib/onboarding/one-capabilities";
import { ROUTES } from "@/lib/navigation/routes";
import styles from "./guest-preview.module.css";
import welcomeStyles from "./IntroStep.module.css";
import { OneWelcomeStory, OneWelcomePrivacy } from "./OneWelcomeStory";

const CAPABILITIES = ONE_CAPABILITIES.filter(
  (capability) =>
    capability.isVisibleOnRoster !== false &&
    isOneCapabilityEnabled(capability),
);
const AGENT_PREVIEW_COPY: Record<string, string> = {
  finance: "Shows your accounts and spending.",
  wallet: "Stores your card information, encrypted.",
  location: "Shares where you are with people you pick.",
  ria: "Puts you in touch with a financial advisor.",
  gmail: "Reads and sorts your inbox for you.",
  calendar: "Shows your week and finds time that is free.",
  pkm: "Remembers what you have told One.",
  consent: "Lets you change what each agent can see.",
};
// Presentation only. Calendar illustrates a connected calendar's free slots;
// Location illustrates a ready Family Circle with device permission granted.
// The sharing contract supports duration/early revocation, not arrival triggers.
const CHAT_TURNS = [
  {
    agent: "calendar",
    title: "Calendar",
    prompt: "Find 30 free minutes tomorrow afternoon",
    response:
      "Open 30-minute slots tomorrow:\n\n**12:00–12:30 PM** · **12:30–1:00 PM** · **1:00–1:30 PM**",
  },
  {
    agent: "location",
    title: "Location",
    prompt:
      "Can you share my location with my Family Circle for the next 2 hours, until I reach home?",
    response:
      "Sharing with **Family Circle** for **2 hours**. Stop sharing early when you reach home.",
  },
] as const;

/** A finite, local illustration: no input, microphone or agent request. */
function animateChatPreview(
  gsap: NonNullable<Awaited<ReturnType<typeof getGsap>>>,
  element: HTMLElement,
  ease: string,
) {
  element.querySelectorAll('[data-chat-active="true"]').forEach((turn) => {
    const prompt = turn.querySelector("[data-chat-prompt]");
    const answer = turn.querySelector("[data-chat-answer]");
    const typing = turn.querySelector("[data-chat-typing]");
    const activity = turn.querySelector("[data-chat-activity]");
    const characters = turn.querySelectorAll("[data-chat-character]");
    const typingAt = 0.5 + Math.min(1.5, characters.length * 0.025);
    const answerAt = typingAt + 0.8;
    gsap.fromTo(
      prompt,
      { opacity: 0, y: 8 },
      {
        opacity: 1,
        y: 0,
        duration: 0.4,
        delay: 0.15,
        ease,
      },
    );
    gsap.fromTo(
      characters,
      { opacity: 0 },
      {
        opacity: 1,
        duration: 0.06,
        stagger: { amount: Math.min(1.5, characters.length * 0.025) },
        delay: 0.35,
        ease: "none",
      },
    );
    gsap.fromTo(
      typing,
      { opacity: 0 },
      {
        opacity: 1,
        duration: 0.2,
        delay: typingAt,
        ease,
      },
    );
    gsap.fromTo(
      turn.querySelectorAll("[data-chat-typing] i"),
      { y: 0 },
      {
        y: -3,
        duration: 0.25,
        stagger: 0.1,
        repeat: 1,
        yoyo: true,
        delay: typingAt,
        ease: "sine.inOut",
      },
    );
    gsap.to(typing, { opacity: 0, duration: 0.15, delay: answerAt - 0.15 });
    if (activity) {
      gsap.fromTo(
        activity,
        { opacity: 0, y: 4 },
        {
          opacity: 1,
          y: 0,
          duration: 0.3,
          delay: typingAt,
          ease,
        },
      );
    }
    gsap.fromTo(
      answer,
      { opacity: 0, y: 8 },
      {
        opacity: 1,
        y: 0,
        duration: 0.5,
        delay: answerAt,
        ease,
      },
    );
  });
}

/** These illustrations never request a microphone, accounts or sharing access. */
function usePreviewMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReducedMotion(preference.matches);
    const syncVisibility = () => setVisible(!document.hidden);
    syncMotion();
    syncVisibility();
    preference.addEventListener("change", syncMotion);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      preference.removeEventListener("change", syncMotion);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);
  return !reducedMotion && visible;
}

/** One bounded illustration transition, using the app's existing GSAP owner.
 * Route/step transitions remain owned by the shared motion-step-enter utility.
 * A failed/later import leaves the readable static composition intact.
 */
function useIllustrationMotion(
  ref: RefObject<HTMLDivElement | null>,
  selection: string | number,
  enabled: boolean,
) {
  const hasEntered = useRef(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    let cancelled = false;
    let context: { revert: () => void } | undefined;
    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (cancelled || !gsap?.context) return;
      context = gsap.context(() => {
        const ease = getMorphyEaseName("emphasized");
        if (!hasEntered.current) {
          const entrance = element.querySelectorAll("[data-preview-intro]");
          if (entrance.length) {
            gsap.fromTo(
              entrance,
              { opacity: 0, y: 10 },
              {
                opacity: 1,
                y: 0,
                duration: 0.7,
                stagger: 0.09,
                ease,
              },
            );
          }
          hasEntered.current = true;
        }
        const reveal = element.querySelectorAll("[data-preview-reveal]");
        if (reveal.length) {
          gsap.fromTo(
            reveal,
            { opacity: 0, y: 14 },
            {
              opacity: 1,
              y: 0,
              duration: 0.65,
              stagger: 0.1,
              ease,
            },
          );
        }
        const selected = element.querySelector(
          '[data-circle-selected="true"], [data-agent-selected="true"]',
        );
        if (selected) {
          gsap.fromTo(
            selected,
            { scale: 0.88 },
            {
              scale: 1,
              duration: 0.7,
              ease,
            },
          );
        }
        const ripples = element.querySelectorAll("[data-orbit-ripple]");
        if (ripples.length) {
          gsap.fromTo(
            ripples,
            { opacity: 0.4, scale: 0.65 },
            {
              opacity: 0,
              scale: 1.8,
              duration: 1.8,
              stagger: 0.25,
              ease,
            },
          );
        }
        const light = element.querySelector("[data-orbit-light]");
        if (light) {
          gsap.fromTo(
            light,
            { opacity: 0.45, scale: 0.92 },
            {
              opacity: 0.8,
              scale: 1.05,
              duration: 1.1,
              repeat: 1,
              yoyo: true,
              ease: "sine.inOut",
            },
          );
        }
        animateChatPreview(gsap, element, ease);
      }, element);
    })().catch(() => {
      context?.revert();
    });
    return () => {
      cancelled = true;
      context?.revert();
    };
  }, [enabled, ref, selection]);
}

function ChatStory() {
  return (
    <div className={styles.chatStep}>
      <div className={styles.chatCardExact}>
        <div className={styles.chatExampleLabel}>Example conversation</div>
        <div className={styles.chatUserMessage}>
          Give me a brief on who I&apos;m meeting tomorrow afternoon.
        </div>
        <div className={styles.chatChecked}>
          <span aria-hidden="true">✓</span> Checked your calendar
        </div>
        <div className={styles.chatResponse}>
          You have a meeting with <strong>Manish Sainani</strong> at 3 PM.
        </div>
        <div className={styles.chatContext}>
          [Short bio of Manish Sainani: role, company and how you know each
          other] ...
        </div>
        <div className={styles.chatPrompt}>
          <span>Ask One</span>
          <svg width="64" height="28" viewBox="0 0 64 28" aria-hidden="true" fill="currentColor">
            {[10, 5, 9, 1, 7, 4, 10].map((y, index) => (
              <rect key={index} x={index * 9} y={y} width="4" height={28 - y * 2} rx="2" />
            ))}
          </svg>
          <button type="button" aria-label="Speak to One" className={styles.chatMic}>
            <Mic aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentStory() {
  const motionEnabled = usePreviewMotionPreference();
  const illustrationRef = useRef<HTMLDivElement>(null);
  useIllustrationMotion(illustrationRef, "agents", motionEnabled);
  return (
    <div
      ref={illustrationRef}
      className={styles.agentStory}
      data-agent-tour="static"
    >
      <div className={styles.agentCardList} aria-label="One’s private agents">
        {CAPABILITIES.map((capability) => {
            const description = AGENT_PREVIEW_COPY[capability.id] || capability.description;
          return (
          <div
            key={capability.id}
            className={styles.agentItem}
          >
            <span className={styles.agentIcon} aria-hidden="true">
              <AgentSectionIcon
                id={"preview-" + capability.id}
                icon={capability.icon}
                tone={capability.tone}
                size="setup"
                treatment="profile"
              />
            </span>
            <span className={styles.agentName}>{capability.title}</span>
            <span className={styles.agentDesc}>{description}</span>
          </div>
          );
        })}
      </div>
    </div>
  );
}

function ConversationStory() {
  const motionEnabled = usePreviewMotionPreference();
  const illustrationRef = useRef<HTMLDivElement>(null);
  const [autoPlay, setAutoPlay] = useState(true);
  const [scene, setScene] = useState(0);
  useIllustrationMotion(illustrationRef, scene, motionEnabled);
  useEffect(() => {
    if (!motionEnabled || !autoPlay || scene !== 0) return;
    const timer = window.setTimeout(() => setScene(1), 6800);
    return () => window.clearTimeout(timer);
  }, [motionEnabled, autoPlay, scene]);
  return (
    <div
      ref={illustrationRef}
      className={styles.conversation}
      data-motion={motionEnabled ? "playing" : "static"}
    >
      <div className={styles.voiceVisual} aria-hidden="true">
        <span className={styles.voiceHalo} />
        <span className={styles.voiceHalo} />
        <span className={styles.voiceCore}>
          <Mic />
        </span>
        <div className={styles.waveform}>
          {[0.3, 0.55, 0.8, 0.45, 1, 0.7, 0.4, 0.85, 0.6, 0.35, 0.7].map(
            (height, index) => (
              <i
                key={index}
                style={
                  {
                    "--bar-height": height,
                    animationDelay: index * -90 + "ms",
                  } as CSSProperties
                }
              />
            ),
          )}
        </div>
      </div>
      <SurfaceCard
        className={styles.chatPreview}
        onPointerDown={() => setAutoPlay(false)}
        onFocusCapture={() => setAutoPlay(false)}
      >
        <div
          className={styles.chatHeader}
          role="group"
          aria-label="Conversation previews"
          onFocus={() => setAutoPlay(false)}
        >
          {CHAT_TURNS.map((turn, index) => {
            const Icon =
              turn.agent === "calendar" ? CalendarAgentIcon : LocationAgentIcon;
            return (
              <ShellActionSurface
                key={turn.agent}
                variant="pill"
                className={styles.chatAgent}
                aria-pressed={scene === index}
                onClick={() => {
                  setAutoPlay(false);
                  setScene(index);
                }}
              >
                {Icon && <Icon aria-hidden="true" className="size-4" />}
                {turn.title}
              </ShellActionSurface>
            );
          })}
          <CaptionText className={styles.sampleLabel}>Preview</CaptionText>
        </div>
        <div
          className={`${styles.chatScenes} text-sm leading-6`}
          role="region"
          aria-label="Sample conversation with One"
          data-chat-scenes
        >
          {CHAT_TURNS.map((turn, turnIndex) => (
            <div
              key={turn.prompt}
              className={styles.chatTurn}
              data-chat-turn={turn.agent}
              data-chat-active={scene === turnIndex}
              aria-hidden={scene !== turnIndex}
              inert={scene !== turnIndex}
            >
              <div
                className={`${styles.question} ${CHAT_USER_BUBBLE_CLASSNAME}`}
                data-chat-prompt
              >
                <span className="sr-only">You: {turn.prompt}</span>
                <span aria-hidden="true" data-testid="preview-chat-prompt">
                  {turn.prompt.split(" ").map((word, wordIndex, words) => (
                    <span key={wordIndex}>
                      <span className={styles.chatWord}>
                        {Array.from(word).map((character, index) => (
                          <span key={index} data-chat-character>
                            {character}
                          </span>
                        ))}
                      </span>
                      {wordIndex < words.length - 1 ? " " : null}
                    </span>
                  ))}
                </span>
              </div>
              {turn.agent === "calendar" && (
                <div className={styles.calendarActivity} data-chat-activity>
                  <AppStreamSection
                    title="Activity"
                    count={1}
                    defaultOpen={false}
                    items={[
                      {
                        id: "calendar-preview",
                        label: "Google Calendar",
                        message: "Finding free time on your calendar.",
                        status: "done",
                        mark: <ConnectorBrandMark brand="calendar" size="sm" />,
                      },
                    ]}
                  />
                </div>
              )}
              <div className={styles.replySlot}>
                <span
                  className={styles.typingDots}
                  data-chat-typing
                  aria-hidden="true"
                >
                  <i />
                  <i />
                  <i />
                </span>
                <div
                  className={`${styles.answer} ${CHAT_ASSISTANT_BODY_CLASSNAME}`}
                  data-chat-answer
                  data-testid="preview-chat-reply"
                >
                  <span className="sr-only">One:</span>
                  <AgentMarkdown text={turn.response} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </SurfaceCard>
    </div>
  );
}

export type GuestPreviewInvitation = {
  kind: "circle" | "connection";
  name?: string;
  ownerName?: string;
  loading?: boolean;
  error?: string | null;
  /** Definitively invalid/expired; a slow preview is not admission. */
  unavailable?: boolean;
  onRetry?: () => void;
};

/** Presentation only. No account, membership, connector or sharing writes. */
export function GuestPreview({
  onStart,
  invitation,
  publicLinks = false,
  onReadyChange,
}: {
  onStart: () => void;
  invitation?: GuestPreviewInvitation;
  publicLinks?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const headingRef = useRef<HTMLDivElement>(null);
  const previousStepRef = useRef(step);
  const motionEnabled = usePreviewMotionPreference();
  const title =
    step === 0
      ? "One"
      : step === 1
        ? "Eight private agents working together to make your life easier."
        : step === 2
          ? "Chat with Agent One, out loud or in writing."
          : "Just ask One.";

  useEffect(() => {
    onReadyChange?.(step === 3);
  }, [step, onReadyChange]);

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    const heading = headingRef.current;
    // Focus after the new copy commits. If enlarged text needed scrolling,
    // start the next screen at its top without hiding the preview's topbar.
    const scrollRoot =
      heading?.closest('[data-app-scroll-root="true"]') ??
      document.scrollingElement;
    if (scrollRoot) scrollRoot.scrollTop = 0;
    heading?.focus({ preventScroll: true });
  }, [step]);

  function moveTo(next: number) {
    setStep(next);
    setFurthestStep((visited) => Math.max(visited, next));
  }

  return (
    <FullscreenFlowShell
      width="reading"
      className={step === 0 ? welcomeStyles.shell : styles.shell}
      style={step === 0 ? { maxWidth: "none" } : undefined}
      data-testid="guest-preview"
      data-preview-step={step + 1}
      data-has-invitation={Boolean(invitation)}
    >
      {step === 0 ? (
        <div className={welcomeStyles.stage}>
          <div className={welcomeStyles.composition}>
            <OneWelcomeStory headingRef={headingRef} motionEnabled={motionEnabled} />
            <footer className={welcomeStyles.footer}>
              <OneWelcomePrivacy />
              <Button variant="blue" effect="fill" size="prominent" fullWidth className={welcomeStyles.welcomeCta} onClick={() => moveTo(1)}>
                <span className={welcomeStyles.ctaLabel}>Create your One</span>
              </Button>
              {publicLinks && (
                <nav className={welcomeStyles.links} aria-label="Explore Hussh">
                  <Link href={ROUTES.RESEARCH} className={welcomeStyles.link}>Research</Link>
                  <Link href={ROUTES.BLOG} className={welcomeStyles.link}>Blog</Link>
                  <Link href={ROUTES.DEVELOPERS} className={welcomeStyles.link}>Developers</Link>
                </nav>
              )}
            </footer>
          </div>
        </div>
      ) : (
          <>
          <header className={styles.topbar}>
            <div className={styles.backSlot}>
              {step > 0 && (
                <ShellActionSurface
                  variant="icon"
                  aria-label="Previous screen"
                  onClick={() => moveTo(step - 1)}
                >
                  <ArrowLeft aria-hidden="true" className="h-5 w-5" />
                </ShellActionSurface>
              )}
            </div>
            <HushhWordmark />
            {step === 3 ? (
              <Button
                variant="link"
                size="compact"
                data-voice-control-id="onboarding_claim_one"
                onClick={onStart}
              >
                Sign in
              </Button>
            ) : (
              <div className={styles.backSlot} aria-hidden="true" />
            )}
          </header>

          <div className={styles.content} data-step={step}>
            <div ref={headingRef} tabIndex={-1} className={styles.heading}>
              <CaptionText className="text-accent-strong">
                {invitation ? "You’re invited to One" : "Welcome to One"}
              </CaptionText>
              <h1 className={`type-display ${styles.title}`} aria-live="polite">
                {title}
              </h1>
              <BodyText className={styles.subtitle}>
                {step === 1
                  ? "What you tell one agent helps the others, and you stay in control of all of it."
                  : step === 2
                    ? "One checks your calendar and everything else you have connected, then gives you a direct answer."
                    : "Talk or type. Let One help you."}
              </BodyText>
            </div>

            <section
              key={step}
              className={`${styles.stage} motion-step-enter`}
              aria-label={title}
            >
              {step === 1 ? (
                <AgentStory />
              ) : step === 2 ? (
                <ChatStory />
              ) : (
                <div
                  className={styles.invitation}
                  data-has-invitation={Boolean(invitation)}
                >
                  <ConversationStory />

                  {invitation && (
                    <div className={styles.inviteContext}>
                      <MediumRowLabel
                        as="div"
                        role="heading"
                        aria-level={2}
                        className="break-words"
                      >
                        {invitation.name ||
                          (invitation.kind === "circle"
                            ? "Your Circle invitation"
                            : "Connect on One")}
                      </MediumRowLabel>
                      <RowDescription className="break-words" role="status">
                        {invitation.loading
                          ? "Checking your invitation…"
                          : invitation.error
                            ? invitation.error
                            : invitation.ownerName
                              ? `Invited by ${invitation.ownerName}`
                              : "Sign in to continue with this invitation."}
                      </RowDescription>
                    </div>
                  )}
                  {invitation?.error && invitation.onRetry && (
                    <Button
                      variant="link"
                      onClick={invitation.onRetry}
                      className="mt-3"
                    >
                      Try again
                    </Button>
                  )}
                </div>
              )}
            </section>
          </div>

          <footer className={styles.footer}>
            <nav className={styles.progress} aria-label="Preview screens">
              {["Welcome", "Agents", "Chat", "Get started"].map((label, index) => (
                <button
                  key={label}
                  type="button"
                  aria-label={`Screen ${index + 1}: ${label}`}
                  aria-current={step === index ? "step" : undefined}
                  disabled={index > furthestStep}
                  onClick={() => moveTo(index)}
                >
                  <span />
                </button>
              ))}
            </nav>
            <Button
              variant="blue"
              effect="fill"
              size="prominent"
              fullWidth
              disabled={step === 3 && invitation?.unavailable}
              onClick={step < 3 ? () => moveTo(step + 1) : onStart}
            >
              {step === 1
                ? "Meet your agents"
                : step === 2
                ? "Continue"
                  : invitation?.kind === "circle"
                    ? "Join this Circle"
                    : invitation
                      ? "Accept invitation"
                      : "Create your One"}
              <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
            </Button>
            {publicLinks && (
              <nav className={styles.publicLinks} aria-label="Explore Hussh">
                <Link href={ROUTES.RESEARCH}>Research</Link>
                <Link href={ROUTES.BLOG}>Blog</Link>
                <Link href={ROUTES.DEVELOPERS}>Developers</Link>
              </nav>
            )}
          </footer>
          </>
      )}
    </FullscreenFlowShell>
  );
}
