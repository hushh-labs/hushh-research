"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  CONTACT_SYNC_CONSENT_CONTRACT_VERSION,
  CONTACT_SYNC_MATCH_POLICY_VERSION,
  RiaService,
} from "@/lib/services/ria-service";

type ContactDiscoverabilityPreference = {
  ownerUserId: string | null;
  status: "signed_out" | "loading" | "undecided" | "decided" | "error";
  enabled: boolean;
  ruleVersion: number;
  error: string | null;
};

export type ContactDiscoverabilityConsentDialogProps = {
  open: boolean;
  ready: boolean;
  loading: boolean;
  savingChoice: boolean | null;
  error: string | null;
  actionLabel: string;
  onOpenChange: (open: boolean) => void;
  onChoose: (enabled: boolean) => Promise<void>;
  onRetry: () => void;
};

type UseContactDiscoverabilityConsentOptions = {
  userId?: string | null;
  getIdToken: (() => Promise<string | null>) | null;
  /** The fresh tap the person must make after recording a first-time choice. */
  actionLabel?: string;
};

const SIGNED_OUT_PREFERENCE: ContactDiscoverabilityPreference = {
  ownerUserId: null,
  status: "signed_out",
  enabled: false,
  ruleVersion: 0,
  error: null,
};

function consentRuleVersion(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0;
  return parsed;
}

function isCurrentConsentDecision(result: {
  contact_discoverable?: boolean;
  contact_sync_consent_enabled_at?: string | null;
  contact_sync_consent_contract_version?: string | null;
  contact_sync_consent_rule_version?: number;
  contact_sync_preference_state?: "default" | "enabled" | "disabled" | "invalid";
  contact_sync_match_policy_version?: string | null;
  iam_schema_ready?: boolean;
}): boolean {
  if (
    result.iam_schema_ready === false ||
    result.contact_sync_match_policy_version !==
      CONTACT_SYNC_MATCH_POLICY_VERSION
  ) {
    return false;
  }
  if (result.contact_sync_preference_state === "default") {
    return (
      consentRuleVersion(result.contact_sync_consent_rule_version) === 0 &&
      !result.contact_sync_consent_enabled_at &&
      !result.contact_sync_consent_contract_version
    );
  }
  if (result.contact_sync_preference_state === "enabled") {
    return (
      consentRuleVersion(result.contact_sync_consent_rule_version) > 0 &&
      Boolean(result.contact_sync_consent_enabled_at) &&
      result.contact_sync_consent_contract_version ===
        CONTACT_SYNC_CONSENT_CONTRACT_VERSION
    );
  }
  if (result.contact_sync_preference_state === "disabled") {
    return (
      consentRuleVersion(result.contact_sync_consent_rule_version) > 0 &&
      !result.contact_sync_consent_enabled_at &&
      !result.contact_sync_consent_contract_version
    );
  }
  return false;
}

/**
 * Owns the one-time contact-discoverability decision without owning a contact
 * source.
 *
 * The separation is intentional. Google GIS and the browser/native contact
 * pickers depend on a fresh user gesture, so accepting this disclosure must
 * never continue into a picker from an async callback. `requestContactCheck`
 * is synchronous: it either permits the current tap because a decision was
 * already recorded, or opens/loads this decision and consumes the tap.
 */
export function useContactDiscoverabilityConsent({
  userId,
  getIdToken,
  actionLabel = "Check contacts",
}: UseContactDiscoverabilityConsentOptions) {
  const normalizedUserId = String(userId || "").trim() || null;
  const hasTokenResolver = Boolean(getIdToken);
  const identityRef = useRef({
    userId: normalizedUserId,
    getIdToken,
    actionLabel,
  });
  useLayoutEffect(() => {
    identityRef.current = {
      userId: normalizedUserId,
      getIdToken,
      actionLabel,
    };
  }, [actionLabel, getIdToken, normalizedUserId]);

  const [preference, setPreferenceState] =
    useState<ContactDiscoverabilityPreference>(() =>
      normalizedUserId && getIdToken
        ? {
            ownerUserId: normalizedUserId,
            status: "loading",
            enabled: false,
            ruleVersion: 0,
            error: null,
          }
        : SIGNED_OUT_PREFERENCE,
    );
  const preferenceRef = useRef(preference);
  const setPreference = useCallback(
    (next: ContactDiscoverabilityPreference) => {
      preferenceRef.current = next;
      setPreferenceState(next);
    },
    [],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savingChoice, setSavingChoice] = useState<boolean | null>(null);
  const savingChoiceRef = useRef<boolean | null>(null);
  const generationRef = useRef(0);
  const ownerRef = useRef<string | null>(normalizedUserId);
  const pendingActionUserIdRef = useRef<string | null>(null);

  // Matched identities and a pending consent choice are both account-owned.
  // Clear them in a layout effect so a replacement account never paints the
  // previous account's prompt or save result for even one frame.
  useLayoutEffect(() => {
    if (ownerRef.current === normalizedUserId) return;
    ownerRef.current = normalizedUserId;
    generationRef.current += 1;
    pendingActionUserIdRef.current = null;
    setDialogOpen(false);
    savingChoiceRef.current = null;
    setSavingChoice(null);
    setPreference(
      normalizedUserId && hasTokenResolver
        ? {
            ownerUserId: normalizedUserId,
            status: "loading",
            enabled: false,
            ruleVersion: 0,
            error: null,
          }
        : SIGNED_OUT_PREFERENCE,
    );
  }, [hasTokenResolver, normalizedUserId, setPreference]);

  const readPreference = useCallback(
    async (
      ownerUserId: string,
      tokenResolver: () => Promise<string | null>,
      generation: number,
    ) => {
      try {
        const idToken = await tokenResolver();
        if (!idToken) throw new Error("Sign in to check contact privacy.");
        const result = await RiaService.getContactDiscoverability(idToken);
        if (
          generationRef.current !== generation ||
          identityRef.current.userId !== ownerUserId
        ) {
          return;
        }
        if (String(result.user_id || "").trim() !== ownerUserId) {
          throw new Error("Contact privacy was returned for another account.");
        }

        const ruleVersion = consentRuleVersion(
          result.contact_sync_consent_rule_version,
        );
        const decisionIsCurrent = isCurrentConsentDecision(result);
        const requestedWhileLoading =
          pendingActionUserIdRef.current === ownerUserId;
        pendingActionUserIdRef.current = null;
        setPreference({
          ownerUserId,
          status: decisionIsCurrent ? "decided" : "undecided",
          enabled: Boolean(result.contact_discoverable),
          ruleVersion,
          error: null,
        });

        if (!decisionIsCurrent && requestedWhileLoading) {
          setDialogOpen(true);
        } else if (requestedWhileLoading) {
          setDialogOpen(false);
          // The original tap was spent waiting on the network. Continuing from
          // here would lose browser transient activation, so name the one safe
          // next step instead of silently doing nothing.
          toast.info(
            `Privacy preference ready. Tap ${identityRef.current.actionLabel} again.`,
          );
        }
      } catch (error) {
        if (
          generationRef.current !== generation ||
          identityRef.current.userId !== ownerUserId
        ) {
          return;
        }
        const requestedWhileLoading =
          pendingActionUserIdRef.current === ownerUserId;
        pendingActionUserIdRef.current = null;
        setPreference({
          ownerUserId,
          status: "error",
          enabled: false,
          ruleVersion: 0,
          error:
            error instanceof Error && error.message
              ? error.message
              : "Could not check contact privacy.",
        });
        if (requestedWhileLoading) setDialogOpen(true);
      }
    },
    [setPreference],
  );

  const startPreferenceRead = useCallback(
    (presentWhenReady: boolean) => {
      const current = identityRef.current;
      if (!current.userId || !current.getIdToken) return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      if (presentWhenReady) {
        pendingActionUserIdRef.current = current.userId;
        setDialogOpen(true);
      }
      setPreference({
        ownerUserId: current.userId,
        status: "loading",
        enabled: false,
        ruleVersion: 0,
        error: null,
      });
      void readPreference(current.userId, current.getIdToken, generation);
    },
    [readPreference, setPreference],
  );

  // Warm the decision before the contact control is pressed. This network read
  // opens no account picker and asks for no new consent; its only job is to
  // keep a previously recorded choice from consuming the later user gesture.
  useEffect(() => {
    if (!normalizedUserId || !hasTokenResolver) return;
    startPreferenceRead(false);
    return () => {
      generationRef.current += 1;
    };
  }, [hasTokenResolver, normalizedUserId, startPreferenceRead]);

  const requestContactCheck = useCallback((): boolean => {
    const currentIdentity = identityRef.current;
    const currentPreference = preferenceRef.current;
    if (!currentIdentity.userId || !currentIdentity.getIdToken) return false;

    if (
      currentPreference.ownerUserId === currentIdentity.userId &&
      currentPreference.status === "decided"
    ) {
      // Enabled and disabled are both explicit decisions. Keeping private does
      // not prevent this person from checking their own address book.
      return true;
    }

    pendingActionUserIdRef.current = currentIdentity.userId;
    setDialogOpen(true);
    if (
      currentPreference.ownerUserId === currentIdentity.userId &&
      currentPreference.status === "undecided"
    ) {
      return false;
    }
    if (currentPreference.status !== "loading") {
      startPreferenceRead(true);
    }
    return false;
  }, [startPreferenceRead]);

  const choose = useCallback(
    async (enabled: boolean) => {
      const currentIdentity = identityRef.current;
      const currentPreference = preferenceRef.current;
      if (
        !currentIdentity.userId ||
        !currentIdentity.getIdToken ||
        currentPreference.ownerUserId !== currentIdentity.userId ||
        currentPreference.status !== "undecided" ||
        savingChoiceRef.current !== null
      ) {
        return;
      }

      const ownerUserId = currentIdentity.userId;
      const tokenResolver = currentIdentity.getIdToken;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      savingChoiceRef.current = enabled;
      setSavingChoice(enabled);
      setPreference({ ...currentPreference, error: null });
      try {
        const idToken = await tokenResolver();
        if (!idToken) throw new Error("Sign in to save contact privacy.");
        const result = await RiaService.setContactDiscoverability(
          idToken,
          enabled,
        );
        if (
          generationRef.current !== generation ||
          identityRef.current.userId !== ownerUserId
        ) {
          return;
        }
        const ruleVersion = consentRuleVersion(
          result.contact_sync_consent_rule_version,
        );
        if (
          String(result.user_id || "").trim() !== ownerUserId ||
          ruleVersion === 0
        ) {
          throw new Error("Contact privacy choice was not recorded.");
        }
        const savedEnabled = Boolean(result.contact_discoverable);
        const storedEnabled = Boolean(
          result.stored_contact_discoverable ?? result.contact_discoverable,
        );
        if (storedEnabled !== enabled || !isCurrentConsentDecision(result)) {
          throw new Error("Contact privacy choice was not recorded.");
        }

        pendingActionUserIdRef.current = null;
        setPreference({
          ownerUserId,
          status: "decided",
          enabled: savedEnabled,
          ruleVersion,
          error: null,
        });
        setDialogOpen(false);
        toast.success(
          savedEnabled
            ? `Contact matching is on. Tap ${identityRef.current.actionLabel} again to check your contacts.`
            : `You will stay private. Tap ${identityRef.current.actionLabel} again to check your contacts.`,
        );
      } catch (error) {
        if (
          generationRef.current !== generation ||
          identityRef.current.userId !== ownerUserId
        ) {
          return;
        }
        setPreference({
          ...currentPreference,
          error:
            error instanceof Error && error.message
              ? error.message
              : "Could not save contact privacy.",
        });
      } finally {
        if (
          generationRef.current === generation &&
          identityRef.current.userId === ownerUserId
        ) {
          savingChoiceRef.current = null;
          setSavingChoice(null);
        }
      }
    },
    [setPreference],
  );

  const onOpenChange = useCallback((open: boolean) => {
    if (savingChoiceRef.current !== null) return;
    setDialogOpen(open);
    if (!open) pendingActionUserIdRef.current = null;
  }, []);

  return {
    requestContactCheck,
    preference: {
      status: preference.status,
      enabled: preference.enabled,
      ruleVersion: preference.ruleVersion,
    },
    dialogProps: {
      open: dialogOpen,
      ready: preference.status === "undecided",
      loading: preference.status === "loading",
      savingChoice,
      error: preference.error,
      actionLabel,
      onOpenChange,
      onChoose: choose,
      onRetry: () => startPreferenceRead(true),
    } satisfies ContactDiscoverabilityConsentDialogProps,
  };
}
