// Inert boundaries for the Connect page fixture. The page itself
// (app/connect/page-client.tsx), its hero, its lists and every layout class
// render from production source. Only identity, routing, storage and the
// network are replaced, and the network answers on a timer the spec controls
// through <html data-*> attributes, so the page loads in the same order it
// does for a person: shell first, then connections, then circles.
import React, { createContext, useEffect, useSyncExternalStore } from "react";
import { ConnectCirclesTab as ProductionCirclesTab } from "../../components/connect/circles/connect-circles-tab";

const noop = () => {};
const dataset = () => document.documentElement.dataset;
const delay = (key: string, fallback: number) => {
  const value = Number(dataset()[key]);
  return Number.isFinite(value) ? value : fallback;
};
const after = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));

// ---- routing ----------------------------------------------------------------
function subscribeToRoute(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
function navigate(href: string) {
  document.body.dataset.lastNavigation = href;
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
const router = { replace: noop, push: navigate, prefetch: noop, back: noop, refresh: noop };
export const useRouter = () => router;
export const usePathname = () => "/one/connect";
export function useSearchParams() {
  // The production tab owner reads ?tab=. A signal-only router cannot test
  // its real Connections/Circles selection or inactive-pane accessibility.
  const search = useSyncExternalStore(subscribeToRoute, () => window.location.search, () => "");
  return new URLSearchParams(search);
}

// ---- identity ---------------------------------------------------------------
const user = {
  uid: "fixture-owner",
  displayName: "Taylor Kim",
  email: "taylor@example.com",
  photoURL: null,
  getIdToken: async () => "fixture-token",
};
const signedIn = {
  user,
  isAuthenticated: true,
  loading: false,
  phoneNumber: null,
  resolveVerifiedPhoneNumber: async () => null,
};
export const useAuth = () => signedIn;
export const useRequireAuth = () => signedIn;
const vault = { vaultOwnerToken: "fixture-vault", isVaultUnlocked: true, vaultKey: null };
export const VaultContext = createContext<typeof vault | null>(vault);
export const useVault = () => vault;

// ---- information -------------------------------------------------------------
const NAMES = [
  "Alex Chen",
  "Jordan Lee",
  "Casey Brooks",
  "Morgan Diaz",
  "Riley Park",
  "Sam Patel",
];
const connections = () =>
  NAMES.slice(0, Number(dataset().connections ?? NAMES.length)).map(
    (displayName, index) => ({
      connectionId: `connection-${index}`,
      userId: `user-${index}`,
      publicPersonRef: `person_${index}`,
      displayName,
      photoUrl: null,
      createdAt: "2026-09-28T12:00:00Z",
      connectedFromContacts: index === 1,
    }),
  );
const people = ["Avery Stone", "Blake Rivera", "Drew Morgan"].map(
  (displayName, index) => ({
    userId: `directory-${index}`,
    displayName,
    photoUrl: null,
    email: null,
    maskedPhone: `••• ••• ${4400 + index}`,
    maskedEmail: `p***${index}@example.com`,
    mutualConnectionCount: index === 0 ? 2 : 0,
    mutualConnectionPreview: index === 0 ? { displayName: "Alex Chen", photoUrl: null, publicPersonRef: "person_alex" } : null,
    relationship: "none",
  }),
);

export const ConnectionsService = {
  listConnectionsPage: () => {
    const items = connections();
    return after(delay("connectionsMs", 600), {
      items,
      page: 1,
      hasMore: false,
      totalCount: items.length,
      audience: "all",
    });
  },
  listRequests: async () => [],
  searchDirectory: () =>
    after(delay("directoryMs", 400), {
      items: people,
      page: 1,
      hasMore: false,
      totalCount: people.length,
    }),
  getScopeCatalog: async () => ({ scopes: [] }),
  getPersonContext: async () => null,
  sendRequest: async () => ({}),
  cancel: async () => ({}),
  removeConnection: async () => ({}),
};

export const CACHE_KEYS = new Proxy(
  {},
  { get: (_target, key) => (...args: unknown[]) => `${String(key)}:${args.join(":")}` },
);
export const CACHE_TTL = { SHORT: 1, MEDIUM: 1, LONG: 1 };
const cache = {
  get: () => null,
  peek: () => null,
  set: noop,
  invalidate: noop,
  invalidatePattern: noop,
  subscribe: () => noop,
};
export const CacheService = { getInstance: () => cache };
export const CacheSyncService = new Proxy({}, { get: () => noop });

/** The Circles tab owns the circles read; its answer arrives on its own clock. */
export function ConnectCirclesTab({
  onStateChange,
  createDialogOpen,
  onCreateDialogOpenChange,
}: {
  onStateChange?: (state: unknown) => void;
  createDialogOpen?: boolean;
  onCreateDialogOpenChange?: (open: boolean) => void;
}) {
  useEffect(() => {
    onStateChange?.({
      ownerId: "fixture-owner",
      loading: true,
      error: null,
      count: 0,
      available: true,
      circles: [],
    });
    const timer = window.setTimeout(
      () =>
        onStateChange?.({
          ownerId: "fixture-owner",
          loading: false,
          error: null,
          count: 1,
          available: true,
          circles: [
            {
              id: "trusted",
              name: "Trusted",
              kind: "other",
              systemKind: "trusted",
              role: "owner",
              memberCount: 4,
              memberLimit: null,
            },
          ],
        }),
      delay("circlesMs", 900),
    );
    return () => window.clearTimeout(timer);
  }, [onStateChange]);
  return createDialogOpen ? <ProductionCirclesTab createDialogOpen onCreateDialogOpenChange={onCreateDialogOpenChange} /> : <div data-fixture-circles-tab="">Circles</div>;
}
export const NearbyDirectories = () => null;
export const OneLocationService = {
  ensureTrustedSystemCircle: async () => ({}),
  listCircles: async () => [],
  listCircleMembersPage: async () => ({ items: [] }),
};

// ---- device and side channels ------------------------------------------------
export const useContactSync = () => ({
  available: true,
  syncing: false,
  sync: async () => {},
  result: null,
  setResultsOpen: noop,
  resultsSheetProps: null,
  discoverabilityConsentDialogProps: null,
});
export const ContactSyncResultsSheet = () => null;
export const ContactDiscoverabilityConsentDialog = () => null;
export const usePublishVoiceSurfaceMetadata = noop;
export const useLocalOnboardingActionHandler = noop;
export const hasMountedLocalOnboardingHandler = () => false;
export const useOutgoingRequestResolutionWatch = noop;
export const subscribeToConnectionGraphChanges = () => noop;
export const trackEvent = noop;
export const useOptionalOneLocationInteractionSurface = () => null;

// Firebase initialises at import time against a project this fixture has no
// key for. Nothing here signs in; the page reads identity from useRequireAuth.
export const app = null;
export const auth = null;
export const getRecaptchaVerifier = noop;
export const prepareRecaptchaVerifier = async () => null;
export const resetRecaptcha = noop;
