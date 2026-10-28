// Inert boundaries for the Connect page fixture. The page itself
// (app/connect/page-client.tsx), its hero, its lists and every layout class
// render from production source. Only identity, routing, storage and the
// network are replaced, and the network answers on a timer the spec controls
// through <html data-*> attributes, so the page loads in the same order it
// does for a person: shell first, then connections, then circles.
import React, { createContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";
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
let currentQuery = dataset().initialQuery ?? "";
const routeListeners = new Set<() => void>();
const navigate = (href: string) => {
  document.body.dataset.lastNavigation = href;
  const destination = new URL(href, "http://localhost");
  if (destination.pathname !== "/connect" && destination.pathname !== "/one/connect") return;
  currentQuery = destination.search;
  routeListeners.forEach((listener) => listener());
};
const router = { replace: navigate, push: navigate, prefetch: noop, back: noop, refresh: noop };
export const useRouter = () => router;
export const usePathname = () => "/one/connect";
const subscribeRoute = (listener: () => void) => {
  routeListeners.add(listener);
  return () => { routeListeners.delete(listener); };
};
export const useSearchParams = () => {
  const query = useSyncExternalStore(subscribeRoute, () => currentQuery);
  return useMemo(() => new URLSearchParams(query), [query]);
};

// ---- identity ---------------------------------------------------------------
const user = {
  uid: "fixture-owner",
  displayName: "Taylor Kim",
  email: "taylor@example.com",
  photoURL: null,
  getIdToken: async () => "fixture-token",
};
publishValidatedAuthSessionOwner(user.uid);
export const AuthService = {
  getIdTokenWithRetry: async (options?: { expectedUserId?: string }) =>
    options?.expectedUserId === user.uid ? "fixture-token" : null,
};
const signedIn = {
  user,
  userId: user.uid,
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
  Array.from(
    { length: Number(dataset().connections ?? NAMES.length) },
    (_, index) => NAMES[index] ?? `Connection ${index + 1}`,
  ).map(
    (displayName, index) => ({
      connectionId: `connection-${index}`,
      userId: `user-${index}`,
      publicPersonRef: `person_${index}`,
      displayName: dataset().longConnectionName === "1" && index === 2 ? "24E2100221 Mayank Featherstonehaugh-Rajendran" : displayName,
      photoUrl: null,
      createdAt: "2026-09-28T12:00:00Z",
      connectedFromContacts: index === 1,
    }),
  );
const people = () => ["Avery Stone", "Blake Rivera", "Drew Morgan"].map(
  (displayName, index) => ({
    userId: `directory-${index}`,
    displayName: dataset().longDirectoryIdentity === "1" && index === 0
      ? "Avery Featherstonehaugh-Rajendran"
      : displayName,
    photoUrl: null,
    email: null,
    maskedPhone: `98******${10 + index}`,
    maskedEmail: dataset().longDirectoryIdentity === "1" && index === 0
      ? "a***@international-research-department.example.com"
      : `p***${index}@example.com`,
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
  searchDirectory: ({ query }: { query?: string }) => {
    const items = query && dataset().emptyDirectoryOnQuery === "1" ? [] : people();
    return after(delay("directoryMs", 400), {
      items,
      page: 1,
      hasMore: false,
      totalCount: items.length,
    });
  },
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
  if (document.documentElement.dataset.realCircles === "1") {
    return <ProductionCirclesTab createDialogOpen={dataset().createModal === "1" || createDialogOpen} onCreateDialogOpenChange={onCreateDialogOpenChange} />;
  }
  return createDialogOpen ? <ProductionCirclesTab createDialogOpen onCreateDialogOpenChange={onCreateDialogOpenChange} /> : <div data-fixture-circles-tab="">Circles</div>;
}
export const NearbyDirectories = () => null;
let fixtureTypeDeleted = false;
function fixtureCircles() {
  if (document.documentElement.dataset.customCircles !== "1") return [];
  return [
    { id: "fixture-family", name: "Weekend family", kind: "family", role: "owner", memberCount: 3, memberLimit: 20 },
    { id: "fixture-friends", name: "Old classmates", kind: "friends", role: "owner", memberCount: 4, memberLimit: 20 },
    { id: "fixture-investments", name: "Investments", kind: "other", role: "owner", memberCount: 1, memberLimit: 20,
      ...(fixtureTypeDeleted ? {} : { customTypeLabel: "Finance" }),
      viewerCapabilities: { canDeleteCircle: true, canLeaveCircle: false, canManageCircle: true } },
    { id: "fixture-other", name: "Project team", kind: "other", role: "owner", memberCount: 2, memberLimit: 20 },
    { id: "fixture-joined", name: "Shared budget", kind: "other", role: "member", memberCount: 4, memberLimit: 20 },
  ];
}
export const OneLocationService = {
  ensureTrustedSystemCircle: async () => ({}),
  listCircles: async () => fixtureCircles(),
  listCircleWorkspace: async () => ({ circles: fixtureCircles(), customTypePolicy: { version: 1, maxTypes: 3 } }),
  deleteCircleType: async () => { fixtureTypeDeleted = true; return { updatedCircleCount: 1 }; },
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
export const useVoiceSurfaceMetadata = () => null;
export const getVoiceSurfaceMetadata = () => null;
export const useLocalOnboardingActionHandler = noop;
export const hasMountedLocalOnboardingHandler = () => false;
export const useOutgoingRequestResolutionWatch = noop;
export const subscribeToConnectionGraphChanges = () => noop;
export const trackEvent = noop;
export const useOptionalOneLocationInteractionSurface = () => null;

// Firebase initialises at import time against a project this fixture has no
// key for. Nothing here signs in; the page reads identity from useRequireAuth.
export const app = null;
export const auth = { currentUser: user };
export const DirectMessagesService = {
  routeHref: async (input: { personRef: string }) => {
    document.body.dataset.messageRecipient = input.personRef;
    return "/one/messages?token=dm1.fixture";
  },
};
export const getRecaptchaVerifier = noop;
export const prepareRecaptchaVerifier = async () => null;
export const resetRecaptcha = noop;
