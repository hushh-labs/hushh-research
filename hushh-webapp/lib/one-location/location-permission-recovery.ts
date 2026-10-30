/**
 * What to tell someone whose device is refusing location, when asking again is
 * not an option.
 *
 * There are two refusals and they need opposite responses. Everything before
 * this module conflated them.
 *
 * **Not yet asked.** The browser will show its own dialog — but only from
 * `getCurrentPosition()`, and only from a real user gesture. Nothing here is
 * needed: tap the control, the dialog appears. `ensureForegroundLocationReady`
 * already does exactly that, which is why the first-time flow works.
 *
 * **Already blocked.** No website can reopen that dialog. Chrome, Safari and
 * Firefox all treat a block as final until the person changes it in browser UI
 * the page cannot reach, script, or even point at. This is a security rule, not
 * a gap in our code, and no amount of retrying changes it.
 *
 * The app's response to the second case used to be a toast reading "Allow
 * location permission before sharing", followed by `openLocationSettings()` —
 * which on web is a hard-coded `{ opened: false }`. So the one instruction we
 * gave was the one thing the person could not act on, and the button that
 * looked like help did nothing. Someone who does not already know that browsers
 * keep a per-site location switch behind an icon in the address bar had no way
 * to find it. That is the whole failure: not that we could not ask again, but
 * that we never said where the switch was.
 *
 * So this module produces the exact words for the exact browser: what to click,
 * what it looks like, and what to do after. It says "Chrome is blocking this",
 * because naming who is blocking is the difference between a person fixing it
 * in ten seconds and concluding the app is broken.
 *
 * Detection is deliberately coarse. A wrong-but-close instruction ("look for
 * the icon at the left of the address bar") still lands, because every desktop
 * browser puts it there. A missing instruction never does.
 */

export type LocationRecoveryTarget =
  /** Chrome, Edge, Brave, Arc, Opera — anything Chromium, on a computer. */
  | "chromium-desktop"
  /** Chrome on Android: permission lives in the browser AND in Android. */
  | "chromium-android"
  | "safari-desktop"
  | "safari-ios"
  | "firefox"
  /** Our own iOS app. Here a Settings button genuinely works. */
  | "ios-app"
  /** Our own Android app. Same. */
  | "android-app"
  /** Unrecognised browser: keep the advice true for all of them. */
  | "browser";

export type LocationRecoveryGuide = {
  target: LocationRecoveryTarget;
  /** Names who is refusing. Never blames the person. */
  title: string;
  /** Two to four steps, in order, each a single action. */
  steps: string[];
  /**
   * True only where an in-app button can genuinely open the OS settings pane.
   * On the web it is always false — offering a dead button is worse than
   * offering none, because it spends the person's trust on a no-op.
   */
  canOpenSettings: boolean;
};

type DetectParams = {
  userAgent?: string | null;
  /** Running inside our Capacitor shell rather than a browser tab. */
  isNativeApp?: boolean;
  /** `ios` | `android` when known. */
  nativePlatform?: string | null;
};

/**
 * Which set of instructions applies.
 *
 * Order matters: the native shell is checked first because its WebView reports
 * a Safari/Chrome user agent, so user-agent sniffing alone would send an app
 * user to browser settings that do not exist for them.
 */
export function detectLocationRecoveryTarget(
  params: DetectParams = {},
): LocationRecoveryTarget {
  const ua = String(params.userAgent ?? "").toLowerCase();

  if (params.isNativeApp) {
    const platform = String(params.nativePlatform ?? "").toLowerCase();
    if (platform === "android") return "android-app";
    if (platform === "ios") return "ios-app";
    return /android/.test(ua) ? "android-app" : "ios-app";
  }

  if (!ua) return "browser";

  // Every iPhone/iPad browser is Safari's engine and shares Safari's settings,
  // so CriOS/FxiOS deliberately land here too.
  if (/iphone|ipad|ipod/.test(ua)) return "safari-ios";

  if (/firefox|fxios/.test(ua)) return "firefox";

  // Edge and Opera announce Chrome as well; treat the whole family alike
  // because they share the address-bar control this advice points at.
  const chromium = /chrome|chromium|crios|edg\//.test(ua);
  if (chromium) return /android/.test(ua) ? "chromium-android" : "chromium-desktop";

  if (/safari/.test(ua)) return "safari-desktop";

  return "browser";
}

const GUIDES: Record<LocationRecoveryTarget, Omit<LocationRecoveryGuide, "target">> = {
  "chromium-desktop": {
    title: "Chrome is blocking location for this site",
    steps: [
      "Click the icon just left of the web address, at the top of this window.",
      "Turn Location on.",
      "Come back here — it turns on by itself.",
    ],
    canOpenSettings: false,
  },
  "chromium-android": {
    title: "Chrome is blocking location for this site",
    steps: [
      "Tap the lock or icon left of the web address.",
      "Tap Permissions, then turn Location on.",
      "Come back here — it turns on by itself.",
    ],
    canOpenSettings: false,
  },
  "safari-desktop": {
    title: "Safari is blocking location for this site",
    steps: [
      "Open Safari, then Settings, then Websites, then Location.",
      "Set this site to Allow.",
      "Come back here — it turns on by itself.",
    ],
    canOpenSettings: false,
  },
  "safari-ios": {
    title: "Safari is blocking location for this site",
    steps: [
      "Tap the aA icon in the address bar, then Website Settings.",
      "Set Location to Allow.",
      "If it is still off, open Settings, then Privacy & Security, then Location Services, and turn on Safari Websites.",
    ],
    canOpenSettings: false,
  },
  firefox: {
    title: "Firefox is blocking location for this site",
    steps: [
      "Click the lock icon left of the web address.",
      "Next to Blocked, for Access your location, click the X to clear it.",
      "Reload this page and turn location on again.",
    ],
    canOpenSettings: false,
  },
  "ios-app": {
    title: "iPhone Settings is blocking location for Hussh",
    steps: [
      "Open Settings.",
      "Set Location to While Using the App.",
      "Come back here — it turns on by itself.",
    ],
    canOpenSettings: true,
  },
  "android-app": {
    title: "Android Settings is blocking location for Hussh",
    steps: [
      "Open Settings.",
      "Tap Permissions, then Location, then Allow only while using the app.",
      "Come back here — it turns on by itself.",
    ],
    canOpenSettings: true,
  },
  browser: {
    title: "Your browser is blocking location for this site",
    steps: [
      "Open this site's settings from the icon left of the web address.",
      "Allow location.",
      "Come back here — it turns on by itself.",
    ],
    canOpenSettings: false,
  },
};

/** The exact words for one situation. */
export function locationRecoveryGuide(
  target: LocationRecoveryTarget,
): LocationRecoveryGuide {
  return { target, ...GUIDES[target] };
}

/** Convenience: detect and resolve in one call. */
export function resolveLocationRecoveryGuide(
  params: DetectParams = {},
): LocationRecoveryGuide {
  return locationRecoveryGuide(detectLocationRecoveryTarget(params));
}

/**
 * Should the recovery guide be shown at all?
 *
 * Only for an *observed* denial — a capture that actually failed with
 * PERMISSION_DENIED — never for a permission API that merely reports "denied".
 * Safari cannot report the value at all, Android re-prompts unless the person
 * chose "don't ask again", and a stale read is common. Showing "your browser is
 * blocking this" to someone who would have got a dialog teaches them to
 * distrust the message, and sends them into settings for no reason.
 *
 * The rule this encodes, and the reason it is a separate function rather than
 * an inline `if`: **a query is a hint, an attempt is the truth.** It is the
 * same rule `location-readiness.ts` enforces on the way in; this is that rule
 * on the way out.
 */
export function shouldShowLocationRecovery(params: {
  observedDenial: boolean;
  hasFix: boolean;
}): boolean {
  if (params.hasFix) return false;
  return params.observedDenial;
}
