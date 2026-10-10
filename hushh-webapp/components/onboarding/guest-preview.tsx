"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  FinanceAgentIcon,
  CalendarAgentIcon,
  LocationAgentIcon,
  Heart,
  Mic,
  Users,
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
  AgentTabLabel,
  BodyText,
  CaptionText,
  CardTitle,
  RowDescription,
  MediumRowLabel,
} from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { getGsap } from "@/lib/morphy-ux/gsap";
import { HushhMark } from "@/lib/morphy-ux/ui/hushh-mark";
import {
  ensureMorphyGsapReady,
  getMorphyEaseName,
} from "@/lib/morphy-ux/gsap-init";
import {
  ONE_CAPABILITIES,
  isOneCapabilityEnabled,
} from "@/lib/onboarding/one-capabilities";
import { DASHBOARD_AGENT_ICON_STYLE_BY_ID } from "@/lib/design/home-icon-palette";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { ROUTES } from "@/lib/navigation/routes";
import styles from "./guest-preview.module.css";
import welcomeStyles from "./IntroStep.module.css";
import { OneWelcomeStory, OneWelcomePrivacy } from "./OneWelcomeStory";

const CIRCLES = [
  {
    id: "family",
    title: "Family",
    icon: Heart,
    palette: "email",
    headline: "Family Circle",
    description: "Share your location with family, when you choose.",
  },
  {
    id: "friends",
    title: "Friends",
    icon: Users,
    palette: "ria",
    headline: "Friends Circle",
    description: "Keep your friends and shared plans together.",
  },
  {
    id: "finance",
    title: "Finance",
    icon: FinanceAgentIcon,
    palette: "finance",
    headline: "Finance Circle",
    description: "Bring your advisor into your Finance Circle.",
  },
  {
    id: "business",
    title: "Business",
    icon: Briefcase,
    palette: "consent",
    headline: "Business Circle",
    description: "Give your work connections a Circle of their own.",
  },
] as const;
const CAPABILITIES = ONE_CAPABILITIES.filter(
  (capability) =>
    capability.isVisibleOnRoster !== false &&
    isOneCapabilityEnabled(capability),
);
const PALETTE = DASHBOARD_AGENT_ICON_STYLE_BY_ID;
const PREVIEW_CYCLE_MS = 2500;
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

/** Low-frequency selection changes; no work while hidden or reduced-motion.
 * Hover and keyboard focus hold the description until the reader leaves. */
function usePreviewCycle(count: number) {
  const motionEnabled = usePreviewMotionPreference();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const cycling = motionEnabled && !hovered && !focused;
  useEffect(() => {
    if (!cycling || count < 2) return;
    const timer = window.setTimeout(
      () => setIndex((value) => (value + 1) % count),
      PREVIEW_CYCLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [count, cycling, index]);
  return {
    index,
    setIndex,
    motionEnabled,
    cycling,
    interactionProps: {
      onPointerEnter: (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === "mouse") setHovered(true);
      },
      onPointerLeave: () => setHovered(false),
      onFocusCapture: (event: FocusEvent<HTMLDivElement>) => {
        setFocused(event.target.matches(":focus-visible"));
      },
      onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      },
    },
  };
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

function CircleStory() {
  const { index, setIndex, motionEnabled, cycling, interactionProps } =
    usePreviewCycle(CIRCLES.length);
  const illustrationRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const circle = CIRCLES[index] ?? CIRCLES[0];
  const CircleIcon = circle.icon;
  useIllustrationMotion(illustrationRef, index, motionEnabled);

  return (
    <div
      ref={illustrationRef}
      className={styles.circleStory}
      style={PALETTE.wallet as CSSProperties}
      data-circle-tour={cycling ? "running" : "stopped"}
      {...interactionProps}
    >
      <p id={helpId} className="sr-only">
        Choose a Circle to explore it. The tour pauses while you hover or use
        the keyboard.
      </p>
      <div
        className={styles.orbit}
        aria-label="Explore Circles"
        aria-describedby={helpId}
      >
        <div
          className={styles.orbitLight}
          data-orbit-light
          aria-hidden="true"
        />
        <div className={styles.ring} data-orbit-ring aria-hidden="true" />
        <div className={styles.innerRing} data-orbit-ring aria-hidden="true" />
        <div
          className={styles.orbitRipple}
          data-orbit-ripple
          aria-hidden="true"
        />
        <div
          className={styles.orbitRipple}
          data-orbit-ripple
          aria-hidden="true"
        />
        <div className={styles.brandCenter} data-preview-center>
          <div className={styles.brandTile} data-preview-intro>
            <HushhMark
              className={styles.brandMark}
              alt="Hussh One"
              priority
            />
          </div>
        </div>
        {CIRCLES.map((item, position) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={styles.circle}
              style={PALETTE[item.palette] as CSSProperties}
              data-position={position}
              aria-pressed={index === position}
              onClick={() => {
                setIndex(position);
              }}
              onPointerEnter={(event) => {
                if (event.pointerType !== "mouse") return;
                setIndex(position);
              }}
              onFocus={() => {
                setIndex(position);
              }}
            >
              <span className={styles.circleLift}>
                <span
                  className={styles.circlePill}
                  data-circle-selected={index === position}
                  data-preview-intro
                >
                  <Icon aria-hidden="true" weight="fill" color="currentColor" />
                  <AgentTabLabel data-tone="primary">
                    {item.title}
                  </AgentTabLabel>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <SurfaceCard
        className={styles.circleCopy}
        style={PALETTE[circle.palette] as CSSProperties}
        aria-live={cycling ? "off" : "polite"}
        aria-atomic="true"
      >
        <div key={circle.id} data-preview-reveal>
          <div className={styles.circleCopyHeading}>
            <span className={styles.circleCopyIcon} aria-hidden="true">
              <CircleIcon weight="fill" color="currentColor" />
            </span>
            <MediumRowLabel as="h3">{circle.headline}</MediumRowLabel>
          </div>
          <BodyText>{circle.description}</BodyText>
        </div>
      </SurfaceCard>
    </div>
  );
}

function AgentStory() {
  const { index, setIndex, motionEnabled, cycling, interactionProps } =
    usePreviewCycle(CAPABILITIES.length);
  const illustrationRef = useRef<HTMLDivElement>(null);
  const selected = CAPABILITIES[index] ?? CAPABILITIES[0];
  useIllustrationMotion(
    illustrationRef,
    selected?.id ?? "agents",
    motionEnabled,
  );
  if (!selected) return null;
  const copy = getCapabilitySetupCopy(selected.id);
  return (
    <div
      ref={illustrationRef}
      className={styles.agentStory}
      data-agent-tour={cycling ? "running" : "stopped"}
      {...interactionProps}
    >
      <div className={styles.agents} aria-label="Explore One’s agents">
        {CAPABILITIES.map((capability, position) => (
          <button
            key={capability.id}
            type="button"
            className={[styles.agent, "press-scale"].join(" ")}
            aria-pressed={index === position}
            onClick={() => setIndex(position)}
            onFocus={() => setIndex(position)}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setIndex(position);
            }}
          >
            <span
              className={styles.agentContents}
              data-preview-intro
              data-agent-selected={index === position}
            >
              <AgentSectionIcon
                id={"preview-" + capability.id}
                icon={capability.icon}
                tone={capability.tone}
                size="roster-dashboard"
                treatment="profile"
                profileStyle={
                  PALETTE[
                    capability.id as keyof typeof PALETTE
                  ] as CSSProperties
                }
              />
              <AgentTabLabel data-tone="primary">
                {capability.title}
              </AgentTabLabel>
            </span>
          </button>
        ))}
      </div>
      <div
        className={styles.agentExplanation}
        aria-live={cycling ? "off" : "polite"}
      >
        <div key={selected.id} data-preview-reveal>
          <CardTitle>{selected.title}</CardTitle>
          <RowDescription>
            {copy?.introPremise ||
              copy?.setupBlurb ||
              selected.previewLabel ||
              selected.description}
          </RowDescription>
        </div>
      </div>
      <CaptionText className={styles.agentHint}>
        Tap an agent to explore
      </CaptionText>
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
        ? "Your people, closer."
        : step === 2
          ? "A little help. Every day."
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
                  ? "Circles for every part of your life."
                  : step === 2
                    ? "Your private agents, together in One."
                    : "Talk or type. Let One help you."}
              </BodyText>
            </div>

            <section
              key={step}
              className={`${styles.stage} motion-step-enter`}
              aria-label={title}
            >
              {step === 1 ? (
                <CircleStory />
              ) : step === 2 ? (
                <AgentStory />
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
            {/* Progress starts at the first preview (Circles). The welcome
                screen has no footer, so it gets no dash of its own. */}
            <nav className={styles.progress} aria-label="Preview screens">
              {["Circles", "Agents", "Get started"].map((label, index) => {
                const target = index + 1;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-label={`Screen ${index + 1}: ${label}`}
                    aria-current={step === target ? "step" : undefined}
                    disabled={target > furthestStep}
                    onClick={() => moveTo(target)}
                  >
                    <span />
                  </button>
                );
              })}
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
                  ? "See what’s next"
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
