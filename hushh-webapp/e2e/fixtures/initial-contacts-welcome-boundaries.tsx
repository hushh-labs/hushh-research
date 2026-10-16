import React from "react";
const owner = { uid: "owner", displayName: "Aarav One", getIdToken: async () => "synthetic-token" };
const emptyWelcome = () => Boolean((window as Window & { __circleEmpty?: boolean }).__circleEmpty);
const snapshot = { ownerId: "owner", attemptId: "welcome-fixture", source: "google", status: "ready", result: { autoConnectedCount: 99, alreadyConnectedCount: 0 }, candidates: [], people: [{ userId: "anjali", displayName: "Anjali Meena", photoUrl: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#c8dce9"/><circle cx="24" cy="19" r="9" fill="#986344"/><ellipse cx="24" cy="45" rx="17" ry="15" fill="#42698a"/></svg>') }, { userId: "kabir", displayName: "Kabir Shah", photoUrl: null, isRia: true }, { userId: "zoya", displayName: "Zoya Khan", photoUrl: null }], circle: { circleId: "circle", circleName: "Contacts", code: "ABCD2345" }, membersAdded: 99, overflow: 4, error: "Some contacts could not be checked. You can still continue." };
export const InitialContactsOnboardingService = { snapshotForOwner: (uid: string) => uid === "owner" ? emptyWelcome()
  ? { ...snapshot, status: "deferred", result: null, people: [], overflow: 0, error: null }
  : snapshot : { ...snapshot, ownerId: null, circle: null }, isOwnerCurrent: () => true, prepareCircle: async () => {}, acknowledge: async () => { document.body.dataset.ack = "yes"; }, startSource: () => {} };
export const useInitialContacts = () => snapshot;
export const useAuth = () => ({ user: emptyWelcome() ? { ...owner, displayName: "hushh" } : owner });
export const useVault = () => ({ vaultOwnerToken: "synthetic-vault" });
export const VaultLockGuard = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const useRouter = () => ({ replace: (route: string) => { document.body.dataset.destination = route; } });
export const useSearchParams = () => new URLSearchParams("return_to=/finance");
export const usePathname = () => "/one/welcome";
export const NativeTestBeacon = () => null;
export const useNativeNavigationOverlayRef = () => () => {};
export const useBackLayer = (_route: string, depth: number, callback: () => boolean) => { React.useEffect(() => { const handler = (event: Event) => { if ((event as CustomEvent).detail === depth) callback(); }; window.addEventListener("fixture:back", handler); return () => window.removeEventListener("fixture:back", handler); }, [depth, callback]); };
export const isValidatedAuthSessionOwnerCurrent = () => true;
export const snapshotValidatedAuthSessionOwner = () => ({ userId: "owner", generation: 1 });
export const useOneConversationSession = (select: (state: any) => unknown) => select({ queueEntryWelcome: () => { document.body.dataset.queued = "yes"; } });
const circle = { id: "circle", name: "Contacts", memberCount: 100, memberLimit: 100, viewerCapabilities: { canManageCircle: true, canInviteMembers: true } };
const actions = { loadCircleOverview: async () => emptyWelcome() ? { ...circle, memberCount: 1 } : circle, loadCircleMembersPage: async () => emptyWelcome()
  ? { items: [{ userId: "owner", displayName: "hushh" }], hasMore: false }
  : { items: Array.from({ length: 50 }, (_, i) => ({ userId: i === 0 ? "owner" : `friend-${i}`, displayName: `Very long friendly contact name ${i}` })), hasMore: true }, removeMember: async (_circle: string, member: string) => { document.body.dataset.removed = member; }, copyCode: async () => {}, shareCode: async () => {}, inviteConnections: async () => {}, cancelMemberInvite: async () => {} };
export const createConnectCircleActions = () => actions;
export const OneLocationService = {
  listCircles: async () => [],
  listCircleMembersPage: async () => ({ items: [], hasMore: false }),
  ensureTrustedSystemCircle: async () => ({ id: "trusted", name: "Trusted" }),
};
export const ReferralService = { getSummary: async () => ({ link: "https://one.example.test/invite/aarav" }) };
export const buildInviteToOneShare = () => ({ url: "https://one.example.test" });
export const shareLink = async () => {};
const invitations = { enabled: true, candidates: [], active: false, beginSync: () => () => {}, clear: () => {}, draft: { busy: false, step: "select", setStep: () => {} } };
export const useContactInvitationSession = () => invitations;
export const ContactInvitationSheet = () => null;
export const CircleInvitePeopleSheet = ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => <button onClick={() => onOpenChange(false)}>Close people picker</button>;
