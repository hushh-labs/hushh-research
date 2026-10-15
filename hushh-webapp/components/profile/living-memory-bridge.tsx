"use client";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import { AuthService } from "@/lib/services/auth-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  refreshMemoryDocument,
  watchMemoryFreshness,
  clearMemoryDocument,
  markMemoryRefreshPending,
} from "@/lib/pkm/memory-refresh";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { NATIVE_CONNECTOR_RETURN_EVENT, type NativeConnectorReturn } from "@/lib/navigation/use-deep-link-return";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { payoutChangeTouches, subscribePayoutStateChanged } from "@/lib/payouts/payout-events";
import { AGENT_CHAT_HISTORY_INVALIDATED_EVENT } from "@/lib/agent/agent-chat-history-events";
import {
  LIVING_SOURCE_DOMAIN,
  LivingSourcesIncompleteError,
  syncLivingSources,
} from "@/lib/pkm/living-source-sync";
import { clearLivingSourceSessionVerification } from "@/lib/pkm/living-source-session-verification";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

/** Continuous unlocked-session updates only. Closed/locked operation requires
 * the separately reviewed owner-controlled runtime, never a browser key cache. */
export function LivingMemoryBridge() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) return;
    const userId = user.uid;
    const epoch = snapshotVaultSessionEpoch();
    let stopped = false;
    let running = false;
    let pending = false;
    let sourceDirty = true;
    let connectionHintVersion = 0;
    let scannedConnectionVersion = 0;
    let payoutHintVersion = 0;
    let scannedPayoutVersion = 0;
    let activityHintVersion = 0;
    let scannedActivityVersion = 0;
    let consentHintVersion = 0;
    let scannedConsentVersion = 0;
    let requestPaymentHintVersion = 0;
    let scannedRequestPaymentVersion = 0;
    let connectorHintVersion = 0;
    let scannedConnectorVersion = 0;
    const stopWatch = watchMemoryFreshness(userId);
    const build = async () => {
      if (stopped || !isVaultSessionEpochCurrent(epoch)) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      do {
        pending = false;
        try {
          if (
            sourceDirty &&
            !shouldSkipReviewerBackgroundWritesForAutomation()
          ) {
            sourceDirty = false;
            const idToken = await AuthService.getIdToken();
            if (!idToken) throw new Error("Source authorization unavailable");
            const connectionVersion = connectionHintVersion;
            const payoutVersion = payoutHintVersion;
            const activityVersion = activityHintVersion;
            const consentVersion = consentHintVersion;
            const requestPaymentVersion = requestPaymentHintVersion;
            const connectorVersion = connectorHintVersion;
            if (!stopped && isVaultSessionEpochCurrent(epoch)) {
              try {
                await syncLivingSources({
                  userId,
                  vaultKey,
                  vaultOwnerToken,
                  idToken,
                  forceConnections: connectionVersion > scannedConnectionVersion,
                  forceDocumentEarnings: payoutVersion > scannedPayoutVersion,
                  forcePayoutActivity: activityVersion > scannedActivityVersion,
                  forceConsent: consentVersion > scannedConsentVersion,
                  forceDocumentRequestPayments: requestPaymentVersion > scannedRequestPaymentVersion,
                  forceCuratedConnectors: connectorVersion > scannedConnectorVersion,
                });
              } catch (error) {
                if (!(error instanceof LivingSourcesIncompleteError)) throw error;
                // The verified sources were stored. Each forced read got its
                // attempt; a failed source stays pending and is retried on a
                // later wake. Still refresh, so the mirror shows what was checked.
                sourceDirty = true;
              }
              scannedConnectionVersion = connectionVersion;
              scannedPayoutVersion = payoutVersion;
              scannedActivityVersion = activityVersion;
              scannedConsentVersion = consentVersion;
              scannedRequestPaymentVersion = requestPaymentVersion;
              scannedConnectorVersion = connectorVersion;
            }
          }
          if (stopped || !isVaultSessionEpochCurrent(epoch)) break;
          const metadata = await PersonalKnowledgeModelService.getMetadata(
            userId,
            true,
            vaultOwnerToken,
          );
          if (!metadata) throw new Error("Source inventory unavailable");
          if (stopped || !isVaultSessionEpochCurrent(epoch)) break;
          // refreshMemoryDocument already tracks, per user, whether anything
          // relevant changed since its last read (via the same domain-change
          // subscription watchMemoryFreshness uses) and skips the network
          // when nothing did. Forcing past that on every trigger -- focus,
          // the 60s interval, every consent mutation -- re-fetched domains
          // that will legitimately 404 forever (never created) on every one
          // of those triggers: tens of identical requests in one short
          // session. Let its own freshness check decide.
          await refreshMemoryDocument({
            userId,
            vaultKey,
            vaultOwnerToken,
            domains: (metadata.domains ?? [])
              .map((domain) => domain.key)
              .filter(Boolean),
            force: false,
          });
        } catch {
          sourceDirty = true;
          markMemoryRefreshPending(userId);
        }
      } while (pending && !stopped);
      running = false;
    };
    const refreshSources = (event?: Event) => {
      const owner = (event as CustomEvent<{ userId?: string }> | undefined)
        ?.detail?.userId;
      if (owner && owner !== userId) return;
      sourceDirty = true;
      markMemoryRefreshPending(userId);
      void build();
    };
    const stopChanges = subscribeToPkmDomainChanges((detail) => {
      if (detail.userId === userId && (detail.domain !== LIVING_SOURCE_DOMAIN || detail.operation !== "stored")) {
        pending = true;
        void build();
      }
    });
    let identitySignature = "";
    const stopCache = CacheService.getInstance().subscribe((event) => {
      if (
        event.type === "set" &&
        event.key === CACHE_KEYS.ACCOUNT_IDENTITY(userId)
      ) {
        const identity = CacheService.getInstance().peek<{
          display_name?: string;
          photo_url?: string;
          email?: string;
        }>(event.key)?.data;
        const signature = JSON.stringify([
          identity?.display_name,
          identity?.photo_url,
          identity?.email,
        ]);
        if (signature !== identitySignature) {
          identitySignature = signature;
          refreshSources();
        }
      }
    });
    const onConsentChanged = (event: Event) => {
      const owner = (event as CustomEvent<{ userId?: string }>).detail?.userId;
      if (owner && owner !== userId) return;
      consentHintVersion++;
      // Committed payment ready, paid and refund document events use this
      // request-scoped feed signal. The snapshot remains the authority.
      requestPaymentHintVersion++;
      refreshSources();
    };
    const onNativeConnectorReturn = (event: Event) => {
      if ((event as CustomEvent<NativeConnectorReturn>).detail?.outcome !== "ready") return;
      connectorHintVersion++;
      refreshSources();
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
    window.addEventListener(NATIVE_CONNECTOR_RETURN_EVENT, onNativeConnectorReturn);
    const stopConnectionChanges = subscribeToConnectionGraphChanges((detail) => {
      if (detail.userId === userId) {
        connectionHintVersion++;
        refreshSources();
      }
    });
    const stopPayoutChanges = subscribePayoutStateChanged((detail) => {
      let changed = false;
      if (payoutChangeTouches(detail, ["earnings"])) {
        payoutHintVersion++;
        changed = true;
      }
      if (payoutChangeTouches(detail, ["wallet", "earnings", "bank_payouts"])) {
        activityHintVersion++;
        changed = true;
      }
      if (changed) refreshSources();
    });
    window.addEventListener(
      AGENT_CHAT_HISTORY_INVALIDATED_EVENT,
      refreshSources,
    );
    window.addEventListener("online", refreshSources);
    window.addEventListener("focus", refreshSources);
    // Browsers throttle timers in hidden tabs, so check again as soon as the
    // app is visible. Hiding it never starts a read.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshSources();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(refreshSources, 60_000);
    void build();
    return () => {
      stopped = true;
      stopChanges();
      stopWatch();
      stopCache();
      stopConnectionChanges();
      stopPayoutChanges();
      window.clearInterval(timer);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
      window.removeEventListener(NATIVE_CONNECTOR_RETURN_EVENT, onNativeConnectorReturn);
      window.removeEventListener(
        AGENT_CHAT_HISTORY_INVALIDATED_EVENT,
        refreshSources,
      );
      window.removeEventListener("online", refreshSources);
      window.removeEventListener("focus", refreshSources);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearMemoryDocument(userId);
      clearLivingSourceSessionVerification(userId);
    };
  }, [user?.uid, vaultKey, vaultOwnerToken, isVaultUnlocked]);
  return null;
}
