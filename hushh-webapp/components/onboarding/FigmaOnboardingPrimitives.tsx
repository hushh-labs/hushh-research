/* Figma exports are kept as exact local bytes; the theme pair is intentionally
 * rendered as plain images so the app can swap the light/dark asset without
 * a remote optimizer changing the design asset. */
/* eslint-disable @next/next/no-img-element */
"use client";

import type { ButtonHTMLAttributes, ImgHTMLAttributes, ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import styles from "./FigmaOnboardingPrimitives.module.css";

const FIGMA_ASSET_ROOT = "/onboarding/figma";

type ThemeAssetProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  lightSrc: string;
  darkSrc: string;
};

function ThemeAsset({
  lightSrc,
  darkSrc,
  className,
  alt,
  ...props
}: ThemeAssetProps) {
  return (
    <>
      <img
        {...props}
        src={lightSrc}
        alt={alt ?? ""}
        className={cn(className, styles.themeLight)}
      />
      <img
        {...props}
        src={darkSrc}
        alt={alt ?? ""}
        className={cn(className, styles.themeDark)}
      />
    </>
  );
}

type FigmaIllustrationVariant = "intro" | "auth" | "phone";

const ILLUSTRATION_ASSETS: Record<
  FigmaIllustrationVariant,
  { lightSrc: string; darkSrc: string }
> = {
  intro: {
    lightSrc: `${FIGMA_ASSET_ROOT}/screen-2-art.png`,
    darkSrc: `${FIGMA_ASSET_ROOT}/screen-8-art.png`,
  },
  auth: {
    lightSrc: `${FIGMA_ASSET_ROOT}/screen-3-art.png`,
    darkSrc: `${FIGMA_ASSET_ROOT}/screen-7-art.png`,
  },
  phone: {
    lightSrc: `${FIGMA_ASSET_ROOT}/screen-4-art.png`,
    darkSrc: `${FIGMA_ASSET_ROOT}/screen-7-art.png`,
  },
};

export function FigmaThemeAsset({
  lightSrc,
  darkSrc,
  ...props
}: ThemeAssetProps) {
  return <ThemeAsset lightSrc={lightSrc} darkSrc={darkSrc} {...props} />;
}

export function FigmaIllustration({
  variant,
  className,
}: {
  variant: FigmaIllustrationVariant;
  className?: string;
}) {
  const assets = ILLUSTRATION_ASSETS[variant];

  return (
    <div
      className={cn(
        styles.illustration,
        variant === "intro" ? styles.illustrationIntro : styles.illustrationCompact,
        className,
      )}
      aria-hidden="true"
    >
      <ThemeAsset
        {...assets}
        alt=""
        className={styles.illustrationImage}
        draggable={false}
      />
    </div>
  );
}

export function FigmaHushhLogo({ className }: { className?: string }) {
  return (
    <ThemeAsset
      lightSrc={`${FIGMA_ASSET_ROOT}/hushh-light.svg`}
      darkSrc={`${FIGMA_ASSET_ROOT}/hushh-dark.svg`}
      alt="hushh"
      className={cn(styles.hushhLogo, className)}
      draggable={false}
    />
  );
}

export function FigmaOneLogo({ className }: { className?: string }) {
  return (
    <ThemeAsset
      lightSrc={`${FIGMA_ASSET_ROOT}/one-light.svg`}
      darkSrc={`${FIGMA_ASSET_ROOT}/one-dark.svg`}
      alt="One"
      className={cn(styles.oneLogo, className)}
      draggable={false}
    />
  );
}

export function FigmaBackButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type="button"
      className={cn(styles.backButton, className)}
    >
      <ChevronLeft aria-hidden="true" className={styles.backIcon} strokeWidth={1.8} />
    </button>
  );
}

export function FigmaPrivacyNote({ children }: { children: ReactNode }) {
  return (
    <div className={styles.privacyNote}>
      <ThemeAsset
        lightSrc={`${FIGMA_ASSET_ROOT}/privacy-light.svg`}
        darkSrc={`${FIGMA_ASSET_ROOT}/privacy-dark.svg`}
        alt=""
        className={styles.privacyIcon}
        draggable={false}
      />
      <span>{children}</span>
    </div>
  );
}

export function FigmaProviderIcon({ provider }: { provider: "apple" | "google" }) {
  return (
    <img
      src={`${FIGMA_ASSET_ROOT}/${provider}.png`}
      alt=""
      aria-hidden="true"
      className={cn(
        styles.providerIcon,
        provider === "apple" ? styles.appleIcon : styles.googleIcon,
      )}
      draggable={false}
    />
  );
}

export function FigmaCountryFlag() {
  return (
    <ThemeAsset
      lightSrc={`${FIGMA_ASSET_ROOT}/flag-light.png`}
      darkSrc={`${FIGMA_ASSET_ROOT}/flag-dark.png`}
      alt=""
      className={styles.countryFlag}
      draggable={false}
    />
  );
}
