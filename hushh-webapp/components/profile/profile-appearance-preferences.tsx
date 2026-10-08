"use client";

import type { ReactNode } from "react";
import { ThemeToggleLean } from "@/components/theme-toggle";
import type { AppAccent } from "@/lib/theme/accent";
import styles from "./profile-appearance-preferences.module.css";

type AppearancePreferencesProps = {
  accent: AppAccent;
  onAccentChange: (accent: AppAccent) => void;
  onGeminiClick: () => void;
  onVoiceClick: () => void;
};

function RowIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function SlidersIcon() {
  return (
    <RowIcon>
      <path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2" />
      <circle cx="14" cy="6" r="2" className={styles.accentFill} />
      <circle cx="9" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </RowIcon>
  );
}

function DropletIcon() {
  return (
    <RowIcon>
      <path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z" />
      <path d="M9 15.2c.5 1.4 1.5 2.1 3 2.2" className={styles.accentStroke} />
    </RowIcon>
  );
}

function SparkleIcon() {
  return (
    <RowIcon>
      <path d="M12 3c.8 4.7 3.3 7.2 8 8-4.7.8-7.2 3.3-8 8-.8-4.7-3.3-7.2-8-8 4.7-.8 7.2-3.3 8-8Z" />
      <path d="M19 3v4M17 5h4" className={styles.accentStroke} />
    </RowIcon>
  );
}

function VoiceIcon() {
  return (
    <RowIcon>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
      <path d="M5 8.5A8 8 0 0 0 8.2 17M19 8.5a8 8 0 0 1-3.2 8.5" className={styles.accentStroke} />
    </RowIcon>
  );
}

function ChevronIcon() {
  return (
    <RowIcon>
      <path d="m9 6 6 6-6 6" />
    </RowIcon>
  );
}

function RowCopy({ title, description }: { title: string; description: string }) {
  return (
    <span className={styles.copy}>
      <span className={styles.title}>{title}</span>
      <span className={styles.description}>{description}</span>
    </span>
  );
}

/** The Profile pane owns the header and glass sheet; this is its inner card. */
export function ProfileAppearancePreferences({
  accent,
  onAccentChange,
  onGeminiClick,
  onVoiceClick,
}: AppearancePreferencesProps) {
  return (
    <section className={styles.root} aria-label="Appearance and preferences" data-profile-appearance-preferences>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.icon}><SlidersIcon /></span>
          <RowCopy title="Appearance" description="Light, dark, or system." />
          <span className={styles.trailing}>
            <ThemeToggleLean
              size="expanded"
              showLabels
              className={styles.themeControl}
            />
          </span>
        </div>

        <div className={styles.row}>
          <span className={styles.icon}><DropletIcon /></span>
          <RowCopy title="Accent" description="Choose the app accent." />
          <span className={styles.trailing}>
            <select
              className={styles.select}
              value={accent}
              onChange={(event) => onAccentChange(event.target.value as AppAccent)}
              aria-label="App accent color"
            >
              <option value="blue">iOS Blue</option>
              <option value="gold">Molten Gold</option>
            </select>
          </span>
        </div>

        <button type="button" className={`${styles.row} ${styles.action}`} onClick={onGeminiClick}>
          <span className={styles.icon}><SparkleIcon /></span>
          <RowCopy title="Gemini" description="Choose managed or BYOK." />
          <span className={`${styles.trailing} ${styles.chevron}`}><ChevronIcon /></span>
        </button>

        <button type="button" className={`${styles.row} ${styles.action}`} onClick={onVoiceClick}>
          <span className={styles.icon}><VoiceIcon /></span>
          <RowCopy title="Voice" description="What One’s voice can do, and its safety controls." />
          <span className={`${styles.trailing} ${styles.chevron}`}><ChevronIcon /></span>
        </button>
      </div>
    </section>
  );
}
