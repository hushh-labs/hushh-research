import { type ColorVariant, type ComponentEffect } from "./types";

// ============================================================================
// HUSHH GRADIENT PRESETS - CSS Variable Based
// All gradients use CSS variables from globals.css for consistent theming
// ============================================================================

export const gradientPresets = {
  // Primary brand gradient - Blue→Purple (auto-switches in dark mode via CSS vars)
  primary:
    "from-[var(--morphy-primary-start)] via-[var(--morphy-primary-mid)] to-[var(--morphy-primary-end)]",

  // Secondary gradient - Silver for subtle backgrounds
  secondary:
    "from-[var(--morphy-secondary-start)] to-[var(--morphy-secondary-end)]",

  // Accent gradient - Gold/Yellow (explicit, for special emphasis)
  accent: "from-[#fbbf24] to-[#f59e0b]",

  // Success - Emerald family
  success: "from-[#10b981] to-[#059669]",

  // Warning - Gold family
  warning: "from-[#fbbf24] to-[#f59e0b]",

  // Multi - Adapts to light/dark mode automatically via CSS vars
  multi: "from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)]",

  // Metallic - Silver in both modes
  metallic: "from-gray-100 via-gray-200 to-gray-300",

  // Metallic gradient with smooth transitions
  "mettalic-gradient":
    "from-[#f7f9fb] via-[#e5ebf2] to-[#cfd8e3] dark:from-[#404040] dark:via-[#525252] dark:to-[#737373]",
} as const;

// ============================================================================
// VARIANT STYLES - UNIVERSITY FOCUSED
// ============================================================================

export const getVariantStyles = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill"
): string => {
  switch (variant) {
    case "gradient":
      if (effect === "fill") {
        return `bg-gradient-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] text-white shadow-[0_18px_60px_var(--morphy-cta-shadow)] hover:brightness-105 transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/12 to-[var(--morphy-primary-end)]/12 border border-[var(--morphy-primary-start)]/24 text-[var(--morphy-primary-start)] hover:from-[var(--morphy-primary-start)] hover:to-[var(--morphy-primary-end)] hover:text-white transition-colors duration-200";
      } else {
        // Silver accent border in dark mode for hushh brand
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-white/20 dark:border-white/10 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "blue":
      if (effect === "fill") {
        return "bg-gradient-to-r from-[var(--morphy-primary-end)] to-[var(--morphy-primary-start)] text-white shadow-[0_18px_60px_var(--morphy-cta-shadow)] hover:brightness-105 transition-shadow transition-colors duration-200";
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/12 to-[var(--morphy-primary-end)]/12 border border-[var(--morphy-primary-start)]/24 text-[var(--morphy-primary-start)] hover:from-[var(--morphy-primary-end)] hover:to-[var(--morphy-primary-start)] hover:text-white transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-white/20 dark:border-white/10 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "blue-gradient":
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.primary} text-white dark:text-black shadow-[0_18px_60px_var(--morphy-cta-shadow)] hover:brightness-105 transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/12 to-[var(--morphy-primary-end)]/12 border border-[var(--morphy-primary-start)]/24 text-[var(--morphy-primary-start)] hover:from-[var(--morphy-primary-start)] hover:to-[var(--morphy-primary-end)] hover:text-white transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-white/20 dark:border-white/10 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "yellow":
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.accent} text-black shadow-md transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#fbbf24]/12 to-[#f59e0b]/12 border border-[#fbbf24]/24 text-[#b97700] hover:from-[#fbbf24] hover:to-[#f59e0b] hover:text-black transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-[#fbbf24]/20 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "yellow-gradient":
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.accent} text-black shadow-lg transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#fbbf24]/12 to-[#f59e0b]/12 border border-[#fbbf24]/24 text-[#b97700] hover:from-[#fbbf24] hover:to-[#f59e0b] hover:text-black transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-[#fbbf24]/20 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "purple":
    case "purple-gradient":
      // Use primary gradient (purple is part of hushh brand)
      if (effect === "fill") {
        return "bg-gradient-to-r from-[#7c3aed] to-[#8b5cf6] text-white shadow-md hover:brightness-105 transition-shadow transition-colors duration-200";
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#7c3aed]/12 to-[#8b5cf6]/12 border border-[#7c3aed]/24 text-[#7c3aed] hover:from-[#7c3aed] hover:to-[#8b5cf6] hover:text-white transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-[var(--morphy-primary-start)]/20 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "green":
    case "green-gradient":
      // Use success gradient (emerald)
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.success} text-white shadow-md hover:brightness-105 transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#10b981]/12 to-[#059669]/12 border border-[#10b981]/24 text-[#0f9a72] hover:from-[#10b981] hover:to-[#059669] hover:text-white transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-[#10b981]/20 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "orange":
    case "orange-gradient":
      // Use accent/warning gradient (gold/orange)
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.warning} text-black shadow-md hover:brightness-105 transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#f59e0b]/12 to-[#d97706]/12 border border-[#f59e0b]/24 text-[#c77708] hover:from-[#f59e0b] hover:to-[#d97706] hover:text-black transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-[#f59e0b]/20 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "metallic":
      if (effect === "fill") {
        return `bg-gradient-to-br ${gradientPresets.metallic} text-gray-900 shadow-md transition-shadow transition-colors duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-br from-gray-50/10 via-gray-100/10 to-gray-200/10 border border-gray-200/20 text-gray-700 transition-colors duration-200";
      } else {
        return `bg-gradient-to-br ${gradientPresets.metallic} shadow-[0px_4px_12px_rgba(0,0,0,0.1)] border border-gray-200/20 backdrop-blur-[6px] transition-shadow transition-colors duration-200`;
      }

    case "mettalic-gradient":
      if (effect === "fill") {
        return [
          `bg-gradient-to-br ${gradientPresets["mettalic-gradient"]}`,
          // Subtle gloss highlight to prevent logo camouflage
          "bg-[radial-gradient(120%_120%_at_30%_10%,rgba(255,255,255,0.35)_0%,rgba(255,255,255,0.12)_38%,transparent_62%)]",
          "dark:bg-[radial-gradient(120%_120%_at_30%_10%,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.06)_34%,transparent_60%)]",
          "bg-blend-overlay",
          // Gentle inner-edges for depth
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.20),inset_0_-1px_0_rgba(0,0,0,0.12),0px_6px_18px_rgba(0,0,0,0.12)]",
          // Slight ring to separate from page background
          "ring-1 ring-gray-300/40 dark:ring-gray-700/50",
          "text-gray-900 dark:text-gray-100 transition-shadow transition-colors duration-200",
        ].join(" ");
      } else if (effect === "fade") {
        return [
          `bg-gradient-to-br ${gradientPresets["mettalic-gradient"]}`,
          "bg-[radial-gradient(120%_120%_at_30%_10%,rgba(255,255,255,0.25)_0%,rgba(255,255,255,0.10)_35%,transparent_60%)]",
          "dark:bg-[radial-gradient(120%_120%_at_30%_10%,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.05)_30%,transparent_58%)]",
          "bg-blend-overlay",
          "border border-gray-300/30 dark:border-gray-700/40",
          "text-gray-800 dark:text-gray-100 transition-colors duration-200",
        ].join(" ");
      } else {
        // glass: render gradient plus subtle gloss with reduced blur
        return [
          `bg-gradient-to-br ${gradientPresets["mettalic-gradient"]}`,
          "bg-[radial-gradient(120%_120%_at_30%_10%,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0.10)_34%,transparent_60%)]",
          "dark:bg-[radial-gradient(120%_120%_at_30%_10%,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0.04)_28%,transparent_56%)]",
          "bg-blend-overlay",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.10),0px_6px_18px_rgba(0,0,0,0.12)]",
          "border border-gray-300/30 dark:border-gray-700/40",
          "backdrop-blur-[4px] transition-shadow transition-colors duration-200",
        ].join(" ");
      }

    case "multi":
      if (effect === "fill") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] text-white shadow-md hover:brightness-105 transition-shadow transition-colors duration-200";
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/12 to-[var(--morphy-primary-end)]/12 border border-[var(--morphy-primary-start)]/24 text-[var(--morphy-primary-start)] hover:from-[var(--morphy-primary-start)] hover:to-[var(--morphy-primary-end)] hover:text-white transition-colors duration-200";
      } else {
        return "bg-white/50 dark:bg-black/50 shadow-sm border border-[var(--morphy-primary-start)]/20 dark:border-[#c0c0c0]/20 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60 transition-all duration-200";
      }

    case "black":
      return "text-black hover:text-black/80 transition-colors duration-200 bg-transparent border-none shadow-none";

    case "morphy":
      return "bg-foreground text-background shadow-md hover:opacity-90 transition-all duration-200 border-none font-bold";

    case "link":
      // Link buttons are low-emphasis brand actions (blue), without custom callsite styling.
      const baseLinkStyles =
        "text-[var(--brand-primary)] hover:text-[var(--brand-700)] dark:text-[var(--brand-200)] dark:hover:text-[var(--brand-100)] underline-offset-4 hover:underline font-semibold transition-colors duration-200";
      
      if (effect === "glass") {
        return `${baseLinkStyles} bg-white/50 dark:bg-black/50 shadow-sm border border-black/10 dark:border-white/10 backdrop-blur-md hover:bg-white/60 dark:hover:bg-black/60`;
      }
      
      if (effect === "fade") {
        return `${baseLinkStyles} bg-black/5 dark:bg-white/5 border border-transparent hover:bg-black/10 dark:hover:bg-white/10`;
      }

      return `${baseLinkStyles} bg-transparent border-none shadow-none`;


    case "destructive":
      if (effect === "fill") {
        return "bg-destructive text-white hover:bg-destructive/90 shadow-md transition-all duration-200 border border-transparent";
      } else if (effect === "fade") {
        return "bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive/15 transition-all duration-200";
      } else {
        // glass
        return "bg-transparent text-red-600 border border-red-300/80 shadow-sm backdrop-blur-md hover:bg-red-50 dark:bg-transparent dark:text-red-600 dark:border-red-300/80 dark:hover:bg-red-50 transition-all duration-200";
      }

    case "none":
    default:
      if (effect === "fill") {
        return "bg-background text-foreground border border-border/60 hover:bg-muted/60 hover:text-foreground shadow-none transition-colors duration-200";
      }
      if (effect === "fade") {
        return "bg-muted/55 text-foreground border border-transparent shadow-none backdrop-blur-none hover:bg-muted/80 hover:text-foreground transition-colors duration-200";
      }
      return "bg-white/40 dark:bg-black/40 text-foreground hover:text-foreground border border-white/20 dark:border-white/10 shadow-sm backdrop-blur-md hover:bg-white/50 dark:hover:bg-black/50 transition-all duration-200";
  }
};

// ============================================================================
// VARIANT STYLES WITHOUT HOVER (FOR NON-RIPPLE CARDS)
// ============================================================================

export const getVariantStylesNoHover = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill"
): string => {
  switch (variant) {
    case "gradient":
      if (effect === "fill") {
        // Silver gradient in dark mode for hushh brand
        return `bg-gradient-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] dark:from-[#c0c0c0] dark:to-[#a0a0a0] text-white dark:text-black shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/10 to-[var(--morphy-primary-end)]/10 dark:from-[#c0c0c0]/10 dark:to-[#a0a0a0]/10 border border-[var(--morphy-primary-start)]/20 dark:border-[#c0c0c0]/20 text-[var(--morphy-primary-start)] dark:text-[#c0c0c0] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_4px_12px_var(--activeShadowColor)] border border-[var(--morphy-primary-start)]/20 dark:border-[#c0c0c0]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "blue":
      if (effect === "fill") {
        return "bg-gradient-to-r from-university-blue-600 to-university-blue-500 text-white shadow-md transition-all duration-200 dark:from-university-yellow-400 dark:to-university-yellow-500 dark:text-black";
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/10 to-[var(--morphy-primary-end)]/10 border border-[var(--morphy-primary-start)]/20 text-[var(--morphy-primary-start)] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-university-blue-500/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "blue-gradient":
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.primary} text-white dark:text-black shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/10 to-[var(--morphy-primary-end)]/10 border border-[var(--morphy-primary-start)]/20 text-[var(--morphy-primary-start)] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-[var(--morphy-primary-start)]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "yellow":
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.accent} text-black shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#fbbf24]/10 to-[#f59e0b]/10 border border-[#fbbf24]/20 text-[#fbbf24] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-[#fbbf24]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "yellow-gradient":
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.accent} text-black shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#fbbf24]/10 to-[#f59e0b]/10 border border-[#fbbf24]/20 text-[#fbbf24] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-[#fbbf24]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "purple":
    case "purple-gradient":
    case "green":
    case "green-gradient":
      // Use primary gradient
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.primary} text-white shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#7c3aed]/10 to-[#8b5cf6]/10 border border-[#7c3aed]/20 text-[#7c3aed] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-[var(--morphy-primary-start)]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "orange":
    case "orange-gradient":
      // Use accent/warning gradient
      if (effect === "fill") {
        return `bg-gradient-to-r ${gradientPresets.warning} text-black shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[#f59e0b]/10 to-[#d97706]/10 border border-[#f59e0b]/20 text-[#f59e0b] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-[#fbbf24]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "metallic":
      if (effect === "fill") {
        return `bg-gradient-to-br ${gradientPresets.metallic} text-gray-900 shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return "bg-gradient-to-br from-gray-50/10 via-gray-100/10 to-gray-200/10 border border-gray-200/20 text-gray-700 transition-all duration-200";
      } else {
        return `bg-gradient-to-br ${gradientPresets.metallic} shadow-[0px_4px_12px_rgba(0,0,0,0.1)] border border-gray-200/20 backdrop-blur-[6px] transition-all duration-200`;
      }

    case "mettalic-gradient":
      if (effect === "fill") {
        return `bg-gradient-to-br ${gradientPresets["mettalic-gradient"]} text-gray-900 dark:text-gray-100 shadow-md transition-all duration-200`;
      } else if (effect === "fade") {
        return `bg-gradient-to-br ${gradientPresets["mettalic-gradient"]} opacity-90 border border-gray-300/30 dark:border-gray-700/30 text-gray-800 dark:text-gray-100 transition-all duration-200`;
      } else {
        // glass
        return `bg-gradient-to-br ${gradientPresets["mettalic-gradient"]} shadow-[0px_6px_18px_rgba(0,0,0,0.15)] border border-gray-300/30 dark:border-gray-700/30 backdrop-blur-[4px] transition-all duration-200`;
      }

    case "multi":
      if (effect === "fill") {
        // Silver gradient in dark mode for hushh brand
        return "bg-gradient-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] dark:from-[#c0c0c0] dark:to-[#a0a0a0] text-white dark:text-black shadow-md transition-all duration-200";
      } else if (effect === "fade") {
        return "bg-gradient-to-r from-[var(--morphy-primary-start)]/10 to-[var(--morphy-primary-end)]/10 dark:from-[#c0c0c0]/10 dark:to-[#a0a0a0]/10 border border-[var(--morphy-primary-start)]/20 dark:border-[#c0c0c0]/20 text-[var(--morphy-primary-start)] dark:text-[#c0c0c0] transition-all duration-200";
      } else {
        return "bg-[var(--activeGlassColor)] shadow-[0px_6px_16px_var(--activeShadowColor)] border border-[var(--morphy-primary-start)]/20 dark:border-[#c0c0c0]/20 backdrop-blur-[6px] transition-all duration-200";
      }

    case "link":
      return "text-university-gray-700 dark:text-university-gray-200 underline-offset-4 transition-colors duration-200 bg-transparent border-none shadow-none";

    case "destructive":
      if (effect === "fill") {
        return "bg-destructive text-destructive-foreground border border-transparent shadow-md transition-all duration-200";
      }
      if (effect === "fade") {
        return "bg-destructive/10 text-destructive border border-destructive/30 transition-all duration-200";
      }
      return "bg-transparent text-red-600 border border-red-300/80 shadow-sm backdrop-blur-md dark:bg-transparent dark:text-red-600 dark:border-red-300/80 transition-all duration-200";

    case "none":
    default:
      if (effect === "fill") {
        return "bg-background text-foreground border border-border/60 shadow-none transition-colors duration-200";
      }
      if (effect === "fade") {
        return "bg-muted/55 text-foreground border border-transparent shadow-none backdrop-blur-none transition-colors duration-200";
      }
      return "bg-[var(--activeGlassColor)] shadow-[0px_10px_30px_var(--activeShadowColor)] border border-[var(--fadeGrey)] backdrop-blur-[6px] transition-all duration-200";
  }
};

// ============================================================================
// ICON COLORS - UNIVERSITY FOCUSED
// ============================================================================

export const getIconColor = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill"
): string => {
  switch (variant) {
    case "gradient":
    case "blue":
    case "blue-gradient":
    case "purple":
    case "purple-gradient":
    case "green":
    case "green-gradient":
    case "multi":
      if (effect === "fill") {
        return "text-white";
      } else {
        return "text-university-blue-500";
      }

    case "yellow":
    case "yellow-gradient":
    case "orange":
    case "orange-gradient":
      if (effect === "fill") {
        return "text-black";
      } else {
        return "text-university-yellow-500";
      }

    case "metallic":
      if (effect === "fill") {
        return "text-gray-900";
      } else {
        return "text-gray-700";
      }

    case "link":
      return "text-[#374151] dark:text-[#e5e7eb]";

    case "morphy":
      return "text-background";

    case "destructive":
      return effect === "fill" ? "text-destructive-foreground" : "text-destructive";



    case "none":
    default:
      if (effect === "fill") {
        return "text-foreground";
      } else {
        return "text-foreground";
      }
  }
};

// ============================================================================
// RIPPLE COLORS - UNIVERSITY FOCUSED
// ============================================================================

export const getRippleColor = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill"
): string => {
  // For glass/fade effects - iOS glassmorphism + Material Expressive 3
  // Ripple color matches variant shade (silver in dark mode for hushh brand)
  if (effect === "glass" || effect === "fade") {
    switch (variant) {
      case "gradient":
      case "multi":
      case "blue":
      case "blue-gradient":
        // Silver ripple in dark mode to match variant shades
        return "bg-[var(--morphy-primary-start)]/30 dark:bg-[#c0c0c0]/30";
      case "yellow":
      case "yellow-gradient":
        return "bg-[#fbbf24]/30";
      case "purple":
      case "purple-gradient":
        return "bg-[#7c3aed]/30 dark:bg-[#c0c0c0]/30";
      case "green":
      case "green-gradient":
        return "bg-[#10b981]/30 dark:bg-[#c0c0c0]/30";
      case "orange":
      case "orange-gradient":
        return "bg-[#f59e0b]/30 dark:bg-[#c0c0c0]/30";
      case "metallic":
        return "bg-gray-400/30 dark:bg-[#c0c0c0]/30";
      case "link":
        return "bg-black/10 dark:bg-white/20";
      case "black":
        return "bg-black/20 dark:bg-[#c0c0c0]/20";
      case "morphy":
        return "bg-background/20";
      case "destructive":
        return "bg-red-500/20";

      case "none":
      default:
        return "bg-foreground/10 dark:bg-[#c0c0c0]/10";
    }
  }
  // Default: fill effect - white/black ripple contrasts with solid bg
  // In dark mode, solid bg changes to silver gradient, so white ripple still works
  switch (variant) {
    case "gradient":
    case "blue":
    case "blue-gradient":
    case "purple":
    case "purple-gradient":
    case "green":
    case "green-gradient":
    case "multi":
      // White ripple on solid gradient bg (works in both modes)
      return "bg-white/20";
    case "yellow":
    case "yellow-gradient":
    case "orange":
    case "orange-gradient":
      return "bg-black/10";
    case "metallic":
      return "bg-gray-400/20";
    case "link":
      // Silver ripple in dark mode for link variant
      return "bg-black/10 dark:bg-white/20";
    case "morphy":
      return "bg-background/20";
    case "destructive":
      return "bg-red-500/20";

    case "none":
    default:
      return "bg-foreground/10 dark:bg-[#c0c0c0]/10";
  }
};

// ============================================================================
// RIPPLE RADIAL GRADIENT - Center to Edge Fade
// Returns CSS radial gradient for spotlight ripple effect
// ============================================================================

export const getRippleGradientStyle = (
  variant: ColorVariant,
  effect: ComponentEffect = "fill",
  isDarkMode: boolean = false
): string => {
  // Get base color for gradient
  let color: string;

  if (effect === "glass" || effect === "fade") {
    switch (variant) {
      case "gradient":
      case "multi":
      case "blue":
      case "blue-gradient":
        color = isDarkMode ? "#c0c0c0" : "var(--morphy-primary-start)";
        break;
      case "yellow":
      case "yellow-gradient":
        color = "#fbbf24";
        break;
      case "purple":
      case "purple-gradient":
        color = isDarkMode ? "#c0c0c0" : "#7c3aed";
        break;
      case "green":
      case "green-gradient":
        color = isDarkMode ? "#c0c0c0" : "#10b981";
        break;
      case "orange":
      case "orange-gradient":
        color = isDarkMode ? "#c0c0c0" : "#f59e0b";
        break;
      case "metallic":
        color = isDarkMode ? "#c0c0c0" : "#9ca3af";
        break;
      default:
        color = isDarkMode ? "#c0c0c0" : "currentColor";
    }
  } else {
    // Fill effect - white/black contrast
    switch (variant) {
      case "yellow":
      case "yellow-gradient":
      case "orange":
      case "orange-gradient":
        color = "rgba(0, 0, 0, 0.15)";
        break;
      case "morphy":
        color = "rgba(255, 255, 255, 0.3)";
        break;
      default:
        color = "rgba(255, 255, 255, 0.3)";
    }
  }

  // Radial gradient: full opacity at center, fades to transparent at 40%
  return `radial-gradient(circle, ${color} 0%, ${color}80 20%, transparent 40%)`;
};

// ============================================================================
// HOVER BORDER COLORS - Variant Specific
// Light mode: uses variant color, Dark mode: uses silver (#c0c0c0)
// ============================================================================

export const getHoverBorderColor = (variant: ColorVariant): string => {
  switch (variant) {
    case "gradient":
    case "blue":
    case "blue-gradient":
    case "multi":
      return "hover:border-[var(--morphy-primary-start)] dark:hover:border-[#c0c0c0]";
    case "purple":
    case "purple-gradient":
      return "hover:border-[#7c3aed] dark:hover:border-[#c0c0c0]";
    case "yellow":
    case "yellow-gradient":
      return "hover:border-[#fbbf24] dark:hover:border-[#c0c0c0]";
    case "orange":
    case "orange-gradient":
      return "hover:border-[#f59e0b] dark:hover:border-[#c0c0c0]";
    case "green":
    case "green-gradient":
      return "hover:border-[#10b981] dark:hover:border-[#c0c0c0]";
    case "metallic":
      return "hover:border-gray-400 dark:hover:border-[#c0c0c0]";
    case "black":
      return "hover:border-gray-800 dark:hover:border-[#c0c0c0]";
    case "morphy":
      return "hover:border-foreground/80";
    case "destructive":
      return "hover:border-destructive";
    case "link":
      return "hover:border-[var(--morphy-primary-start)] dark:hover:border-[#c0c0c0]";

    case "none":
    default:
      return "hover:border-[var(--morphy-primary-start)] dark:hover:border-[#c0c0c0]";
  }
};

// ============================================================================
// GRADIENT UTILITIES
// ============================================================================

export const createGradient = (
  direction:
    | "to-r"
    | "to-l"
    | "to-t"
    | "to-b"
    | "to-tr"
    | "to-tl"
    | "to-br"
    | "to-bl" = "to-r",
  colors: string[]
): string => {
  return `bg-gradient-${direction} ${colors.join(" ")}`;
};

export const getVariantGradient = (variant: ColorVariant): string => {
  switch (variant) {
    case "gradient":
      return gradientPresets.primary;
    case "blue":
    case "blue-gradient":
      return gradientPresets.primary;
    case "purple":
    case "purple-gradient":
      return gradientPresets.primary;
    case "green":
    case "green-gradient":
      return gradientPresets.success;
    case "orange":
    case "orange-gradient":
      return gradientPresets.warning;
    case "yellow":
    case "yellow-gradient":
      return gradientPresets.accent;
    case "metallic":
      return gradientPresets.metallic;
    case "multi":
      return gradientPresets.multi;
    case "morphy":
      return gradientPresets.primary;
    default:
      return gradientPresets.primary;
  }
};

export const getRippleGradient = (variant: ColorVariant): string => {
  switch (variant) {
    case "gradient":
      return "from-white/20 to-white/10";
    case "blue":
    case "blue-gradient":
      return "from-blue-400/30 to-blue-400/15";
    case "purple":
    case "purple-gradient":
      return "from-purple-400/30 to-purple-400/15";
    case "green":
    case "green-gradient":
      return "from-green-400/30 to-green-400/15";
    case "orange":
    case "orange-gradient":
      return "from-orange-400/30 to-orange-400/15";
    case "metallic":
      return "from-gray-400/30 to-gray-400/15";
    case "multi":
      return "from-white/20 to-white/10";
    case "morphy":
      return "from-background/20 to-background/5";
    case "destructive":
      return "from-red-500/20 to-red-500/10";

    default:
      return "from-foreground/10 to-foreground/5";
  }
};

// ============================================================================
// GLASS EFFECT
// ============================================================================

export const glassEffect = {
  background: "bg-[var(--activeGlassColor)]",
  shadow: "shadow-[0px_10px_30px_var(--activeShadowColor)]",
  border: "border border-[var(--fadeGrey)]",
  blur: "backdrop-blur-[6px]",
  hover: "hover:shadow-[0px_15px_40px_var(--activeShadowColor)]",
  transition: "transition-all duration-200",
} as const;

// ============================================================================
// SMOOTH OPACITY TRANSITIONS (MORPHY STANDARD)
// All interactive elements should use smooth opacity transitions from 0-1
// This prevents layout jumps and provides professional animations
// ============================================================================

export const opacityTransitions = {
  // Standard opacity transition for error messages, tooltips, etc.
  smooth: "transition-opacity duration-300 ease-in-out",

  // Faster transition for hover states
  fast: "transition-opacity duration-200 ease-in-out",

  // Slower transition for major state changes
  slow: "transition-opacity duration-500 ease-in-out",

  // Instant transition for immediate feedback
  instant: "transition-opacity duration-100 ease-in-out",
} as const;

// ============================================================================
// OPACITY UTILITY CLASSES
// Pre-built classes for common opacity states
// ============================================================================

export const opacityStates = {
  // Invisible but takes space (for smooth transitions)
  invisible: "opacity-0 pointer-events-none",
  visible: "opacity-100",

  // Semi-transparent states
  subtle: "opacity-60",
  muted: "opacity-40",
  faint: "opacity-20",
} as const;

// ============================================================================
// MORPHY TRANSITION HELPER
// Combine opacity transitions with morphy colors for consistent theming
// ============================================================================

export const createOpacityTransition = (
  visible: boolean,
  transitionType: keyof typeof opacityTransitions = "smooth"
) => {
  const baseClasses = opacityTransitions[transitionType];
  const opacityClass = visible
    ? opacityStates.visible
    : opacityStates.invisible;
  return `${baseClasses} ${opacityClass}`;
};
