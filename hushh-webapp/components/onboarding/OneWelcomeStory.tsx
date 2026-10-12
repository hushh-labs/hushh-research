"use client";

import { useId, type CSSProperties, type RefObject } from "react";
import { HushhMark } from "@/lib/morphy-ux/ui/hushh-mark";
import { OneRosterAgentIcon } from "@/components/icons/agents/one-roster-agent-icon";
import {
  FigmaHushhLogo,
  FigmaOneLogo,
  FigmaPrivacyNote,
} from "./FigmaOnboardingPrimitives";
import styles from "./IntroStep.module.css";

// Tile bounds in the original exports, normalized to their source canvases.
// Keep the original box, light beams and tile shells; render the roster glyphs
// as vectors so welcome and dashboard show the same agent identities.
const LIGHT_TILES = [
  [128, 300, 177, 170],
  [374, 253, 167, 162],
  [602, 300, 168, 178],
  [48, 476, 175, 165],
  [262, 460, 169, 168],
  [473, 452, 168, 159],
  [695, 497, 174, 162],
  [194, 635, 179, 173],
  [377, 690, 166, 152],
  [549, 636, 169, 163],
] as const;

// The nine roster agents plus the existing identity-card tile.
const TILE_AGENTS = [
  "location", "email", "wallet", "finance", "gmail",
  "calendar", "ria", "consent", "messages", "pkm",
] as const;
const TILE_ANGLES = [-15, 3, 15, -17, -10, 10, 18, -15, 5, 14] as const;
const DARK_TILES = [
  [385, 98, 192, 181],
  [666, 32, 183, 173],
  [910, 92, 194, 181],
  [312, 300, 191, 184],
  [545, 256, 184, 172],
  [778, 252, 184, 173],
  [987, 309, 195, 188],
  [480, 441, 188, 177],
  [675, 495, 161, 153],
  [846, 438, 187, 179],
] as const;

function WelcomeArtwork({ dark = false }: { dark?: boolean }) {
  const id = useId().replace(/:/g, "");
  const tiles = dark ? DARK_TILES : LIGHT_TILES;
  const width = dark ? 1536 : 950;
  const height = dark ? 1024 : 1698;
  const source = `/onboarding/figma/screen-${dark ? "8" : "2"}-art.png`;
  const box = dark ? ([750, 745] as const) : ([450, 925] as const);

  return (
    <svg
      viewBox={dark ? "0 0 1536 1024" : "0 90 950 1192"}
      className={`${styles.illustration} ${dark ? styles.darkArtwork : styles.lightArtwork}`}
      aria-hidden="true"
      data-welcome-artwork={dark ? "dark" : "light"}
    >
      <defs>
        <linearGradient id={`${id}-tile-surface`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={dark ? "#252c43" : "#fff"} />
          <stop offset="100%" stopColor={dark ? "#17253d" : "#fff"} />
        </linearGradient>
        <image
          id={`${id}-source`}
          href={source}
          width={width}
          height={height}
        />
        {dark && (
          <mask
            id={`${id}-brand`}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={width}
            height={height}
          >
            <rect width={width} height={height} fill="white" />
            {/* Remove the baked mark even before the shared image has loaded. */}
            <ellipse cx="747" cy="842" rx="74" ry="74" fill="black" />
            <ellipse cx="746" cy="885" rx="33" ry="43" fill="black" />
          </mask>
        )}
        <mask
          id={`${id}-base`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={width}
          height={height}
        >
          <rect width={width} height={height} fill="white" />
          {tiles.map(([x, y, w, h], index) => (
            <rect key={index} x={x} y={y} width={w} height={h} fill="black" />
          ))}
        </mask>
        {tiles.map(([x, y, w, h], index) => (
          <clipPath key={index} id={`${id}-tile-${index}`}>
            <rect x={x} y={y} width={w} height={h} />
          </clipPath>
        ))}
      </defs>
      <g mask={dark ? `url(#${id}-brand)` : undefined}>
        <use href={`#${id}-source`} mask={`url(#${id}-base)`} />
        {tiles.map(([x, y, w, h], index) => (
          <g
            key={index}
            className={styles.popTile}
            data-welcome-tile
            style={
              {
                transformOrigin: `${x + w / 2}px ${y + h / 2}px`,
                "--pop-x": `${box[0] - x - w / 2}px`,
                "--pop-y": `${box[1] - y - h / 2}px`,
                "--pop-delay": `${index * 45}ms`,
              } as CSSProperties
            }
          >
            <use
              href={`#${id}-source`}
              clipPath={`url(#${id}-tile-${index})`}
            />
            <g transform={`rotate(${TILE_ANGLES[index]} ${x + w / 2} ${y + h / 2})`}>
              <rect
                x={x + w / 2 - Math.min(w, h) * 0.4}
                y={y + h / 2 - Math.min(w, h) * 0.4}
                width={Math.min(w, h) * 0.8}
                height={Math.min(w, h) * 0.8}
                rx={Math.min(w, h) * 0.16}
                fill={`url(#${id}-tile-surface)`}
              />
              <OneRosterAgentIcon
                agentId={TILE_AGENTS[index]!}
                x={x + w / 2 - Math.min(w, h) * 0.26}
                y={y + h / 2 - Math.min(w, h) * 0.26}
                size={Math.min(w, h) * 0.52}
                data-welcome-agent={TILE_AGENTS[index]}
              />
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

/** The original welcome composition; the parent owns all navigation. */
export function OneWelcomeStory({
  headingRef,
  motionEnabled,
}: {
  headingRef: RefObject<HTMLDivElement | null>;
  motionEnabled: boolean;
}) {
  return (
    <>
      <header className={styles.welcomeBrand}>
        <FigmaHushhLogo className={styles.brand} />
      </header>
      <div
        className={styles.welcomeContent}
        data-motion={motionEnabled ? "animated" : "static"}
      >
        <div className={styles.artwork} aria-hidden="true">
          <div className={styles.artworkCanvas}>
            <WelcomeArtwork />
            <WelcomeArtwork dark />
            <HushhMark
              className={styles.quietMark}
              aria-hidden="true"
              priority
            />
          </div>
        </div>
        <div ref={headingRef} tabIndex={-1} className={styles.hero}>
          <h1 className={styles.title} aria-label="One">
            <FigmaOneLogo />
          </h1>
          <p className={styles.tagline}>Your agents. Yours to own.</p>
          <p className={styles.subtitle}>Your personal team of AI agents.</p>
        </div>
      </div>
    </>
  );
}

export function OneWelcomePrivacy() {
  return (
    <div className={styles.privacy}>
      <FigmaPrivacyNote>You choose what to share.</FigmaPrivacyNote>
    </div>
  );
}
