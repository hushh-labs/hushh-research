"use client";

/**
 * ConsentLiveDashboard
 * =====================
 * Hero feature: real-time consent activity feed powered by SSE + GSAP.
 *
 * Reads from useConsentStore. Mount useConsentSSE separately near root.
 *
 * GSAP animations:
 *   - Panel entrance: staggered fade+slide on mount
 *   - ActivityCard: slide-in from top on each new event
 *   - SSE status dot: repeating opacity pulse when connected
 *   - Empty state: scale fade-in when feed empties
 *   - Pending badge: scale pop when count changes
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import {
  useConsentStore,
  useConsentSSE,
  type ConsentActivityItem,
  type SSEConnectionStatus,
} from "@/lib/consent/use-consent-store";

// ============================================================================
// Constants
// ============================================================================

const EVENT_META = {
  consent_granted: {
    label: "Approved",
    textColor: "text-emerald-400",
    cardBg: "bg-emerald-500/8 border-emerald-500/15",
    dotColor: "bg-emerald-400",
    iconBg: "bg-emerald-500/15",
    icon: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M2 6.5L4.5 9L10 3"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  consent_denied: {
    label: "Denied",
    textColor: "text-rose-400",
    cardBg: "bg-rose-500/8 border-rose-500/15",
    dotColor: "bg-rose-400",
    iconBg: "bg-rose-500/15",
    icon: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  consent_revoked: {
    label: "Revoked",
    textColor: "text-amber-400",
    cardBg: "bg-amber-500/8 border-amber-500/15",
    dotColor: "bg-amber-400",
    iconBg: "bg-amber-500/15",
    icon: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M3.5 6H8.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
} as const;

const SSE_STATUS_META: Record<
  SSEConnectionStatus,
  { dotColor: string; label: string; pulse: boolean }
> = {
  connected:    { dotColor: "bg-emerald-400",    label: "Live",           pulse: true  },
  connecting:   { dotColor: "bg-amber-400",       label: "Connecting…",   pulse: false },
  reconnecting: { dotColor: "bg-amber-400",       label: "Reconnecting…", pulse: false },
  error:        { dotColor: "bg-rose-400",        label: "Disconnected",  pulse: false },
  idle:         { dotColor: "bg-white/20",        label: "Idle",          pulse: false },
};

// ============================================================================
// ActivityCard
// ============================================================================

function ActivityCard({ item }: { item: ConsentActivityItem }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const meta = EVENT_META[item.type];

  // Slide-in from top on mount
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    gsap.fromTo(
      el,
      { y: -28, opacity: 0, scale: 0.98 },
      { y: 0, opacity: 1, scale: 1, duration: 0.38, ease: "power3.out" }
    );
  }, []);

  return (
    <div
      ref={cardRef}
      className={`relative flex items-start gap-3 rounded-xl border p-3.5 ${meta.cardBg} will-change-transform`}
    >
      {/* Icon */}
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.iconBg} ${meta.textColor}`}
      >
        {meta.icon}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-xs font-semibold tracking-wide ${meta.textColor}`}>
            {meta.label}
            {item.reused && (
              <span className="ml-1.5 rounded bg-white/5 px-1 py-px text-[10px] font-normal text-white/30">
                reused
              </span>
            )}
          </span>
          <span className="tabular-nums text-[11px] text-white/30">
            {formatTimeAgo(item.ts)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-sm text-white/75">
          {item.developer}
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-white/35">
          {item.scope}
        </p>
      </div>

      {/* Live entry dot */}
      <span
        className={`absolute right-3 top-3 h-1.5 w-1.5 rounded-full ${meta.dotColor} opacity-70`}
      />
    </div>
  );
}

// ============================================================================
// SSE Status Badge
// ============================================================================

function SSEStatusBadge({ status }: { status: SSEConnectionStatus }) {
  const dotRef = useRef<HTMLSpanElement>(null);
  const { pulse, dotColor, label } = SSE_STATUS_META[status];

  useEffect(() => {
    const el = dotRef.current;
    if (!el) return;

    if (!pulse) {
      gsap.killTweensOf(el);
      gsap.set(el, { opacity: 1 });
      return; // explicit: no cleanup needed for non-pulsing state
    }

    const tl = gsap.timeline({ repeat: -1, yoyo: true });
    tl.to(el, { opacity: 0.25, duration: 0.9, ease: "sine.inOut" });
    return () => { tl.kill(); };
  }, [pulse, status]);

  return (
    <div className="flex items-center gap-1.5">
      <span
        ref={dotRef}
        className={`h-2 w-2 rounded-full ${dotColor} will-change-opacity`}
      />
      <span className="text-[11px] font-medium text-white/40">{label}</span>
    </div>
  );
}

// ============================================================================
// Pending Badge
// ============================================================================

function PendingBadge({ count }: { count: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevCount = useRef(count);

  useEffect(() => {
    if (count !== prevCount.current && ref.current) {
      gsap.fromTo(
        ref.current,
        { scale: 1.35 },
        { scale: 1, duration: 0.3, ease: "back.out(2)" }
      );
    }
    prevCount.current = count;
  }, [count]);

  if (count === 0) return null;

  return (
    <span
      ref={ref}
      className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-300 will-change-transform"
    >
      {count} pending
    </span>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState({ status }: { status: SSEConnectionStatus }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    gsap.fromTo(
      ref.current,
      { opacity: 0, scale: 0.94 },
      { opacity: 1, scale: 1, duration: 0.4, ease: "power2.out" }
    );
  }, []);

  return (
    <div
      ref={ref}
      className="flex flex-col items-center justify-center py-14 text-center will-change-transform"
    >
      <span className="text-4xl opacity-10">◎</span>
      <p className="mt-4 text-sm text-white/25">
        {status === "connected"
          ? "Listening for consent events…"
          : status === "connecting" || status === "reconnecting"
            ? "Establishing connection…"
            : "Connect vault to see live activity"}
      </p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export interface ConsentLiveDashboardProps {
  /** Authenticated user ID — passed from your auth context */
  userId: string | null | undefined;
  /** VAULT_OWNER token — passed from useVault() */
  vaultOwnerToken: string | null | undefined;
  /** Optional Tailwind classes for the outer container */
  className?: string;
}

/**
 * ConsentLiveDashboard
 * =====================
 * Drop this anywhere inside a vault-gated layout.
 * It self-connects to SSE and animates consent events as they arrive.
 *
 * @example
 * <ConsentLiveDashboard
 *   userId={user?.uid}
 *   vaultOwnerToken={vaultOwnerToken}
 *   className="w-full max-w-md"
 * />
 */
export function ConsentLiveDashboard({
  userId,
  vaultOwnerToken,
  className = "",
}: ConsentLiveDashboardProps) {
  // ── Connect SSE → store ──────────────────────────────────────────────────
  useConsentSSE(userId, vaultOwnerToken);

  // ── Read store ───────────────────────────────────────────────────────────
  const { sseStatus, activityFeed, pendingCount, clearFeed } =
    useConsentStore();

  // ── Refs for panel entrance animations ──────────────────────────────────
  const headerRef = useRef<HTMLDivElement>(null);
  const feedWrapperRef = useRef<HTMLDivElement>(null);

  // Panel entrance (runs once on mount)
  useEffect(() => {
    const targets = [headerRef.current, feedWrapperRef.current].filter(Boolean);
    gsap.fromTo(
      targets,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.45, ease: "power2.out", stagger: 0.07 }
    );
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className={[
        "flex flex-col gap-4 rounded-2xl border border-white/8",
        "bg-white/[0.04] p-5 backdrop-blur-md",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* ── Header ── */}
      <div ref={headerRef} className="flex items-center justify-between opacity-0">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[13px] font-semibold tracking-wide text-white/80">
            Consent Activity
          </h2>
          <PendingBadge count={pendingCount} />
        </div>

        <div className="flex items-center gap-3">
          <SSEStatusBadge status={sseStatus} />
          {activityFeed.length > 0 && (
            <button
              onClick={clearFeed}
              className="text-[11px] text-white/25 transition-colors hover:text-white/55"
              aria-label="Clear activity feed"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Feed ── */}
      <div ref={feedWrapperRef} className="flex flex-col gap-2 opacity-0">
        {activityFeed.length === 0 ? (
          <EmptyState status={sseStatus} />
        ) : (
          activityFeed.map((item) => (
            <ActivityCard key={item.id} item={item} />
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Utility
// ============================================================================

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}