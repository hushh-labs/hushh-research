"use client";

/**
 * Contact sync, once, for every surface that offers it.
 * =====================================================
 *
 * Lifted whole out of `app/one/location/page.tsx`, where the flow lived as a
 * 200-line `useCallback` plus four things that are easy to leave behind: the
 * signal state and its initial value, a ref indirection, an in-flight guard,
 * and a mount effect that decides whether there is anything to read at all.
 * Connect's People section needs the same flow, and a second copy of it would
 * be a second copy of every judgement recorded in the comments below --
 * `config/protected-behaviors.json` already records what a duplicated rule
 * costs elsewhere in this repository.
 *
 * The hook is deliberately route-neutral. It knows about contacts, matches and
 * a share sheet; it does not know about Location, and the two things that were
 * Location-specific at the old call site -- the funnel attribution written when
 * somebody invites their unmatched contacts, and the wording of the referral
 * share -- are options the caller supplies. See `onInviteShareStarted` for why
 * the first one is not a detail.
 *
 * `syncOneLocationContactSignals`, `describeContactSyncOutcome` and
 * `ContactSyncResultsSheet` keep their existing homes and are imported from
 * them. Moving the sheet would drag a Playwright layout pack onto every pull
 * request that touches this flow (`scripts/ci/web-targeted-check.sh`), and the
 * matcher's name is the only Location-shaped thing left about either of them.
 *
 * A change confined to this module does re-run CI: `scripts/ci/web-targeted-check.sh`
 * routes `lib/contacts/` into BOTH the Connect pack and the One Location pack,
 * because this is shared code with two front doors. It did not until the commit
 * that added the region-provenance fix; before that a change here matched no
 * pack in the repo at all.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { HushhContacts } from "@/lib/capacitor";
import { isNative } from "@/lib/capacitor/platform";
import {
  INVITE_TO_ONE_DIALOG_TITLE,
  INVITE_TO_ONE_SHARE_TEXT,
  INVITE_TO_ONE_SHARE_TITLE,
  buildInviteToOneShare,
} from "@/lib/connect/invite-to-one";
import {
  isGoogleContactsConsentCancelled,
  preloadGoogleContactsAuth,
  requestGoogleContactsToken,
} from "@/lib/contacts/google-contacts-token";
import {
  googleContactsAvailability,
  googlePeopleContactSource,
} from "@/lib/contacts/google-people-source";
import { resolveContactSourceProbeFailure } from "@/lib/contacts/contact-source-availability";
import { createContactSyncAccountPhoneResolver } from "@/lib/contacts/contact-sync-identity";
import type { MarketplaceContactSource } from "@/lib/marketplace/contact-matching";
import { trackEvent } from "@/lib/observability/client";
import type { RouteId } from "@/lib/observability/route-map";
import {
  OneLocationContactSyncError,
  describeContactSyncOutcome,
  openContactPermissionSettings,
  syncOneLocationContactSignals,
  type OneLocationContactSignalResult,
} from "@/lib/one-location/contact-signals";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { ConnectionsService } from "@/lib/services/connections-service";
import { ReferralService } from "@/lib/services/referral-service";
import { isShareCancellationError, shareLink } from "@/lib/share/share-link";
import { useSettingsReturn } from "@/lib/permissions/use-settings-return";

export type ContactSyncStatus =
  | "idle"
  | "scanning"
  | "matched"
  | "empty"
  | "unavailable"
  | "restricted"
  | "denied"
  | "error";

/**
 * What the last sync established, kept after the results sheet is dismissed.
 *
 * Read by the caller to mark already-matched people in its own lists, and read
 * by this hook to describe a *failed* sync: the failure event reports the
 * counts as they stood before the attempt, because a sync that never completed
 * has none of its own.
 */
export type ContactSyncSignal = {
  status: ContactSyncStatus;
  matchedUserIds: string[];
  matchedCount: number;
  totalContacts: number;
  inviteCandidateCount: number;
  sourcePlatform?: OneLocationContactSignalResult["sourcePlatform"];
  /** Only part of the contact book was readable, so "no matches" is not final. */
  limited?: boolean;
  /** The contact book was larger than the read or lookup caps. */
  truncated?: boolean;
  error?: string | null;
  syncedAt?: string | null;
};

export const INITIAL_CONTACT_SYNC_SIGNAL: ContactSyncSignal = {
  status: "idle",
  matchedUserIds: [],
  matchedCount: 0,
  totalContacts: 0,
  inviteCandidateCount: 0,
  limited: false,
  truncated: false,
  error: null,
  syncedAt: null,
};

/**
 * Address-book size as a band rather than a number.
 *
 * How many contacts somebody has is a property of that person, so the payload
 * carries the band and never the figure. Exported because the onboarding
 * contacts step reports the same dimension from its own handler and there is
 * no version of this that may drift from the one used here.
 */
export function contactCountBucket(
  count: number,
): "0" | "1_10" | "11_50" | "51_250" | "251_plus" {
  if (count <= 0) return "0";
  if (count <= 10) return "1_10";
  if (count <= 50) return "11_50";
  if (count <= 250) return "51_250";
  return "251_plus";
}

/**
 * The note attached to a connection request sent from the results sheet.
 *
 * Says how the sender found the recipient and nothing else. It is not the
 * onboarding message, which asks for something narrower and stays written at
 * its own call site.
 */
const CONTACT_MATCH_REQUEST_MESSAGE = "I'd like to connect with you on Hushh.";

export type ContactSyncShareCopy = {
  title: string;
  text: string;
  dialogTitle: string;
};

/**
 * What an invite says when the sender has a referral link.
 *
 * The fallback below it, `buildInviteToOneShare()`, has fixed copy. This
 * defaults to the same wording so a caller that says nothing sends a message
 * about the app rather than about whichever feature happened to offer the
 * button -- a contact scan started from a directory should not promise
 * location sharing. A surface with a narrower promise to make overrides it.
 */
const DEFAULT_REFERRAL_SHARE: ContactSyncShareCopy = {
  title: INVITE_TO_ONE_SHARE_TITLE,
  text: INVITE_TO_ONE_SHARE_TEXT,
  dialogTitle: INVITE_TO_ONE_DIALOG_TITLE,
};

export type UseContactSyncOptions = {
  /** Which surface offered the sync. Reaches analytics and nothing else. */
  routeId: RouteId;
  /**
   * A Firebase id token, or `null` when nobody is signed in.
   *
   * Nullable rather than a function that resolves to null, because this check
   * has to be synchronous: on the Google path below, GIS is asked for a token
   * before the first `await` so Safari still counts the popup as part of the
   * button tap, and a token fetch in front of it would spend that activation.
   */
  getIdToken: (() => Promise<string | null>) | null;
  /**
   * The signed-in account's phone number. Tells the normalizer which region a
   * bare "9876543210" belongs to; without it every 10-digit contact is read as
   * North American.
   */
  accountPhoneNumber?: string | null;
  /** Waits for AuthContext's verified backend-phone hydration when needed. */
  resolveVerifiedAccountPhoneNumber?: () => Promise<string | null>;
  /** The signed-in account's own id, used to invalidate its cached graph. */
  userId?: string | null;
  /**
   * Refresh whatever list this surface shows people in. Called only after a
   * sync actually changed the connection graph, and awaited before the outcome
   * is announced, so the toast never claims a connection the list behind it
   * has not caught up to.
   *
   * Deliberately not wrapped in a `catch` here. A caller whose refresh failing
   * should not spoil a successful sync catches it itself -- which is exactly
   * what the Location hub does for its background refresh and pointedly does
   * not do for its recipient page.
   */
  onConnectionGraphChanged?: () => void | Promise<void>;
  /**
   * Mirror of `syncing`, for a caller that also keeps a page-wide busy state.
   *
   * The hook owns a plain boolean, so no caller has to invent a busy union to
   * use it. This exists for the surface that already has one and disables the
   * rest of its controls through it: without the mirror, moving this flow out
   * of that page would quietly re-enable every other button mid-sync.
   */
  onBusyChange?: (syncing: boolean) => void;
  /**
   * Called once, synchronously, when somebody starts the invite share.
   *
   * This is where funnel attribution goes, and it is the caller's to write
   * because attribution is not transferable between surfaces.
   * `rememberLocationInviteSource` records the Location journey's acquisition
   * source and first touch wins inside it: called from a surface that has
   * nothing to do with Location it does not merely add a wrong row, it consumes
   * the slot, so that device's later, genuine Location touch is never recorded
   * and Location acquisition under-reports from then on.
   *
   * Branching on `routeId` inside the hook was the obvious alternative and is
   * worse twice over: it puts a Location concept back into a shared module, and
   * `RouteId` carries five Location routes, so the condition would be wrong the
   * first time this mounts on one of the other four.
   */
  onInviteShareStarted?: () => void;
  /**
   * Overrides the invite wording used when a referral link exists.
   *
   * The default is the generic One copy, which is right for Connect. Location
   * has its own -- "Join me on Hushh" / "...so we can share location." /
   * "Invite to Hushh" -- and those strings live nowhere else and are asserted
   * by nothing. A migration that forgets this option therefore rewrites every
   * attributed invite on that surface and stays green while doing it.
   */
  referralShare?: ContactSyncShareCopy;
};

/** Exactly the props `ContactSyncResultsSheet` takes, ready to spread. */
export type ContactSyncResultsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: OneLocationContactSignalResult | null;
  syncing: boolean;
  onSyncAgain: () => void | Promise<void>;
  onInvite: () => void | Promise<void>;
  onRequestConnection: (userId: string) => Promise<void>;
};

export type UseContactSync = {
  /**
   * Whether there is any contact source to read here at all. False on a
   * desktop browser with no Google account configured -- the one case where
   * the control should not be rendered rather than rendered and refused.
   *
   * NOT a drop-in for Location's `contactsStepAvailable`
   * (app/one/location/page.tsx), and the difference is not cosmetic. That flag
   * starts `true` because its consumer is onboarding NAVIGATION -- it decides
   * whether the flow steps to "contacts" or skips to "invite". This one starts
   * unknown because its consumer is rendering. Wire this straight into that
   * prop and anyone who moves before the probe settles is sent past the
   * contacts step for good.
   */
  available: boolean;
  /** True when the device has no address book and Google is standing in. */
  googleFallback: boolean;
  syncing: boolean;
  signal: ContactSyncSignal;
  result: OneLocationContactSignalResult | null;
  resultsOpen: boolean;
  setResultsOpen: (open: boolean) => void;
  sync: () => Promise<void>;
  /**
   * Send somebody to the OS settings app for contact access, and watch for
   * them coming back.
   *
   * Exposed rather than kept private because the trip is only worth taking if
   * something is waiting on the other side: this arms the return watcher and
   * says the way back before they go. A surface that calls
   * `openContactPermissionSettings` directly gets the jump without either, and
   * that is the state this was reported in.
   */
  openContactSettings: () => Promise<void>;
  invite: () => Promise<void>;
  requestConnection: (addresseeUserId: string) => Promise<void>;
  resultsSheetProps: ContactSyncResultsSheetProps;
};

export function useContactSync(options: UseContactSyncOptions): UseContactSync {
  /**
   * Unknown until the probe below answers, and unknown renders nothing.
   *
   * Starting at `true` was the other option and it is worse where it is wrong.
   * The probe only ever downgrades: on a device with an address book it
   * confirms what was already shown, and on a desktop browser with no Google
   * account configured it takes the control away again. So `true` costs the
   * majority nothing and costs desktop a button that appears and then vanishes
   * -- which is the kind that gets caught mid-reach and reported as a bug.
   * `false` costs everyone a few milliseconds of absence instead, and on native
   * the probe is a bridge call that resolves before the tab has finished
   * painting.
   */
  const [available, setAvailable] = useState(false);
  const [googleFallback, setGoogleFallback] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [signal, setSignal] = useState<ContactSyncSignal>(
    INITIAL_CONTACT_SYNC_SIGNAL,
  );
  const [result, setResult] = useState<OneLocationContactSignalResult | null>(
    null,
  );
  const [resultsOpen, setResultsOpen] = useState(false);
  const resultOwnerUserIdRef = useRef(options.userId ?? null);

  /**
   * Latest options, so no caller is required to memoize what it passes in.
   * Two surfaces use this hook and one of them builds its refresh callback
   * inline; if that identity reached a dependency array below, every keystroke
   * in that page's search box would rebuild the sync callback.
   */
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  /**
   * The re-entrancy guard, and it has to be a ref rather than `syncing`.
   *
   * On the Google path the busy flag is not raised until GIS has already been
   * asked for a token, because raising it first would put a React render
   * between the tap and the popup. A second tap inside that window sees
   * `syncing === false` and starts a second scan of the same address book. A
   * ref is set in the same turn as the check that reads it.
   */
  const inFlightRef = useRef(false);

  /**
   * True from the moment we hand somebody to the OS settings app until they
   * come back with contact access on.
   *
   * Reported after an iOS build: "settings ios wali jab bhi open ho rahin,
   * either for syncing contacts or this settings, ek back tap mein app par
   * switch nahi karwa rha -- mereko application back mein dekh kar kholna
   * pda." Whether iOS draws its "‹ Back to Hushh" pill is iOS's call, but the
   * half that was ours was worse: the toast that sent them was gone by the
   * time they returned, nothing re-read the permission, and the only way
   * forward was to find the same button and press it again. So the trip ended
   * where it started no matter how they got back.
   *
   * A ref as well as state: the state drives the watcher, and the ref lets the
   * resume decide whether it is a resume without joining a dependency array
   * that would restart the watcher every render.
   */
  const [awaitingContactSettings, setAwaitingContactSettings] = useState(false);
  const awaitingContactSettingsRef = useRef(false);
  const markAwaitingContactSettings = useCallback((next: boolean) => {
    awaitingContactSettingsRef.current = next;
    setAwaitingContactSettings(next);
  }, []);

  useLayoutEffect(() => {
    const nextUserId = options.userId ?? null;
    if (resultOwnerUserIdRef.current === nextUserId) return;
    resultOwnerUserIdRef.current = nextUserId;
    // Matched identities and local contact display names belong to the account
    // that ran the scan. Clear them before a replacement account can paint.
    setResult(null);
    setResultsOpen(false);
    setSignal(INITIAL_CONTACT_SYNC_SIGNAL);
    markAwaitingContactSettings(false);
  }, [markAwaitingContactSettings, options.userId]);

  /**
   * The sync callback, read at click time rather than captured.
   *
   * "Sync again" and "Check more" live inside a toast that outlives the sync
   * that raised it. A `useCallback` cannot name itself inside its own body, and
   * this one is not stable anyway -- it reads the previous signal in order to
   * describe a failure, so a new identity exists after every sync. A toast
   * action that had captured the function would re-run whichever sync was
   * current when the toast appeared, and report the pre-sync counts of the sync
   * the person is trying to repeat. The ref holds whichever one is current at
   * the moment the button is actually pressed.
   */
  const syncRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Read at click time, exactly like {@link syncRef} and for the same reason:
   * the "Open Settings" action lives inside a toast that outlives the sync
   * that raised it, and the callback it points at is declared below `sync`.
   * Capturing it in `sync`'s closure would make `sync` depend on it and put
   * the two in a cycle.
   */
  const openContactSettingsRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Resolve the contact source before anybody reaches the button.
   *
   * Two things happen here and both are load-bearing. The permission probe
   * decides whether the device book is readable and, when it is not, whether a
   * configured Google account can stand in -- omit it and the Google fallback
   * is code that nothing ever enables, so desktop and Safari keep the "not
   * available here" refusal this feature exists to remove. And
   * `preloadGoogleContactsAuth()` warms GIS so `requestGoogleContactsToken()`
   * can run synchronously inside the later tap; carry the flag without the
   * preload and Safari blocks the popup, because the script load then lands
   * after the gesture that asked for it.
   *
   * No account UI is shown from here. Loading the library is not consent;
   * asking for the token is, and that only ever happens on a tap.
   */
  useEffect(() => {
    let cancelled = false;
    const googleConfigured = googleContactsAvailability() === "connectable";
    const preloadGoogleFallback = () => {
      if (!googleConfigured) return;
      void preloadGoogleContactsAuth().catch(() => {
        // The tap surfaces a retryable, actionable error if GIS is still
        // unreachable. Loading account UI during mount would violate consent.
      });
    };
    void HushhContacts.getPermissionState()
      .then((state) => {
        if (cancelled) return;
        const useGoogle = state?.state === "unavailable" && googleConfigured;
        setGoogleFallback(useGoogle);
        setAvailable(state?.state !== "unavailable" || useGoogle);
        if (useGoogle) preloadGoogleFallback();
      })
      .catch(() => {
        if (cancelled) return;
        // A failed probe is not evidence that there is nothing to read.
        //
        // On native there is an address book, always; the bridge call merely
        // did not answer. Treating that as "unavailable" would hide the
        // control on the platform the feature is mainly for -- and hide it
        // silently, since `googleContactsAvailability()` returns
        // "unconfigured" whenever `isNative()`, so the Google arm below can
        // never restore it there. The tap itself fails loudly and with a
        // remedy, which is the better place for a real failure to surface.
        //
        // On web the reasoning inverts: no plugin answer and no Google client
        // means there genuinely is no source, and a control that exists only
        // to explain that is worse than no control.
        const fallback = resolveContactSourceProbeFailure({
          native: isNative(),
          googleConfigured,
        });
        setGoogleFallback(fallback.googleFallback);
        setAvailable(fallback.available);
        if (fallback.googleFallback) preloadGoogleFallback();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const markSyncing = useCallback((next: boolean) => {
    setSyncing(next);
    optionsRef.current.onBusyChange?.(next);
  }, []);

  /**
   * Share the app with the contacts a scan could not match.
   *
   * Sends the person's own REFERRAL link, not the generic invite. That is the
   * whole difference between a share that is attributed and one that is not:
   * `/r/<slug>` resolves server-side and records the attribution BEFORE the
   * recipient reaches sign-in, so nothing downstream has to trust a slug the
   * client hands back afterwards. `buildInviteToOneShare` is a bare origin with
   * no token -- perfectly correct for its own purpose, and unattributable.
   *
   * The generic invite stays as the fallback for the one case the referral
   * system cannot serve: no link yet, or the summary call fails. Better a share
   * that works and is not counted than a dead control.
   */
  const invite = useCallback(async () => {
    const { getIdToken, onInviteShareStarted, referralShare } =
      optionsRef.current;
    onInviteShareStarted?.();

    let referralLink = "";
    try {
      const idToken = await getIdToken?.();
      if (idToken) {
        const summary = await ReferralService.getSummary({ idToken });
        referralLink = String(summary?.link || "").trim();
      }
    } catch {
      // A referral summary that will not load is not a reason to refuse the
      // share. Fall through to the generic invite.
    }

    const copy = referralShare ?? DEFAULT_REFERRAL_SHARE;
    const share = referralLink
      ? {
          title: copy.title,
          text: copy.text,
          url: referralLink,
          dialogTitle: copy.dialogTitle,
        }
      : buildInviteToOneShare();

    if (!share) {
      // No referral link AND no shareable origin -- the same condition that
      // hides the Connect invite row entirely rather than offering a link that
      // resolves to nothing.
      toast.error("Sharing is not available here.");
      return;
    }

    try {
      const delivery = await shareLink(share);
      if (delivery === "copied") {
        toast.success("Invite link copied.");
      }
    } catch (error) {
      if (isShareCancellationError(error)) return;
      toast.error("Could not open the share sheet.");
    }
  }, []);

  const requestConnection = useCallback(async (addresseeUserId: string) => {
    const { getIdToken, userId } = optionsRef.current;
    const idToken = await getIdToken?.();
    if (!idToken) throw new Error("Sign in to send a connection request.");
    await ConnectionsService.sendRequest({
      idToken,
      addresseeUserId,
      message: CONTACT_MATCH_REQUEST_MESSAGE,
    });
    if (userId) {
      CacheSyncService.onConnectionCapabilityMutated(userId);
    }
  }, []);

  const sync = useCallback(async () => {
    // Keep the transaction callbacks and initiating user stable. The account
    // phone is the exception: it is deliberately re-read below because verified
    // backend identity can finish hydrating while a picker is open.
    const { getIdToken, onConnectionGraphChanged, routeId, userId } =
      optionsRef.current;
    const initiatingUserId = userId ?? null;
    const resolveLatestAccountPhoneNumber =
      createContactSyncAccountPhoneResolver({
        initiatingUserId,
        getCurrentIdentity: () => ({
          userId: optionsRef.current.userId,
          accountPhoneNumber: optionsRef.current.accountPhoneNumber,
        }),
        hydrateAccountPhoneNumber:
          optionsRef.current.resolveVerifiedAccountPhoneNumber,
      });

    if (!getIdToken) {
      const message = "Sign in before syncing contacts.";
      setSignal((current) => ({
        ...current,
        status: "error",
        error: message,
      }));
      toast.error(message);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      // Google Contacts, only where there is no address book to read.
      //
      // `navigator.contacts.select` ships enabled by default in Chrome on
      // Android and nowhere else -- iOS Safari has it behind a flag, no desktop
      // browser has it at all. On those, this control had nothing to read and
      // said so. A Google account is not a device capability, so it works
      // everywhere a browser does.
      //
      // Deliberately a fallback rather than a second button. The device book is
      // the better source when it exists: it is the person's actual phone
      // contacts rather than whichever of them Google happens to hold, and it
      // needs no consent sheet. This only fires where the alternative is
      // nothing at all, and only when the build is configured for it --
      // `googleContactsAvailability()` is "unconfigured" without
      // NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID, which keeps the feature invisible
      // until the console work behind it is finished.
      let googleSource: MarketplaceContactSource | undefined;
      if (googleFallback) {
        try {
          // Invokes GIS before any await or state transition so Safari keeps
          // the click's transient activation for the popup.
          const googleToken = requestGoogleContactsToken();
          markSyncing(true);
          googleSource = googlePeopleContactSource(await googleToken);
        } catch (error) {
          // Closing the sheet is a choice, not a failed sync. A blocked popup
          // is intentionally not AbortError and is surfaced by the catch below.
          if (!isGoogleContactsConsentCancelled(error)) throw error;
          return;
        }
      }

      markSyncing(true);
      setSignal((current) => ({
        ...current,
        status: "scanning",
        error: null,
      }));

      const syncResult = await syncOneLocationContactSignals({
        // The source must run while the original tap still owns transient
        // browser activation. Token/identity network work is deliberately
        // deferred inside the sync pipeline until after the picker returns.
        resolveIdToken: getIdToken,
        ...(googleSource ? { source: googleSource } : {}),
        accountPhoneNumber: optionsRef.current.accountPhoneNumber,
        // Re-read after the native/Google source returns. Phone hydration can
        // complete while a permission or account picker is on screen.
        resolveAccountPhoneNumber: resolveLatestAccountPhoneNumber,
      });
      await resolveLatestAccountPhoneNumber();
      const nextStatus: ContactSyncStatus =
        syncResult.matchedUserIds.length > 0 ? "matched" : "empty";
      setResult(syncResult);
      setResultsOpen(true);
      setSignal({
        status: nextStatus,
        matchedUserIds: syncResult.matchedUserIds,
        matchedCount: syncResult.matchedUserIds.length,
        totalContacts: syncResult.totalContacts,
        inviteCandidateCount: syncResult.inviteCandidateCount,
        sourcePlatform: syncResult.sourcePlatform,
        limited: syncResult.limited,
        truncated: syncResult.truncated,
        error: null,
        syncedAt: new Date().toISOString(),
      });
      trackEvent("one_location_contact_signal_synced", {
        route_id: routeId,
        result: "success",
        source_platform: syncResult.sourcePlatform,
        contact_count_bucket: contactCountBucket(syncResult.totalContacts),
        matched_count: syncResult.matchedUserIds.length,
        invite_candidate_count: syncResult.inviteCandidateCount,
        contact_region: syncResult.region ?? "unknown",
        partial_access: syncResult.limited,
        truncated: syncResult.truncated,
      });
      if (
        userId &&
        (syncResult.autoConnectedCount + syncResult.alreadyConnectedCount > 0 ||
          syncResult.mutationOutcomeUnknown)
      ) {
        CacheSyncService.onConnectionGraphMutated(userId);
        await onConnectionGraphChanged?.();
      }
      // A partial read must never be reported as a whole one. The web Contact
      // Picker and iOS limited access both return only a hand-picked subset,
      // so "3 people added" would claim the whole address book was searched.
      const outcome = describeContactSyncOutcome(syncResult);
      const remedyAction = ((): {
        label: string;
        onClick: () => void;
      } | null => {
        switch (outcome.remedy) {
          case "pick_more":
            // Re-running the sync reopens the picker. There is no settings
            // page to send a browser to; openAppSettings resolves false.
            return {
              label: "Check more",
              onClick: () => void syncRef.current?.(),
            };
          case "sync_again":
            return {
              label: "Sync again",
              onClick: () => void syncRef.current?.(),
            };
          case "open_settings":
            return {
              label: "Open Settings",
              onClick: () => void openContactSettingsRef.current?.(),
            };
          case "invite":
            // The other half of a contact scan. Until this shipped, the count
            // of people who are NOT on One was computed on every sync and read
            // by nothing but an analytics dimension -- the product learned who
            // was missing, recorded it, and offered the person no way to act
            // on it.
            //
            // Reuses the existing invite share rather than minting a second
            // one, and deliberately carries no pre-authorized connection:
            // `buildInviteToOneShare` documents why, and an invite that
            // consents on the recipient's behalf is not an invite.
            return { label: "Invite them", onClick: () => void invite() };
          default:
            return null;
        }
      })();
      const outcomeOptions = {
        description: outcome.description,
        ...(remedyAction ? { action: remedyAction } : {}),
      };
      if (syncResult.matchedUserIds.length > 0) {
        toast.success(outcome.title, outcomeOptions);
      } else {
        toast.info(outcome.title, outcomeOptions);
      }
    } catch (error) {
      const failure =
        error instanceof OneLocationContactSyncError ? error.failure : "error";
      const message = oneLocationErrorMessage(
        error,
        "Could not sync contacts.",
      );
      setSignal((current) => ({
        ...current,
        status: failure,
        error: message,
        syncedAt: new Date().toISOString(),
      }));
      // The counts here belong to the last sync that finished, not to this one.
      // A sync that failed produced none of its own, and sending zeroes would
      // read downstream as an address book that emptied itself.
      trackEvent("one_location_contact_signal_synced", {
        route_id: routeId,
        result: failure === "error" ? "error" : "expected_error",
        source_platform: signal.sourcePlatform ?? "unknown",
        contact_count_bucket: contactCountBucket(signal.totalContacts),
        matched_count: signal.matchedCount,
        invite_candidate_count: signal.inviteCandidateCount,
        failure_reason: failure,
      });
      if (failure === "denied") {
        // The OS will not prompt again, so a retry button would do nothing.
        // Settings is the only route back.
        toast.error(message, {
          action: {
            label: "Open Settings",
            onClick: () => void openContactSettingsRef.current?.(),
          },
        });
      } else if (failure === "unavailable") {
        toast.info(message);
      } else {
        toast.error(message);
      }
    } finally {
      inFlightRef.current = false;
      markSyncing(false);
    }
  }, [googleFallback, invite, markSyncing, signal]);

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  /**
   * Hand them to the OS, and remember that we did.
   *
   * The remembering is the whole point. Without it the app treats the return
   * as an ordinary foreground and the person is back where they started.
   * `opened === false` means nothing launched -- a browser, or an OS that
   * refused -- and watching for a return from a place nobody went to would
   * leave the watcher armed forever.
   */
  const openContactSettingsAndWatch = useCallback(async () => {
    const opened = await openContactPermissionSettings();
    if (!opened) return;
    markAwaitingContactSettings(true);
    // Said before they leave, because after they leave there is no surface of
    // ours to say it on. Names the switch AND the way back, which is the part
    // the report singled out: "settings mein desired operation enable/disable
    // karne ke baad entry ka path bhi dete hain".
    toast.info("Turn on Contacts for Hushh, then come back — we'll pick up where you left off.");
  }, [markAwaitingContactSettings]);

  /**
   * Is contact access on now?
   *
   * `limited` counts. iOS limited access is a real grant over a hand-picked
   * subset, and a sync across that subset is exactly what somebody who chose
   * it asked for -- refusing to resume until they widen it would answer their
   * decision by ignoring it.
   */
  const readContactsGranted = useCallback(async () => {
    try {
      const permission = await HushhContacts.getPermissionState();
      return permission?.state === "granted" || permission?.state === "limited";
    } catch {
      return false;
    }
  }, []);

  const onContactsRestored = useCallback(() => {
    if (!awaitingContactSettingsRef.current) return;
    markAwaitingContactSettings(false);
    // Resume the work, not just the permission. The trip was never about the
    // switch -- it was about syncing contacts, and finishing that is what the
    // person actually came back for.
    toast.success("Contact access is on. Syncing…");
    void syncRef.current?.();
  }, [markAwaitingContactSettings]);

  useEffect(() => {
    openContactSettingsRef.current = openContactSettingsAndWatch;
  }, [openContactSettingsAndWatch]);

  useSettingsReturn({
    enabled: awaitingContactSettings,
    readGranted: readContactsGranted,
    onRestored: onContactsRestored,
    // No `permissionName`: the Permissions API has no entry for contacts, so
    // the lifecycle signals are the whole mechanism here.
  });

  return {
    available,
    googleFallback,
    syncing,
    signal,
    result,
    resultsOpen,
    setResultsOpen,
    sync,
    openContactSettings: openContactSettingsAndWatch,
    invite,
    requestConnection,
    resultsSheetProps: {
      open: resultsOpen,
      onOpenChange: setResultsOpen,
      result,
      syncing,
      onSyncAgain: sync,
      onInvite: invite,
      onRequestConnection: requestConnection,
    },
  };
}
