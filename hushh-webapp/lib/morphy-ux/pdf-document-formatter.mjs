/**
 * Portable-document formatter for Hussh artifacts.
 *
 * Morphy UX owns the visual contract. Report scripts provide validated
 * Foundation tokens and content, then consume one of these audience profiles.
 * This module intentionally has no browser or React dependency so the PDF
 * renderer can use the same design grammar without creating a parallel theme.
 */

export const PDF_FORMATTER_PROFILES = Object.freeze({
  technical: Object.freeze({
    id: "technical",
    bodySize: "11.5px",
    lineHeight: "1.5",
    titleSize: "29px",
    sectionSize: "17px",
    sectionGap: "24px",
    codeSize: "9.6px",
    diagramSize: "13px",
  }),
  partner: Object.freeze({
    id: "partner",
    bodySize: "12px",
    lineHeight: "1.52",
    titleSize: "30px",
    sectionSize: "18px",
    sectionGap: "26px",
    codeSize: "10px",
    diagramSize: "13.5px",
  }),
  founder: Object.freeze({
    id: "founder",
    bodySize: "12.5px",
    lineHeight: "1.58",
    titleSize: "32px",
    sectionSize: "19px",
    sectionGap: "30px",
    codeSize: "10px",
    diagramSize: "14px",
  }),
});

export const PDF_FORMATTER_THEMES = Object.freeze([
  "light",
  "dark",
  "molten-gold-light",
  "molten-gold",
]);

const REQUIRED_FOUNDATION_TOKENS = [
  "--foundation-off",
  "--foundation-surface",
  "--foundation-ink",
  "--foundation-hairline",
];

const REQUIRED_ACCENT_TOKENS = [
  "--app-accent-deep",
  "--app-accent-bright",
  "--app-accent-surface",
  "--app-accent-border",
  "--app-accent-hero-from",
  "--app-accent-hero-mid",
  "--app-accent-hero-to",
];

function requireTokens(tokens, names, source) {
  const missing = names.filter((name) => !tokens[name]);
  if (missing.length) {
    throw new Error(`Missing ${source} token(s): ${missing.join(", ")}`);
  }
}

export function resolvePdfFormatterProfile(profile = "technical") {
  const formatter = PDF_FORMATTER_PROFILES[profile];
  if (!formatter) {
    throw new Error(
      `Unsupported PDF formatter profile: ${profile}. Use ${Object.keys(PDF_FORMATTER_PROFILES).join(", ")}.`,
    );
  }
  return formatter;
}

/**
 * Print-safe twin of the app wordmark. Its colors remain CSS-token driven so
 * `hu` and the `ssh` foil follow the selected Foundation theme.
 */
export function renderPdfHusshWordmark() {
  return `<svg viewBox="60 -28 480 198" role="img" aria-label="Hussh" preserveAspectRatio="xMinYMid meet">
    <title>Hussh</title>
    <defs>
      <linearGradient id="hussh-pdf-wordmark-ssh" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="var(--brand-hero-from)" />
        <stop offset="50%" stop-color="var(--brand-hero-mid)" />
        <stop offset="100%" stop-color="var(--brand-hero-to)" />
      </linearGradient>
    </defs>
    <text x="300" y="135" text-anchor="middle" font-family='"SF Pro Display", "SF Pro", "Helvetica Neue", Inter, system-ui, sans-serif' font-weight="700" font-size="160" letter-spacing="-5.6">
      <tspan fill="var(--brand-ink)">hu</tspan><tspan fill="url(#hussh-pdf-wordmark-ssh)">ssh</tspan>
    </text>
  </svg>`;
}

/**
 * Produces the semantic CSS token bridge used by the Markdown-to-PDF renderer.
 * The `ssh` wordmark foil always comes from the selected app accent tokens:
 * default Foundation Blue in light/dark, or the explicit Molten Gold variant.
 */
export function createPdfDocumentFormatter({ theme, profile, foundation, accent }) {
  if (!PDF_FORMATTER_THEMES.includes(theme)) {
    throw new Error(`Unsupported PDF formatter theme: ${theme}.`);
  }

  requireTokens(foundation, REQUIRED_FOUNDATION_TOKENS, "Morphy Foundation");
  requireTokens(accent, REQUIRED_ACCENT_TOKENS, "Morphy accent");
  const selectedProfile = resolvePdfFormatterProfile(profile);
  const dark = theme === "dark" || theme === "molten-gold";
  const codePalette = dark
    ? {
        background: "#272822",
        border: "#49483e",
        foreground: "#f8f8f2",
        key: "#f92672",
        string: "#e6db74",
        literal: "#ae81ff",
      }
    : {
        background: "#fbfbfa",
        border: "#d6d6d2",
        foreground: "#272822",
        key: "#9c1c62",
        string: "#2e6b2e",
        literal: "#5b3f99",
      };

  return {
    id: selectedProfile.id,
    chromeColor: dark ? "rgba(235,235,245,.62)" : "rgba(60,60,67,.62)",
    css: `
      color-scheme: ${dark ? "dark" : "light"};
      --bg: ${foundation["--foundation-off"]};
      --bg-secondary: ${foundation["--foundation-surface"]};
      --bg-tertiary: ${foundation["--foundation-hairline"]};
      --fg: ${foundation["--foundation-ink"]};
      --fg-secondary: color-mix(in srgb, ${foundation["--foundation-ink"]} 78%, ${foundation["--foundation-off"]});
      --fg-tertiary: color-mix(in srgb, ${foundation["--foundation-ink"]} 54%, ${foundation["--foundation-off"]});
      --separator: ${foundation["--foundation-hairline"]};
      --separator-strong: ${accent["--app-accent-border"]};
      --accent: ${accent["--app-accent-deep"]};
      --link: ${dark ? accent["--app-accent-bright"] : accent["--app-accent-deep"]};
      --accent-soft: ${accent["--app-accent-surface"]};
      --accent-surface: ${accent["--app-accent-surface"]};
      --blue: ${accent["--app-accent-bright"]};
      --diagram-bg: ${foundation["--foundation-surface"]};
      --brand-ink: ${foundation["--foundation-ink"]};
      --brand-hero-from: ${accent["--app-accent-hero-from"]};
      --brand-hero-mid: ${accent["--app-accent-hero-mid"]};
      --brand-hero-to: ${accent["--app-accent-hero-to"]};
      --pdf-body-size: ${selectedProfile.bodySize};
      --pdf-line-height: ${selectedProfile.lineHeight};
      --pdf-title-size: ${selectedProfile.titleSize};
      --pdf-section-size: ${selectedProfile.sectionSize};
      --pdf-section-gap: ${selectedProfile.sectionGap};
      --pdf-code-size: ${selectedProfile.codeSize};
      --pdf-diagram-size: ${selectedProfile.diagramSize};
      /* Sublime-inspired light palette; Monokai remains canonical in dark themes. */
      --code-bg: ${codePalette.background};
      --code-border: ${codePalette.border};
      --code-fg: ${codePalette.foreground};
      --code-key: ${codePalette.key};
      --code-string: ${codePalette.string};
      --code-literal: ${codePalette.literal};`,
  };
}
