"use client";

import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";
import { HushhAuth, HushhContacts, type HushhContactsReadResult } from "@/lib/capacitor";
import { initialContactSource, type InitialContactSource } from "@/lib/contacts/initial-contact-onboarding-config";
import { googlePeopleContactSource } from "@/lib/contacts/google-people-source";
import { requestGoogleContactsToken } from "@/lib/contacts/google-contacts-token";
import type { InviteCandidate } from "@/lib/contacts/invitation-candidates";
import { syncOneLocationContactSignals, type OneLocationContactSignalResult } from "@/lib/one-location/contact-signals";
import { OneLocationService } from "@/lib/one-location/service";
import { AccountIdentityService } from "./account-identity-service";
import { AuthService, type AuthResult } from "./auth-service";
import { PreVaultUserStateService, type PreVaultUserState } from "./pre-vault-user-state-service";
import { RiaService, CONTACT_SYNC_MATCH_POLICY_VERSION } from "./ria-service";
import { ConnectionsService, type ConnectionSummaryEntry } from "./connections-service";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent, type AuthSessionOwnerSnapshot } from "@/lib/auth/session-owner";

export type InitialContactsSnapshot = {
  ownerId: string | null;
  attemptId: string | null;
  source: InitialContactSource;
  status: "idle" | "deferred" | "reading" | "waiting_for_phone" | "matching" | "ready" | "error";
  result: OneLocationContactSignalResult | null;
  candidates: InviteCandidate[];
  people: ConnectionSummaryEntry[];
  circle: { circleId: string; circleName: string; code: string } | null;
  membersAdded: number;
  overflow: number;
  error: string | null;
  circleError: string | null;
};
const EMPTY: InitialContactsSnapshot = {
  ownerId: null, attemptId: null, source: "none", status: "idle", result: null,
  candidates: [], people: [], circle: null, membersAdded: 0, overflow: 0, error: null, circleError: null,
};
type Session = {
  user: User;
  attemptId: string;
  controller: AbortController;
  read: Promise<HushhContactsReadResult> | null;
  matching: Promise<void> | null;
  filling: Promise<void> | null;
  filled: boolean;
  attemptedMembers: Set<string>;
  owner: AuthSessionOwnerSnapshot;
};

/** Initial signup only. Provider tokens/address books never enter durable state. */
export class InitialContactsOnboardingService {
  private static session: Session | null = null;
  private static snapshot: InitialContactsSnapshot = EMPTY;
  private static listeners = new Set<() => void>();
  private static dismissedOwners = new Set<string>();
  private static beginSequence = 0;
  static wasDismissed = (ownerId: string) => this.dismissedOwners.has(ownerId);
  static reset() { this.beginSequence += 1; this.dismissedOwners.clear(); this.clear(); }
  static subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  static getSnapshot = () => this.snapshot;
  static getServerSnapshot = () => EMPTY;
  static snapshotForOwner = (ownerId: string) => this.snapshot.ownerId === ownerId && this.isOwnerCurrent(ownerId) ? this.snapshot : EMPTY;
  static isOwnerCurrent = (ownerId: string) => this.session?.user.uid === ownerId && this.active(this.session);
  static invalidateStale() { if (this.session && !this.active(this.session)) this.reset(); }

  private static active(session: Session): boolean {
    return this.session === session && !session.controller.signal.aborted
      && isValidatedAuthSessionOwnerCurrent(session.owner);
  }
  private static publish(session: Session, updates: Partial<InitialContactsSnapshot>) {
    if (!this.active(session)) return;
    this.snapshot = { ...this.snapshot, ...updates };
    this.listeners.forEach((listener) => listener());
  }
  static clear() {
    this.session?.controller.abort();
    this.session = null;
    this.snapshot = EMPTY;
    this.listeners.forEach((listener) => listener());
  }

  static async begin(result: AuthResult, provider: "google" | "apple", attemptId: string, findContacts: boolean): Promise<void> {
    const sequence = ++this.beginSequence;
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || owner.userId !== result.user.uid) { delete result.contactsGrant; return; }
    const state = await PreVaultUserStateService.bootstrapState(result.user.uid, { idToken: result.idToken });
    if (sequence !== this.beginSequence || !isValidatedAuthSessionOwnerCurrent(owner)) { delete result.contactsGrant; return; }
    if (state.setupCompleted !== false || state.initialContactsWelcomeAcknowledged === true) {
      delete result.contactsGrant;
      return;
    }
    // First enrollment needs positive new-account evidence. Older native
    // shells can omit this field; missing evidence must not enroll a legacy
    // incomplete account. A previously enrolled signup may still resume.
    if (result.isNewUser !== true && state.initialContactsWelcomeAcknowledged !== false) {
      delete result.contactsGrant;
      return;
    }
    this.clear();
    const source = initialContactSource(provider, Capacitor.isNativePlatform());
    const session: Session = {
      user: result.user, attemptId, controller: new AbortController(), read: null,
      matching: null, filling: null, filled: false, attemptedMembers: new Set(), owner,
    };
    this.session = session;
    this.publish(session, { ownerId: result.user.uid, attemptId, source, status: "deferred" });
    // Reading can run alongside phone verification. Normalization/matching waits.
    const grant = result.contactsGrant;
    delete result.contactsGrant;
    if (provider === "google" && findContacts && grant?.accessToken) {
      this.captureRead(session, googlePeopleContactSource(grant.accessToken, session.controller.signal)({ limit: 10_000 }));
    }
    if (this.active(session) && state.initialContactsWelcomeAcknowledged !== false) await PreVaultUserStateService.updatePreVaultState(result.user.uid, { initialContactsSource: source }, { idToken: result.idToken });
  }

  static async restore(user: User, state: PreVaultUserState) {
    if (state.initialContactsWelcomeAcknowledged !== false || this.snapshot.ownerId === user.uid) return;
    const sequence = this.beginSequence;
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || owner.userId !== user.uid) return;
    const provider = await AuthService.initialContactsSignInProvider(user, () => isValidatedAuthSessionOwnerCurrent(owner));
    if (sequence !== this.beginSequence || this.snapshot.ownerId === user.uid || !isValidatedAuthSessionOwnerCurrent(owner)) return;
    this.clear();
    const session: Session = { user, attemptId: `resume_${user.uid}`, controller: new AbortController(),
      read: null, matching: null, filling: null, filled: false, attemptedMembers: new Set(), owner };
    this.session = session;
    this.publish(session, { ownerId: user.uid, attemptId: session.attemptId,
      source: provider === "apple.com" || provider === "google.com"
        ? initialContactSource(provider === "apple.com" ? "apple" : "google", Capacitor.isNativePlatform())
        : state.initialContactsSource ?? "none", status: "deferred" });
  }

  private static captureRead(session: Session, read: Promise<HushhContactsReadResult>) {
    session.filled = false;
    this.publish(session, { status: "reading", error: null, candidates: [], result: null });
    session.read = read;
    void read.then(() => {
      if (this.snapshot.status === "reading") this.publish(session, { status: "waiting_for_phone" });
    }, () => {
      if (!this.active(session)) return;
      session.read = null;
      this.publish(session, { status: "error", error: "Contact access is unavailable. You can retry or continue." });
    });
  }

  /** Invoke directly from a tap: GIS/OS consent cannot start after token awaits. */
  static startSource(): void {
    const session = this.session;
    if (!session || !this.active(session) || session.matching || this.snapshot.status === "reading") return;
    let read: Promise<HushhContactsReadResult>;
    if (this.snapshot.source === "device" && Capacitor.isNativePlatform()) {
      read = HushhContacts.requestPermission().then((permission) => {
        if (!this.active(session)) throw new DOMException("Ended", "AbortError");
        if (!["granted", "limited"].includes(permission.state)) throw new Error("contacts_not_granted");
        return HushhContacts.readContacts({ limit: 10_000 });
      });
    } else if (this.snapshot.source === "google") {
      const token = Capacitor.isNativePlatform()
        ? HushhAuth.authorizeGoogleContacts({ expectedUserId: session.user.uid, requestMissingScope: true }).then((grant) => grant.accessToken)
        : requestGoogleContactsToken(session.controller.signal);
      read = token.then((accessToken) => {
        if (!this.active(session)) throw new DOMException("Ended", "AbortError");
        return googlePeopleContactSource(accessToken, session.controller.signal)({ limit: 10_000 });
      });
    } else return;
    this.captureRead(session, read);
  }

  static async matchWhenVerified(): Promise<void> {
    const session = this.session;
    if (!session || !session.read || session.matching || !this.active(session) || this.snapshot.result) return;
    const identity = await AccountIdentityService.refreshCurrentUserIdentity(session.user);
    if (!this.active(session) || !AccountIdentityService.hasVerifiedPhone(identity)) return;
    if (session.matching) return;
    const task = (async () => {
      const idToken = await session.user.getIdToken();
      if (!idToken || !this.active(session)) return;
      // Use One's existing matching policy independently of source permission.
      // Never turn discoverability on because Google or the OS granted access.
      const preference = await RiaService.getContactDiscoverability(idToken);
      if (!this.active(session)) return;
      if (preference.iam_schema_ready === false || preference.contact_sync_match_policy_version !== CONTACT_SYNC_MATCH_POLICY_VERSION) {
        throw new Error("Contact privacy is not ready.");
      }
      const capturedRead = session.read;
      if (!capturedRead) return;
      this.publish(session, { status: "matching", error: null });
      const result = await syncOneLocationContactSignals({
        idToken, accountPhoneNumber: identity?.phone_number, accountEmail: session.user.email,
        // Supplying the verified hint resolver preserves the existing rule:
        // a missing hint leaves national numbers unchecked, never locale-guessed.
        resolveAccountPhoneNumber: () => {
          if (!this.active(session)) throw new DOMException("Ended", "AbortError");
          return identity?.phone_number ?? null;
        },
        source: async () => capturedRead, signal: session.controller.signal, context: "signup",
        onInviteCandidates: (candidates) => this.publish(session, { candidates }),
      });
      if (!this.active(session)) return;
      session.read = null;
      this.publish(session, { status: "ready", result,
        error: result.partial ? "Some contacts could not be checked. You can still continue." : null });
    })();
    session.matching = task;
    try { await task; } catch {
      this.publish(session, { status: "error", error: "We could not finish checking contacts. You can retry or continue." });
    } finally { if (session.matching === task) session.matching = null; }
  }

  static async prepareCircle(vaultOwnerToken: string): Promise<void> {
    const session = this.session;
    if (!session || !this.active(session) || session.filled) return;
    if (session.filling) return session.filling;
    const processedResult = this.snapshot.result;
    this.publish(session, { circleError: null });
    const task = (async () => {
      const idToken = await session.user.getIdToken();
      if (!idToken || !this.active(session)) return;
      // Result identities with suppressed/request-required outcomes are excluded.
      const matched = new Set((processedResult?.matches ?? [])
        .filter((match) => match.outcome === "auto_connected" || match.outcome === "already_connected")
        .map((match) => match.userId));
      const confirmed: ConnectionSummaryEntry[] = [];
      if (matched.size) {
        // Provenance, rather than a response ID alone, proves a Contacts source.
        // Bound paging to the same 10k initial read budget.
        for (let page = 1; page <= 100; page += 1) {
          if (!this.active(session)) return;
          const result = await ConnectionsService.listConnectionsPage({ idToken, page, limit: 100 });
          if (!this.active(session)) return;
          confirmed.push(...result.items.filter((entry) => entry.connectedFromContacts === true && matched.has(entry.userId)));
          if (!result.hasMore) break;
        }
      }
      const people = Array.from(new Map(confirmed
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.userId.localeCompare(b.userId))
        .map((entry) => [entry.userId, entry])).values());
      const candidates = people.map((person) => person.userId);
      const selected = candidates.slice(0, 99);
      this.publish(session, { people: people.slice(0, 3), overflow: Math.max(0, candidates.length - selected.length) });
      const circle = this.snapshot.circle ?? await OneLocationService.bootstrapOnboardingCircle({
        idToken, name: "Contacts", purpose: "signup_contacts_v1",
      });
      if (!this.active(session)) return;
      this.publish(session, { circle });
      for (let index = 0; index < selected.length; index += 20) {
        if (!this.active(session)) return;
        const ids = selected.slice(index, index + 20).filter((id) => !session.attemptedMembers.has(id));
        if (!ids.length) continue;
        // Authority-side signup mode is insert-only, including across reloads:
        // retrying an uncertain response cannot restore removed memberships.
        const added = await OneLocationService.addNamedCircleMembers({
          vaultOwnerToken, circleId: circle.circleId, inviteeUserIds: ids, context: "signup",
        });
        if (!this.active(session)) return;
        ids.forEach((id) => session.attemptedMembers.add(id));
        this.publish(session, { membersAdded: this.snapshot.membersAdded + added.added.length });
      }
      // An empty circle can be prepared while contacts are deferred/loading.
      // Freeze automatic membership only once the read/match result is terminal.
      session.filled = Boolean(processedResult && processedResult === this.snapshot.result);
    })();
    session.filling = task;
    try { await task; } catch {
      this.publish(session, { circleError: "Circle setup could not finish. You can retry or continue." });
    } finally {
      if (session.filling === task) session.filling = null;
      if (this.active(session) && this.snapshot.result && this.snapshot.result !== processedResult) {
        await this.prepareCircle(vaultOwnerToken);
      }
    }
  }

  static async acknowledge(user?: User): Promise<void> {
    const session = this.session;
    const ownerUser = user ?? session?.user;
    const owner = snapshotValidatedAuthSessionOwner();
    if (!ownerUser || !owner || owner.userId !== ownerUser.uid) return;
    const isCurrent = () => isValidatedAuthSessionOwnerCurrent(owner);
    this.beginSequence += 1;
    try {
      const idToken = await ownerUser.getIdToken();
      if (!isCurrent()) return;
      await PreVaultUserStateService.updatePreVaultState(ownerUser.uid, { initialContactsWelcomeAcknowledged: true }, { idToken });
    } finally {
      // Optional welcome failures cannot strand this authenticated session.
      // A failed durable ack may be retried on a fresh session, without refill.
      if (isCurrent()) this.dismissedOwners.add(ownerUser.uid);
      if (session && this.session === session) this.clear();
    }
  }
}
