import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import type { CapacitorConfig } from "@capacitor/cli";
import type { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "").trim();
const WEB_DIR = process.env.NEXT_DIST_DIR?.trim() || "out";

function hostFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.trim().toLowerCase();
  } catch {
    return null;
  }
}

const NORMALIZED_BACKEND_URL = (() => {
  if (!BACKEND_URL) {
    throw new Error(
      "NEXT_PUBLIC_BACKEND_URL is required in .env.local for Capacitor builds."
    );
  }
  const normalized = BACKEND_URL.replace(/\/$/, "").trim();
  const backendHost = hostFromUrl(normalized);

  if (process.env.CAPACITOR_PLATFORM !== "android") return normalized;
  if (process.env.NEXT_PUBLIC_ANDROID_LOCAL_BACKEND_MODE === "adb_reverse") {
    return normalized;
  }
  // Android emulator cannot reach host loopback; use 10.0.2.2
  if (backendHost === "localhost") {
    return normalized.replace("localhost", "10.0.2.2");
  }
  if (backendHost === "127.0.0.1") {
    return normalized.replace("127.0.0.1", "10.0.2.2");
  }
  return normalized;
})();

const config: CapacitorConfig = {
  appId: "com.hushh.app",
  appName: "Hussh One",
  // Next writes static exports into `distDir` when it is overridden. Native
  // release builds use that override to avoid colliding with a live web dev
  // server, so Capacitor must consume the same directory.
  webDir: WEB_DIR,

  // iOS-specific configuration
  ios: {
    // Capacitor's notification router must remain the sole UNUserNotificationCenter
    // delegate so Firebase Messaging can emit receipt and action events to JS.
    handleApplicationNotifications: true,
    // SystemBars immersive mode: let app/CSS safe-area handling own spacing.
    contentInset: "never",
    allowsLinkPreview: true,
    // Disable the native UIScrollView. The app is a fixed-overlay SPA: every
    // scrollable surface uses an inner `overflow-y-auto` container, and
    // html/body never scroll. Leaving native scroll on lets iOS auto-scroll the
    // whole WKWebView up to reveal a focused input near the bottom — which drags
    // the fixed chat overlay (header rises under the status bar, composer slides
    // under the keyboard). Turning it off removes that drift at its root.
    scrollEnabled: false,
    backgroundColor: "#0a0a0a",
    scheme: "App",
  },

  // Server configuration
  server: {
    // Native runtime must use bundled web assets from webDir.
    // Do not pin to hosted frontend URL; native data access should flow via plugins/backendUrl.
    cleartext: true, // Allow HTTP for localhost
    androidScheme: "https",
    iosScheme: "App",
  },

  plugins: {
    // Keyboard handling — resize:"none" is intentional and load-bearing.
    // "native" shrinks the whole WKWebView frame on every keyboard-animation
    // frame, which recomputes every dvh/svh unit ~60x/sec → severe layout
    // thrashing and vault jank (the reason it was reverted twice). Instead the
    // frame stays fixed and keyboard AVOIDANCE is done in JS, event-driven:
    // KeyboardInsetManager (components/keyboard-inset-manager.tsx) publishes the
    // keyboard height as `--kb-height` once per show/hide, and fixed/bottom
    // surfaces lift by it. This is jank-free AND covers every input surface.
    // See mobile-bug-log B21. Do NOT flip this to "native" or "body".
    Keyboard: {
      resize: "none" as KeyboardResize,
      style: "LIGHT" as KeyboardStyle,
      resizeOnFullScreen: false,
    },
    FirebaseAuthentication: {
      // Use native Google Sign-In SDK on iOS/Android
      skipNativeAuth: false,
      providers: ["google.com", "phone"],
    },
    FirebaseMessaging: {
      // Foreground notification content belongs in Feed or the shared emergency
      // UI. Keep only the badge so iOS does not duplicate banners or sounds.
      presentationOptions: ["badge"],
    },
    HushhVault: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    HushhConsent: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    Kai: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    HushhNotifications: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    PersonalKnowledgeModel: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    HushhAccount: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    HushhSync: {
      backendUrl: NORMALIZED_BACKEND_URL,
    },
    CapacitorHttp: {
      enabled: true,
    },
    SystemBars: {
      // Full immersive edge-to-edge bars with CSS inset fallback.
      // iOS overlay behavior is controlled via ios.contentInset = "never".
      insetsHandling: "css",
      style: "DEFAULT",
      hidden: false,
      animation: "NONE",
    },
  },
};

export default config;
