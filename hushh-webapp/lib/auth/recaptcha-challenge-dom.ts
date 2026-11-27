/**
 * Detect whether Google's invisible reCAPTCHA has stepped up to a visible
 * interactive challenge iframe (`bframe`) mounted under `document.body`.
 *
 * When silent token issuance succeeds or stalls on the network, no challenge
 * frame is visible and the 25s start timeout applies. When Google presents an
 * image challenge, `verifyPhoneNumber` waits for the person to finish it (Google
 * gives a 2-minute challenge window), so clearing the widget at 25s destroys
 * the active challenge mid-interaction.
 */
export const WEB_VERIFY_INITIAL_TIMEOUT_MS = 25_000;
export const WEB_VERIFY_INTERACTIVE_EXTENSION_MS = 95_000;

export function isInteractiveRecaptchaChallengeOpen(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }

  const frames = document.querySelectorAll<HTMLIFrameElement>(
    'iframe[src*="google.com/recaptcha/api2/bframe"], iframe[src*="recaptcha.net/recaptcha/api2/bframe"], iframe[title*="recaptcha challenge" i]',
  );

  for (const frame of frames) {
    let node: HTMLElement | null = frame;
    let hidden = false;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") === 0
      ) {
        hidden = true;
        break;
      }
      node = node.parentElement;
    }
    if (hidden) continue;

    const rect = frame.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return true;
    }
  }

  return false;
}
