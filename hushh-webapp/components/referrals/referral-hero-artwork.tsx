"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  CalendarAgentIcon, ConsentAgentIcon, FinanceAgentIcon, GmailAgentIcon,
  LocationAgentIcon, MemoryAgentIcon, MessageSquareIcon, RiaAgentIcon,
  WalletAgentIcon, CheckIcon,
} from "@/components/icons";

// Each orbit agent owns the matching everyday example in the rotating card.
const AGENTS = [
  { label: "Location", Icon: LocationAgentIcon, color: "var(--app-accent)", example: "Find nearby cafés." },
  { label: "Mail", Icon: GmailAgentIcon, color: "#e11d48", example: "Draft your reply." },
  { label: "Calendar", Icon: CalendarAgentIcon, color: "#0284c7", example: "Plan your day." },
  { label: "Finance", Icon: FinanceAgentIcon, color: "#10b981", example: "Track your money." },
  { label: "Advisor", Icon: RiaAgentIcon, color: "#8b5cf6", example: "Explore options." },
  { label: "Wallet", Icon: WalletAgentIcon, color: "#f59e0b", example: "Cards, in reach." },
  { label: "Consent", Icon: ConsentAgentIcon, color: "#f97316", example: "You choose access." },
  { label: "Memory", Icon: MemoryAgentIcon, color: "#6366f1", example: "Keep what matters." },
  { label: "Messages", Icon: MessageSquareIcon, color: "var(--app-accent)", example: "Make dinner plans." },
] as const;

const REWARD_PATH = "M1000 370 C1010 430 1065 490 1145 535";
const ORBIT_SECONDS = 60;
const AGENT_STEP_DEGREES = 360 / AGENTS.length;
// The closest point on the elliptical orbit to the example card is -121 degrees.
// Begin each example half a badge-spacing before its agent reaches that point.
const exampleDelay = (index: number) => {
  const startAngle = -90 + index * AGENT_STEP_DEGREES;
  const travel = ((-121 - startAngle - AGENT_STEP_DEGREES / 2) % 360 + 360) % 360;
  return `${travel / 360 * ORBIT_SECONDS - ORBIT_SECONDS}s`;
};

// One clock moves the badges; the reverse clock keeps every icon and label upright.
// Scaling the orbit and undoing that scale on each badge gives an elliptical path.
const ORBIT_STYLE = `
  .referral-orbit-motion, .referral-orbit-upright {
    transform-origin: 0 0;
    transform-box: view-box;
    animation: referral-agent-orbit ${ORBIT_SECONDS}s linear infinite;
  }
  .referral-orbit-upright { animation-name: referral-agent-upright; }
  .referral-agent-example {
    opacity: 0;
    animation: referral-example-cycle ${ORBIT_SECONDS}s linear infinite;
  }
  .referral-hero-art[data-live-examples="true"] .referral-agent-example {
    animation: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 180ms ease, transform 180ms ease;
  }
  .referral-hero-art[data-live-examples="true"] .referral-agent-example[data-selected="true"] {
    opacity: 1;
    transform: translateY(0);
  }
  @keyframes referral-example-cycle {
    0% { opacity: 0; transform: translateY(5px); }
    .4%, 10.7% { opacity: 1; transform: translateY(0); }
    11.111%, 100% { opacity: 0; transform: translateY(-5px); }
  }
  .referral-reward-coin {
    offset-path: path("${REWARD_PATH}");
    offset-anchor: 0px 0px;
    offset-position: 0px 0px;
    offset-rotate: 0deg;
    animation: referral-reward-transfer 6s linear infinite;
  }
  .referral-reward-receipt {
    transform-box: fill-box;
    transform-origin: center bottom;
    animation: referral-reward-received 6s cubic-bezier(.22, .61, .36, 1) infinite;
  }
  .referral-hero-art[data-paused="true"] .referral-orbit-motion,
  .referral-hero-art[data-paused="true"] .referral-orbit-upright,
  .referral-hero-art[data-paused="true"] .referral-reward-coin,
  .referral-hero-art[data-paused="true"] .referral-agent-example,
  .referral-hero-art[data-paused="true"] .referral-reward-receipt { animation-play-state: paused; }
  @keyframes referral-agent-orbit { to { transform: rotate(360deg); } }
  @keyframes referral-agent-upright { to { transform: rotate(-360deg); } }
  @keyframes referral-reward-transfer {
    0% { offset-distance: 0%; opacity: 0; }
    12%, 18% { offset-distance: 0%; opacity: 1; }
    65% { offset-distance: 100%; opacity: 1; }
    71%, 100% { offset-distance: 100%; opacity: 0; }
  }
  /* Same clock as the coin: reveal only once it reaches the phone at 65%. */
  @keyframes referral-reward-received {
    0%, 65% { opacity: 0; transform: translateY(12px) scale(.88); }
    68% { opacity: 1; transform: translateY(-2px) scale(1.025); }
    72%, 93% { opacity: 1; transform: translateY(0) scale(1); }
    100% { opacity: 0; transform: translateY(-4px) scale(.98); }
  }
  @media (prefers-reduced-motion: reduce) {
    .referral-orbit-motion, .referral-orbit-upright { animation: none; }
    .referral-reward-coin { animation: none; offset-distance: 0%; opacity: 1; }
    .referral-reward-receipt { animation: none; opacity: 1; transform: none; }
    .referral-agent-example { animation: none; opacity: 0; transform: none; }
    .referral-agent-example:last-of-type { opacity: 1; }
    .referral-hero-art[data-live-examples="true"] .referral-agent-example { transition: none; }
  }
`;

/** The artwork is SVG; only the photograph is raster. No React work runs per frame. */
export function ReferralHeroArtworkSvg({
  paused = false,
  source = "/referrals/one-referral-fresh-faces.webp",
}: {
  paused?: boolean;
  source?: string;
}) {
  const artworkRef = useRef<SVGSVGElement>(null);
  const [selectedExample, setSelectedExample] = useState<number | null>(null);
  useLayoutEffect(() => {
    const art = artworkRef.current;
    if (!art) return;
    const card = art.querySelector<SVGGraphicsElement>('.referral-example-card');
    const badges = Array.from(art.querySelectorAll<SVGGraphicsElement>('.referral-orbit-upright'));
    if (!card || !badges.length) return;
    // Static renderers retain the CSS cycle when SVG geometry is unavailable.
    if (typeof card.getCTM !== "function" || typeof card.getBBox !== "function" || typeof DOMPoint === "undefined") return;
    // SVG-local coordinates exclude page scroll and sticky-shell movement.
    const centerInArtwork = (element: SVGGraphicsElement) => {
      const matrix = element.getCTM();
      if (!matrix) return null;
      const box = element.getBBox();
      return new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(matrix);
    };
    // Sample at 4Hz; React changes only when a different agent becomes nearest.
    const followNearest = () => {
      const target = centerInArtwork(card);
      if (!target) return;
      let nearest = 0;
      let shortest = Infinity;
      badges.forEach((badge, index) => {
        const center = centerInArtwork(badge);
        if (!center) return;
        const distance = Math.hypot(center.x - target.x, center.y - target.y);
        if (distance < shortest) { shortest = distance; nearest = index; }
      });
      setSelectedExample((previous) => previous === nearest ? previous : nearest);
    };
    followNearest();
    if (paused) return;
    const timer = window.setInterval(followNearest, 250);
    return () => window.clearInterval(timer);
  }, [paused]);
  const photoId = `referral-photo-${useId().replace(/:/g, "")}`;
  const goldId = `${photoId}-gold`;
  const fadeId = `${photoId}-fade`;
  return (
    <svg
      ref={artworkRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="650 0 1124 887"
      width={1124}
      height={887}
      preserveAspectRatio="xMidYMid meet"
      className="referral-hero-art"
      data-paused={paused}
      data-live-examples={selectedExample !== null}
      aria-hidden="true"
      focusable="false"
    >
      <style>{`${ORBIT_STYLE}@media (max-width: 860px) { .referral-photo-background { mask: url(#${fadeId}); } }`}</style>
      <defs>
        <image id={photoId} href={source} width={1774} height={887} />
        <radialGradient id={`${photoId}-edge`}>
          <stop offset=".72" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </radialGradient>
        <mask id={`${photoId}-portrait`} maskUnits="userSpaceOnUse" x={190} y={72} width={1455} height={728}>
          <ellipse cx={1200} cy={440} rx={440} ry={365} fill={`url(#${photoId}-edge)`} />
        </mask>
        <linearGradient id={goldId} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fff1ad" />
          <stop offset=".45" stopColor="#f6c74c" />
          <stop offset="1" stopColor="#ce8c1d" />
        </linearGradient>
        <linearGradient id={`${fadeId}-gradient`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#ffffff" stopOpacity={0} />
          <stop offset=".16" stopColor="#ffffff" />
        </linearGradient>
        <mask id={fadeId} maskUnits="userSpaceOnUse" x={0} y={0} width={1774} height={887}>
          <rect width={1774} height={887} fill={`url(#${fadeId}-gradient)`} />
        </mask>
      </defs>
      <g className="referral-photo-background">
        <rect width={1774} height={887} fill="#e4f1ff" />
        <g mask={`url(#${photoId}-portrait)`}>
          <use href={`#${photoId}`} transform="translate(190 72) scale(.82)" />
        </g>
      </g>
      <path d={REWARD_PATH} fill="none" stroke="#ffffff" strokeWidth={4} strokeDasharray="1 12" strokeLinecap="round" />
      <path d="M958 436 Q1010 442 1037 425" fill="none" stroke="#ffffff" strokeWidth={3} strokeDasharray="1 11" strokeLinecap="round" opacity={0.85} />
      <g fontFamily="Arial, sans-serif" transform="translate(880 175)">
        <rect className="referral-example-card" width={270} height={88} rx={20} fill="#ffffff" fillOpacity={0.96} />
        {AGENTS.map(({ label, Icon, color, example }, index) => (
          <g key={label} className="referral-agent-example" data-selected={selectedExample === index} style={{ animationDelay: exampleDelay(index) }}>
            <Icon x={18} y={28} size={32} weight="duotone" color={color} />
            <text x={66} y={31} fill="#61758d" fontSize={18}>{label}</text>
            <text x={66} y={62} fill="#172d47" fontSize={20} fontWeight={500}>{example}</text>
          </g>
        ))}
      </g>
      <path d="m1131 532 14 3-6-13" fill="none" stroke="#ffffff" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      <g className="referral-reward-coin">
        <circle cy={3} r={29} fill="#8a5b11" fillOpacity={0.14} />
        <circle r={27} fill={`url(#${goldId})`} stroke="#b67b1b" strokeWidth={2} />
        <circle r={22} fill="none" stroke="#fff2b9" strokeWidth={1.5} />
        <text y={10} textAnchor="middle" fill="#89590c" fontFamily="Arial, sans-serif" fontSize={31} fontWeight={600}>$</text>
      </g>
      <g className="referral-reward-receipt" fontFamily="Arial, sans-serif">
        <rect x={1370} y={365} width={215} height={82} rx={24} fill="#ffffff" fillOpacity={0.97} />
        <circle cx={1396} cy={391} r={13} fill="#24bf4b" />
        <CheckIcon x={1385} y={380} size={22} weight="regular" color="#ffffff" />
        <text x={1420} y={400} fill="#17232d" fontSize={34} fontWeight={700}>+$10</text>
        <text x={1420} y={427} fill="#4a5763" fontSize={18}>Received</text>
      </g>
      <ellipse cx={1200} cy={440} rx={485} ry={365} fill="none" stroke="#99b8d8" strokeOpacity={0.5} strokeWidth={1.5} />
      <g transform="translate(1200 440) scale(1 0.7525773196)">
        <g className="referral-orbit-motion">
          {AGENTS.map(({ label, Icon, color }, index) => {
            const angle = -90 + index * AGENT_STEP_DEGREES;
            return (
              <g key={label} transform={`rotate(${angle}) translate(485 0) rotate(${-angle})`}>
                <g className="referral-orbit-upright">
                  <g transform="scale(1 1.3287671233)">
                    <circle r={42} fill="#ffffff" fillOpacity={0.96} />
                    <circle r={40} fill={color} fillOpacity={0.035} />
                    <Icon x={-18} y={-27} size={36} weight="duotone" color={color} />
                    <text y={25} textAnchor="middle" fill="#45566c" fontFamily="Arial, sans-serif" fontSize={16}>
                      {label}
                    </text>
                  </g>
                </g>
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
}

export function ReferralHeroArtwork({ active }: { active: boolean }) {
  return <ReferralHeroArtworkSvg paused={!active} />;
}
