import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import type { CapacitorConfig } from "@capacitor/cli";
import type { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "").trim();

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
  webDir: "out",

  // iOS-specific configuration
  ios: {
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
    // Keyboard handling: `resize: "none"` keeps the WKWebView frame at full
    // height (100dvh stays full-screen) so our own layout owns keyboard
    // avoidance. The chat popover reads the authoritative native keyboard height
    // from `keyboardWillShow` (see agent-popover-provider) and shrinks its sheet
    // so the composer stays above the keyboard. `resize: "native"` would
    // double-shrink and make every fixed-bottom element jump over the keyboard.
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
      presentationOptions: ["alert", "badge", "sound"],
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
