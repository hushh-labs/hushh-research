/**
 * Core Accessibility (A11y) Helpers for HushhTech
 * Ensures all interactive and loading states comply with WCAG ARIA standards.
 */

export interface AriaLoaderProps {
  role: "status" | "alert";
  "aria-live": "polite" | "assertive";
  "aria-busy": boolean;
  "aria-label": string;
}

/**
 * Generates standardized ARIA attributes for loading states.
 * Prevents screen readers from repeatedly announcing rapid UI changes,
 * while ensuring the user knows data is being fetched.
 */
export function getSemanticLoaderProps(
  loadingText: string = "Loading content...",
  isCritical: boolean = false
): AriaLoaderProps {
  return {
    role: isCritical ? "alert" : "status",
    "aria-live": isCritical ? "assertive" : "polite",
    "aria-busy": true,
    "aria-label": loadingText,
  };
}