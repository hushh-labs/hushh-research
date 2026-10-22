"use client";

import type { ReactNode } from "react";
import { ProfilePreferenceAppearanceIcon, ProfilePreferenceAccentIcon, ProfilePreferenceVoiceIcon } from "./profile-pane-icons";
import { GeminiLogo } from "@/components/brand/gemini-logo";
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
          <span className={styles.icon}><ProfilePreferenceAppearanceIcon /></span>
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
          <span className={styles.icon}><ProfilePreferenceAccentIcon /></span>
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
          <span className={styles.icon}><GeminiLogo /></span>
          <RowCopy title="Gemini" description="Choose managed or BYOK." />
          <span className={`${styles.trailing} ${styles.chevron}`}><ChevronIcon /></span>
        </button>

        <button type="button" className={`${styles.row} ${styles.action}`} onClick={onVoiceClick}>
          <span className={styles.icon}><ProfilePreferenceVoiceIcon /></span>
          <RowCopy title="Voice" description="What One’s voice can do, and its safety controls." />
          <span className={`${styles.trailing} ${styles.chevron}`}><ChevronIcon /></span>
        </button>
      </div>
    </section>
  );
}
