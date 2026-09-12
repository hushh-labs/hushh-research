"use client";

/**
 * Asking someone for their information, from wherever you happen to be.
 *
 * This is the second entry in the same category `global-voice-action-handlers`
 * opened with signing out, and it is worth saying why it belongs there rather
 * than on a page.
 *
 * Every local handler is registered by the screen that owns it, which is right
 * for a verb that only means something while you are standing on that screen:
 * "approve this circle request" has no meaning off Location. Consent was filed
 * that way too -- `people.profile.review_information_request` and
 * `people.profile.manage_consent` are registered by
 * `components/connections/person-profile-page.tsx`. That is defensible for
 * "connect" or "remove connection", which are about the person whose page you
 * are on.
 *
 * But "can we ask Sharu for her finance information" is said from anywhere, and
 * chat is not that page. `requireMountedLocalHandlers` drops any local handler
 * that is not mounted right now, so from chat the action vanished and the
 * agent's only remaining move was to send someone to a screen. That is what
 * made the consent lifecycle look broken when it was only mis-scoped: not a
 * missing capability, a capability nailed to the wrong surface.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * It does not decide anything. The scope refs, the person, the purpose and the
 * duration are all resolved SERVER-side from the proposal that
 * `propose_information_request` parked, and arrive here already expanded
 * (`_resolved_directive_slots` in action_tools.py). The model only ever passes
 * an opaque proposal id.
 *
 * That is the property that makes asking from chat safe: the model cannot widen
 * a request between the read-back the owner agreed to and the request actually
 * sent. It is the same reason `run_app_action` strips a model-supplied
 * `confirmed` flag -- a model saying it heard a yes is not authority. The
 * authority is the confirmation card the person taps, and the directive ledger
 * that binds it.
 */

import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useConsentActions } from "@/lib/consent/use-consent-actions";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { PersonProfileService } from "@/lib/services/person-profile-service";

/** Seconds, from the hours the proposal carried. */
function durationSeconds(hours: unknown): number {
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return 168 * 3600;
  return Math.round(value) * 3600;
}

function names(labels: unknown): string {
  const list = Array.isArray(labels)
    ? labels.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (!list.length) return "what you asked for";
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function GlobalConsentActionHandlers() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  // The same deny and revoke the consent screens run. A second copy of a
  // ledger write is how two surfaces drift apart, and revoking VAULT_OWNER
  // has to lock the vault whichever surface asked for it.
  const { handleDeny, handleRevoke } = useConsentActions({ userId: user?.uid });

  useLocalOnboardingActionHandler(
    "consent.request",
    async (slots) => {
      const personRef = String(slots?.personRef || "").trim();
      const scopeRefs = Array.isArray(slots?.scopeRefs)
        ? slots.scopeRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
        : [];
      const purpose = String(slots?.purpose || "").trim();

      // An unresolved proposal means the server could not expand the id -- the
      // proposal expired, or the session moved on. Refusing is the only honest
      // answer: guessing a scope here would be this handler inventing a request
      // nobody agreed to, which is the exact thing the server-side resolution
      // exists to prevent.
      // Minted server-side from the proposal id. Its absence means the same
      // thing an unresolved personRef means: this directive was not expanded,
      // so there is nothing trustworthy to send.
      const idempotencyKey = String(slots?.idempotencyKey || "").trim();

      if (!personRef || !scopeRefs.length || purpose.length < 8 || idempotencyKey.length < 16) {
        return {
          status: "failed" as const,
          summary: "That request is no longer ready. Ask me again and I will set it up.",
        };
      }

      if (!user?.uid) {
        return { status: "failed" as const, summary: "Sign in first." };
      }
      // The vault key never leaves memory, so a locked vault cannot mint the
      // connector this request is encrypted to. Say which step is missing
      // rather than failing generically.
      if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
        return {
          status: "failed" as const,
          summary: "Unlock your private agent first, then ask me again.",
        };
      }

      try {
        const connector = await OneKycClientZkService.ensureConnector({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
        });
        await PersonProfileService.createInformationRequest({
          personRef,
          scopeRefs,
          purpose,
          durationSeconds: durationSeconds(slots?.durationHours),
          connectorKeyId: connector.connector_key_id,
          // The server mints this from the proposal id, so it is the SAME key
          // every time this directive is delivered. The bundle id is derived
          // from it and the table is unique on it, which makes a redelivery a
          // no-op. A key generated here per attempt defeats that and turns one
          // retried directive into two live requests -- the duplicate ask.
          idempotencyKey,
          vaultOwnerToken,
        });
      } catch (reason) {
        const message =
          reason instanceof Error && reason.message
            ? reason.message
            : "The request could not be sent.";
        // Never report success for something that did not happen. A consent
        // request that silently failed is worse than one that never ran,
        // because the person believes they asked.
        return { status: "failed" as const, summary: message };
      }

      const who = String(slots?.displayName || "").trim();
      const summary = who
        ? `Asked ${who} for ${names(slots?.labels)}.`
        : `Asked for ${names(slots?.labels)}.`;
      toast.success(summary);
      return { status: "succeeded" as const, summary };
    },
    // Not registered while signed out or locked, so the action drops out of
    // available_action_ids rather than being offered and then refused.
    { enabled: Boolean(user && isVaultUnlocked) },
  );

  useLocalOnboardingActionHandler(
    "consent.deny",
    async (slots) => {
      const requestId = String(slots?.requestId || slots?.request_id || "").trim();
      if (!requestId) {
        return {
          status: "failed" as const,
          summary: "Say which request to decline and I will do it.",
        };
      }
      if (!user?.uid || !isVaultUnlocked) {
        return { status: "failed" as const, summary: "Unlock your private agent first." };
      }
      try {
        // `quiet` suppresses the screen's own toast (the agent speaks the
        // outcome) and, more importantly, makes failure observable: without
        // it the promise resolves the same way whether the deny landed or
        // the request 500'd.
        await handleDeny(requestId, { quiet: true });
      } catch (reason) {
        return {
          status: "failed" as const,
          summary:
            reason instanceof Error && reason.message
              ? reason.message
              : "That request could not be declined.",
        };
      }
      const summary = "Declined that request.";
      toast.success(summary);
      return { status: "succeeded" as const, summary };
    },
    { enabled: Boolean(user && isVaultUnlocked) },
  );

  useLocalOnboardingActionHandler(
    "consent.revoke",
    async (slots) => {
      // Resolved server-side from the opaque grant handle the model passed;
      // the model never holds a raw scope. An unexpanded handle means the
      // listing has aged out of the session, and guessing which grant was
      // meant is the one thing this must never do.
      const scope = String(slots?.scope || "").trim();
      const requestId = String(slots?.requestId || slots?.request_id || "").trim();
      if (!scope) {
        return {
          status: "failed" as const,
          summary: "I lost track of which one that was. Ask me what you're sharing and try again.",
        };
      }
      if (!user?.uid || !isVaultUnlocked) {
        return { status: "failed" as const, summary: "Unlock your private agent first." };
      }
      try {
        await handleRevoke(scope, requestId || undefined, { quiet: true });
      } catch (reason) {
        return {
          status: "failed" as const,
          summary:
            reason instanceof Error && reason.message
              ? reason.message
              : "That access could not be ended.",
        };
      }
      const what = String(slots?.label || "").trim();
      const who = String(slots?.holderLabel || "").trim();
      const summary = what
        ? `Ended ${who ? `${who}'s` : "that"} access to ${what}.`
        : "Ended that access.";
      toast.success(summary);
      return { status: "succeeded" as const, summary };
    },
    { enabled: Boolean(user && isVaultUnlocked) },
  );

  useLocalOnboardingActionHandler(
    "consent.cancel_request",
    async (slots) => {
      const bundleId = String(slots?.bundleId || "").trim();
      if (!bundleId) {
        return {
          status: "failed" as const,
          summary: "I could not tell which request that was. Ask me what you've sent.",
        };
      }
      if (!vaultOwnerToken) {
        return { status: "failed" as const, summary: "Unlock your private agent first." };
      }
      try {
        await PersonProfileService.cancelInformationRequest({ bundleId, vaultOwnerToken });
      } catch (reason) {
        return {
          status: "failed" as const,
          summary:
            reason instanceof Error && reason.message
              ? reason.message
              : "That request could not be withdrawn.",
        };
      }
      const who = String(slots?.displayName || "").trim();
      const summary = who ? `Withdrew your request to ${who}.` : "Withdrew that request.";
      toast.success(summary);
      return { status: "succeeded" as const, summary };
    },
    { enabled: Boolean(user && isVaultUnlocked) },
  );

  return null;
}
