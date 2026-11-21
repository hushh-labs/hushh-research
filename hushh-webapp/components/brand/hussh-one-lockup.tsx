"use client";

import { cn } from "@/lib/utils";

/**
 * Pure vector outlines of the canonical `hussh` wordmark (SF Pro Display Bold geometry).
 * Split into `hu` (adaptive foreground ink) and `ssh` (active theme / Hussh accent)
 * with zero SVG <text> nodes so DOM textContent of parent headings remains exact.
 */
const HUSSH_HU_PATH =
  "M4.98 85.00L4.98 14.54L19.24 14.54L19.24 41.71L19.53 41.71Q21.56 36.83 25.63 34.21Q29.71 31.58 35.60 31.58Q41.28 31.58 45.39 34.10Q49.49 36.61 51.71 41.21Q53.93 45.82 53.93 52.14L53.93 85.00L39.67 85.00L39.67 55.07Q39.67 49.60 37.06 46.50Q34.45 43.40 29.59 43.40Q26.46 43.40 24.13 44.89Q21.80 46.38 20.52 48.99Q19.24 51.60 19.24 55.04L19.24 85.00ZM77.66 86.07Q71.92 86.07 67.88 83.72Q63.84 81.36 61.73 76.96Q59.62 72.55 59.62 66.45L59.62 32.66L73.88 32.66L73.88 63.49Q73.88 68.62 76.28 71.44Q78.68 74.26 83.49 74.26Q85.89 74.26 87.80 73.43Q89.72 72.60 91.10 71.07Q92.48 69.55 93.20 67.42Q93.92 65.30 93.92 62.73L93.92 32.66L108.18 32.66L108.18 85.00L93.92 85.00L93.92 76.38L93.63 76.38Q92.28 79.36 90.06 81.55Q87.84 83.73 84.74 84.90Q81.64 86.07 77.66 86.07Z";

const HUSSH_SSH_PATH =
  "M135.76 86.07Q128.54 86.07 123.46 83.99Q118.38 81.90 115.54 78.16Q112.69 74.43 112.11 69.47L112.06 69.03L125.97 69.03L126.07 69.47Q126.75 72.55 129.13 74.27Q131.52 75.99 135.79 75.99Q138.50 75.99 140.41 75.33Q142.33 74.67 143.37 73.44Q144.41 72.21 144.41 70.52L144.41 70.47Q144.41 68.37 142.89 67.09Q141.38 65.81 137.55 64.96L128.63 63.08Q123.58 62.00 120.17 59.98Q116.77 57.95 115.06 54.95Q113.35 51.94 113.35 48.04L113.35 47.99Q113.35 42.98 116.05 39.31Q118.75 35.63 123.69 33.61Q128.63 31.58 135.27 31.58Q142.23 31.58 147.09 33.82Q151.95 36.05 154.55 39.80Q157.15 43.54 157.30 48.13L157.32 48.62L144.19 48.62L144.14 48.23Q143.80 45.42 141.52 43.54Q139.25 41.67 135.27 41.67Q132.83 41.67 131.03 42.35Q129.22 43.03 128.24 44.28Q127.27 45.52 127.27 47.23L127.27 47.28Q127.27 48.60 127.94 49.65Q128.61 50.70 130.17 51.48Q131.73 52.26 134.35 52.85L143.26 54.73Q148.73 55.87 152.12 57.77Q155.51 59.66 157.09 62.42Q158.66 65.18 158.66 69.03L158.66 69.08Q158.66 74.21 155.75 78.03Q152.83 81.85 147.66 83.96Q142.50 86.07 135.76 86.07ZM184.03 86.07Q176.80 86.07 171.72 83.99Q166.65 81.90 163.80 78.16Q160.96 74.43 160.37 69.47L160.32 69.03L174.24 69.03L174.34 69.47Q175.02 72.55 177.40 74.27Q179.78 75.99 184.05 75.99Q186.76 75.99 188.68 75.33Q190.60 74.67 191.63 73.44Q192.67 72.21 192.67 70.52L192.67 70.47Q192.67 68.37 191.16 67.09Q189.64 65.81 185.81 64.96L176.90 63.08Q171.85 62.00 168.44 59.98Q165.03 57.95 163.32 54.95Q161.62 51.94 161.62 48.04L161.62 47.99Q161.62 42.98 164.31 39.31Q167.01 35.63 171.96 33.61Q176.90 31.58 183.54 31.58Q190.50 31.58 195.36 33.82Q200.21 36.05 202.81 39.80Q205.41 43.54 205.56 48.13L205.59 48.62L192.45 48.62L192.40 48.23Q192.06 45.42 189.79 43.54Q187.52 41.67 183.54 41.67Q181.10 41.67 179.29 42.35Q177.48 43.03 176.51 44.28Q175.53 45.52 175.53 47.23L175.53 47.28Q175.53 48.60 176.20 49.65Q176.87 50.70 178.44 51.48Q180.00 52.26 182.61 52.85L191.52 54.73Q196.99 55.87 200.39 57.77Q203.78 59.66 205.35 62.42Q206.93 65.18 206.93 69.03L206.93 69.08Q206.93 74.21 204.01 78.03Q201.09 81.85 195.93 83.96Q190.77 86.07 184.03 86.07ZM211.13 85.00L211.13 14.54L225.38 14.54L225.38 41.71L225.68 41.71Q227.70 36.83 231.78 34.21Q235.86 31.58 241.74 31.58Q247.43 31.58 251.53 34.10Q255.63 36.61 257.85 41.21Q260.08 45.82 260.08 52.14L260.08 85.00L245.82 85.00L245.82 55.07Q245.82 49.60 243.21 46.50Q240.59 43.40 235.74 43.40Q232.61 43.40 230.28 44.89Q227.95 46.38 226.67 48.99Q225.38 51.60 225.38 55.04L225.38 85.00Z";

export function HusshWordmarkSvg({
  className,
  monogramOnly = false,
}: {
  className?: string;
  monogramOnly?: boolean;
}) {
  if (monogramOnly) {
    return (
      <svg
        viewBox="3 12 108 76"
        fill="none"
        aria-hidden="true"
        data-testid="hussh-wordmark-svg"
        className={cn("h-[13px] w-auto shrink-0 select-none", className)}
      >
        <path d={HUSSH_HU_PATH} className="fill-foreground" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="3 12 259 76"
      fill="none"
      aria-hidden="true"
      data-testid="hussh-wordmark-svg"
      className={cn("h-[14px] w-auto shrink-0 select-none", className)}
    >
      <path d={HUSSH_HU_PATH} className="fill-foreground" />
      <path
        d={HUSSH_SSH_PATH}
        className="fill-[color:var(--app-accent,#b8894d)] dark:fill-[color:var(--app-accent-bright,var(--app-accent,#d8a657))]"
      />
    </svg>
  );
}

/**
 * Unified `hussh One` lockup across the pinned Chats drawer card and header identity.
 * Keeps DOM text strictly equal to `label` (default `"One"`) while presenting
 * the themed `hussh` SVG wordmark optically aligned on the cap/baseline.
 */
export function HusshOneLockup({
  label = "One",
  variant = "drawer",
  active = false,
  className,
}: {
  label?: string;
  variant?: "drawer" | "header" | "rail";
  active?: boolean;
  className?: string;
}) {
  if (variant === "rail") {
    return (
      <span
        data-testid="hussh-one-lockup"
        data-lockup-variant="rail"
        className={cn("inline-flex items-center justify-center", className)}
      >
        <svg
          viewBox="110 12 152 76"
          fill="none"
          aria-hidden="true"
          data-testid="hussh-wordmark-svg"
          className="h-[11px] w-auto shrink-0 select-none"
        >
          <path
            d={HUSSH_SSH_PATH}
            className="fill-[color:var(--app-accent,#b8894d)] dark:fill-[color:var(--app-accent-bright,var(--app-accent,#d8a657))]"
          />
        </svg>
      </span>
    );
  }

  const isHeader = variant === "header";
  const isDefaultOne = label.trim().toLowerCase() === "one";

  return (
    <span
      data-testid="hussh-one-lockup"
      data-lockup-variant={variant}
      data-state={active ? "active" : undefined}
      className={cn(
        "inline-flex min-w-0 items-baseline",
        isHeader ? "gap-[5px]" : "gap-[6px]",
        className,
      )}
    >
      <HusshWordmarkSvg
        className={cn(
          "relative translate-y-[0.5px]",
          isHeader ? "h-[13.5px]" : "h-[14.5px]",
        )}
      />
      <span
        className={cn(
          "truncate font-semibold tracking-[-0.024em] text-foreground",
          !isDefaultOne &&
            "before:mr-1 before:font-normal before:text-muted-foreground/55 before:content-['·']",
          isHeader
            ? "text-[15.5px] leading-5"
            : "text-[15.5px] leading-tight",
        )}
      >
        {label}
      </span>
    </span>
  );
}
