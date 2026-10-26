"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

import { useAuth } from "@/hooks/use-auth";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { VaultService } from "@/lib/services/vault-service";
import { resolveLocalReviewerCredentials } from "@/lib/testing/local-reviewer-auth";
import { useNativeTestConfig } from "@/lib/testing/native-test";
import { signInOperatorReviewer } from "@/lib/testing/reviewer-operator-auth";
import { isHumanReviewerSession, humanReviewerAdmissionStage } from "@/lib/testing/reviewer-authentication-policy.mjs";
import { updateBootstrapStatus } from "@/lib/testing/reviewer-bootstrap-status";
import { withNativeTestVaultRetry, withVaultBootstrapTimeout } from "@/lib/testing/native-test-vault-retry";
import { useVault } from "@/lib/vault/vault-context";
import { isValidatedAuthSessionOwnerCurrent, snapshotAuthSessionGeneration, snapshotValidatedAuthSessionOwner, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** Six characters of a uid: enough to tell two identities apart in a log line, never a secret. */
function uidPrefix(uid: string | null | undefined): string {
  return String(uid ?? "").slice(0, 6);
}


function nativeTestErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/401|403|auth|sign in/.test(message)) return "authentication";
  if (/404|not found/.test(message)) return "not_found";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/network|connection|fetch/.test(message)) return "network";
  if (/vault|decrypt|crypto/.test(message)) return "vault";
  if (/rate limit/.test(message)) return "rate_limit";
  return "other";
}

let nativeTestReviewerBootstrapInflight: Promise<void> | null = null;
let nativeTestReviewerBootstrapCooldownUntil = 0;
export function NativeTestBootstrap() {
  const config = useNativeTestConfig();
  const humanReviewer = isHumanReviewerSession(config);
  const operatorReviewer = config.reviewerAuthMode === "operator_issued_token";
  const operatorAdmissionRef = useRef<"fresh" | "issuing" | "verified" | "retired">("fresh");
  const { loading: authLoading, sessionVerificationRequired, user, userId, accountPrincipal, setNativeUser } = useAuth();
  const { isVaultUnlocked, unlockVault } = useVault();
  const [authRetryTick, setAuthRetryTick] = useState(0);
  const [vaultRetryTick, setVaultRetryTick] = useState(0);
  const unlockRetryGenerationRef = useRef<number | null>(null);
  const authAttemptedRef = useRef(false);
  const authAttemptedAtRef = useRef(0);
  const identityMismatchForExpectedUserRef = useRef<string | null>(null);
  const identityMismatchObservedUidRef = useRef<string | null>(null);
  const replacedPersistedUidRef = useRef<string | null>(null);
  const nativeSessionRecoveryInFlightRef = useRef<object | null>(null);

  useEffect(() => {
    const bridge = window.__HUSHH_NATIVE_TEST__;
    if (!humanReviewer || !bridge) return;
    const observe = () => {
      const owner = snapshotValidatedAuthSessionOwner();
      return {
        ownerMatches: Boolean(config.expectedUserId && owner?.userId === config.expectedUserId && user?.uid === config.expectedUserId),
        authReady: !authLoading && Boolean(owner),
        unlocked: isVaultUnlocked,
        authGeneration: owner?.generation ?? null,
        vaultEpoch: snapshotVaultSessionEpoch(),
      };
    };
    bridge.reviewerSessionSnapshot = observe;
    return () => { if (bridge.reviewerSessionSnapshot === observe) delete bridge.reviewerSessionSnapshot; };
  }, [humanReviewer, config, user?.uid, authLoading, isVaultUnlocked]);

  useEffect(() => {
    if (!config.enabled || !config.autoReviewerLogin) {
      return undefined;
    }

    if (operatorReviewer && operatorAdmissionRef.current === "retired") {
      updateBootstrapStatus("auth_error", { userId: "", invalidate: true, errorClass: "authentication" });
      return undefined;
    }

    if (humanReviewer || (operatorReviewer && operatorAdmissionRef.current === "verified")) {
      const stage = humanReviewerAdmissionStage(config.expectedUserId, user?.uid ?? null,
        authLoading, operatorReviewer || Boolean(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId));
      if (operatorReviewer && (stage === "auth_error" || stage === "uid_mismatch")) {
        operatorAdmissionRef.current = "retired";
      }
      updateBootstrapStatus(stage, {
        userId: stage === "authenticated" ? user?.uid ?? "" : "",
        invalidate: stage !== "authenticated",
        errorClass: stage === "uid_mismatch" ? "identity" : stage === "auth_error" ? "authentication" : null,
      });
      return undefined;
    }

    if (authLoading) {
      updateBootstrapStatus("waiting_auth", {
        userId: user?.uid ?? null,
      });
      return undefined;
    }

    if (user) {
      if (operatorReviewer && operatorAdmissionRef.current !== "verified") {
        updateBootstrapStatus(operatorAdmissionRef.current === "issuing" ? "waiting_auth" : "auth_error", {
          userId: "", invalidate: true,
          errorClass: operatorAdmissionRef.current === "issuing" ? null : "authentication",
        });
        return undefined;
      }
      // A session the device kept from before the audit (a simulator whose
      // keychain survived an app removal, a phone signed in as its owner) is
      // not the requested fixture. When the audit names an identity and this
      // is not it, replace it once instead of auditing as whoever was there
      // last; a second sighting of the same uid after that is a real
      // mismatch and falls through to the ordinary failure below.
      if (
        config.expectedUserId &&
        user.uid !== config.expectedUserId &&
        replacedPersistedUidRef.current !== user.uid
      ) {
        replacedPersistedUidRef.current = user.uid;
        updateBootstrapStatus("authenticating");
        void AuthService.signOut()
          .catch(() => undefined)
          .finally(() => {
            // In native mode the auth context publishes identity only through
            // its own restore and sign-in paths and ignores Firebase state
            // changes, so the service sign-out alone leaves the persisted
            // user published; withdraw it explicitly.
            setNativeUser(null);
            setAuthRetryTick((value) => value + 1);
          });
        return undefined;
      }
      updateBootstrapStatus("authenticated", {
        userId: user.uid,
      });
      return undefined;
    }

    if (
      config.expectedUserId &&
      identityMismatchForExpectedUserRef.current === config.expectedUserId
    ) {
      updateBootstrapStatus("uid_mismatch", {
        errorClass: "identity",
        detail: `signin_result:${uidPrefix(identityMismatchObservedUidRef.current)}`,
      });
      return undefined;
    }

    const now = Date.now();
    const retryInMs = 5_000 - (now - authAttemptedAtRef.current);
    if (authAttemptedRef.current && retryInMs > 0) {
      const timer = window.setTimeout(() => {
        setAuthRetryTick((value) => value + 1);
      }, Math.max(250, retryInMs));
      return () => window.clearTimeout(timer);
    }

    if (authAttemptedRef.current) {
      authAttemptedRef.current = false;
    }

    if (now < nativeTestReviewerBootstrapCooldownUntil) {
      return undefined;
    }

    authAttemptedRef.current = true;
    authAttemptedAtRef.current = now;
    updateBootstrapStatus("authenticating");

    nativeTestReviewerBootstrapInflight ??= (async () => {
      try {
        // Simulator/emulator app removal does not always clear the native
        // Firebase keychain entry. A reviewer audit must begin from the
        // requested fixture, never reuse whichever native identity was last
        // present on the device.
        if (Capacitor.isNativePlatform()) {
          await AuthService.signOut().catch(() => undefined);
        }
        const useCustomReviewerToken =
          window.__HUSHH_NATIVE_TEST__?.reviewerAuthMode === "custom_token";
        const localReviewerCredentials = Capacitor.isNativePlatform() || useCustomReviewerToken
          ? null
          : resolveLocalReviewerCredentials(
              typeof window !== "undefined" ? window.location.hostname : null
            );
        if (operatorReviewer) operatorAdmissionRef.current = "issuing";
        const authResult = operatorReviewer
          ? await signInOperatorReviewer({
              enabled: config.enabled,
              autoReviewerLogin: config.autoReviewerLogin,
              reviewerAuthMode: config.reviewerAuthMode,
              expectedUserId: config.expectedUserId,
            })
          : localReviewerCredentials
          ? await AuthService.signInWithEmailAndPassword(
              localReviewerCredentials.email,
              localReviewerCredentials.password
            )
          : await (async () => {
              // The backend mint requires the reviewer passphrase.
              const { token } = await ApiService.createAppReviewModeSession("reviewer", {
                smokePassphrase: config.reviewerSessionPassphrase || config.vaultPassphrase,
                reviewerUid: config.expectedUserId,
              });
              return AuthService.signInWithCustomToken(token);
            })();
        const authenticatedUser = authResult.user;

        if (!authenticatedUser) {
          throw new Error("Native test bootstrap returned no authenticated user");
        }

        if (
          config.expectedUserId &&
          authenticatedUser.uid !== config.expectedUserId
        ) {
          if (operatorReviewer) operatorAdmissionRef.current = "retired";
          identityMismatchForExpectedUserRef.current = config.expectedUserId;
          identityMismatchObservedUidRef.current = authenticatedUser.uid;
          nativeTestReviewerBootstrapCooldownUntil = Date.now() + 5 * 60_000;
          updateBootstrapStatus("uid_mismatch", {
            errorClass: "identity",
            detail: `signin_result:${uidPrefix(authenticatedUser.uid)}`,
          });
          await AuthService.signOut();
          console.error("[NativeTestBootstrap] Auth bootstrap failed: identity_mismatch");
          return;
        }

        if (operatorReviewer) operatorAdmissionRef.current = "verified";
        setNativeUser(authenticatedUser);
        updateBootstrapStatus("authenticated", {
          userId: authenticatedUser.uid,
        });
      } catch (error) {
        if (operatorReviewer) operatorAdmissionRef.current = "retired";
        const message =
          error instanceof Error ? error.message : "Native test auth bootstrap failed";
        updateBootstrapStatus("auth_error", {
          ...(operatorReviewer ? { userId: "", invalidate: true } : {}),
          errorClass: nativeTestErrorClass(error),
        });
        if (/rate limit exceeded/i.test(message)) {
          nativeTestReviewerBootstrapCooldownUntil = Date.now() + 60_000;
        }
        console.error(
          `[NativeTestBootstrap] Auth bootstrap failed: ${nativeTestErrorClass(error)}`,
        );
      } finally {
        nativeTestReviewerBootstrapInflight = null;
      }
    })();
    return undefined;
  }, [
    authLoading,
    authRetryTick,
    config.autoReviewerLogin,
    config.enabled,
    config.expectedUserId,
    config.reviewerAuthMode,
    humanReviewer,
    operatorReviewer,
    config.reviewerSessionPassphrase,
    config.vaultPassphrase,
    setNativeUser,
    user,
  ]);

  useEffect(() => {
    if (humanReviewer || operatorReviewer) {
      if ((!operatorReviewer || operatorAdmissionRef.current === "verified") && humanReviewerAdmissionStage(config.expectedUserId, user?.uid ?? null,
        authLoading, Boolean(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId)) === "authenticated") {
        updateBootstrapStatus(isVaultUnlocked ? "vault_unlocked" : "authenticated", {
          userId: user!.uid, invalidate: !isVaultUnlocked,
        });
      }
      return;
    }
    if (!config.enabled || !config.autoReviewerLogin || (!config.vaultPassphrase && !isVaultUnlocked)) {
      return;
    }

    // Firebase identity is not application-owner admission. Restoring native
    // authentication may start validation, but cannot authorize vault reads.
    if (!user) {
      updateBootstrapStatus("waiting_vault_user", { userId: "", invalidate: true });
      let cancelled = false;
      const episode = snapshotAuthSessionGeneration();
      const attempt = {};
      if (Capacitor.isNativePlatform() && !nativeSessionRecoveryInFlightRef.current) {
        nativeSessionRecoveryInFlightRef.current = attempt;
        void AuthService.restoreNativeSession().then((restoredUser) => {
          if (!cancelled && episode && isValidatedAuthSessionOwnerCurrent(episode)
              && restoredUser && (!config.expectedUserId || restoredUser.uid === config.expectedUserId)) {
            setNativeUser(restoredUser);
          }
        }).finally(() => {
          if (nativeSessionRecoveryInFlightRef.current === attempt) nativeSessionRecoveryInFlightRef.current = null;
        });
      }
      return () => {
        cancelled = true;
        if (nativeSessionRecoveryInFlightRef.current === attempt) nativeSessionRecoveryInFlightRef.current = null;
      };
    }
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (authLoading || sessionVerificationRequired || !owner || !accountPrincipal
        || userId !== owner.ownerId || user.uid !== owner.firebaseUid
        || accountPrincipal.ownerId !== owner.ownerId
        || accountPrincipal.firebaseUid !== owner.firebaseUid
        || accountPrincipal.accountGeneration !== owner.accountGeneration) {
      updateBootstrapStatus("waiting_vault_user", { userId: "", invalidate: true });
      return;
    }
    if (config.expectedUserId && user.uid !== config.expectedUserId) {
      updateBootstrapStatus("uid_mismatch", { userId: "", invalidate: true, errorClass: "identity" });
      return;
    }
    if (isVaultUnlocked) {
      unlockRetryGenerationRef.current = null;
      updateBootstrapStatus("vault_unlocked", { userId: user.uid });
      return;
    }
    if (!config.vaultPassphrase) return;
    let cancelled = false;
    const vaultEpoch = snapshotVaultSessionEpoch();
    const isCurrent = () => !cancelled && isValidatedAuthSessionOwnerCurrent(owner)
      && snapshotVaultSessionEpoch() === vaultEpoch;
    updateBootstrapStatus("loading_vault_state", { userId: user.uid, invalidate: true });

    void (async () => {
      try {
        // The authenticated bootstrap snapshot is the single admission read
        // for vault presence, phone, and setup state. Calling the native vault
        // plugin first duplicated the same backend lookup and could leave iOS
        // stuck in `checking vault` while this authoritative snapshot waited.
        const setupState = await withNativeTestVaultRetry(
          "Setup state load",
          () => isCurrent() ? PreVaultUserStateService.bootstrapState(owner.ownerId) : Promise.reject(new Error("Vault bootstrap retired")),
        );
        if (!isCurrent()) return;
        if (!setupState.hasVault) {
          throw new Error(
            "Reviewer fixture has no existing vault; native audit will not create one",
          );
        }

        const vaultState = await withNativeTestVaultRetry(
          "Vault state load",
          () => isCurrent() ? VaultService.getVaultState(owner.ownerId) : Promise.reject(new Error("Vault bootstrap retired")),
        );
        if (!isCurrent()) return;
        updateBootstrapStatus("unlocking_vault", {
          userId: user.uid,
        });
        const decryptedKey = await withVaultBootstrapTimeout(
          "Vault unlock",
          VaultService.unlockWithMethod({
            state: vaultState,
            method: "passphrase",
            secretMaterial: config.vaultPassphrase!,
          })
        );

        if (!isCurrent()) return;
        if (!decryptedKey) {
          throw new Error("Vault unlock returned no decrypted key");
        }

        if (!PreVaultUserStateService.isSetupResolved(setupState)) {
          throw new Error(
            "Reviewer fixture setup is unresolved; native audit will not mutate onboarding state",
          );
        }

        const { token, expiresAt } = await withVaultBootstrapTimeout(
          "Vault owner token issue",
          VaultService.getOrIssueVaultOwnerToken(owner.ownerId)
        );
        if (!isCurrent()) return;
        if (!unlockVault(decryptedKey, token, expiresAt)) {
          if (unlockRetryGenerationRef.current !== owner.generation) {
            unlockRetryGenerationRef.current = owner.generation;
            setVaultRetryTick((value) => value + 1);
            return;
          }
          throw new Error("Vault owner rejected unlock");
        }
        if (window.__HUSHH_NATIVE_TEST__?.enabled) {
          window.__HUSHH_NATIVE_TEST__.replayVaultUnlock = () => {
            if (isValidatedAuthSessionOwnerCurrent(owner)) unlockVault(decryptedKey, token, expiresAt);
          };
        }
        // Success is published by the next owner-bound unlocked render above.
      } catch (error) {
        if (!isCurrent()) return;
        updateBootstrapStatus("vault_error", {
          userId: user.uid,
          errorClass: nativeTestErrorClass(error),
        });
        console.error(
          `[NativeTestBootstrap] Vault bootstrap failed: ${nativeTestErrorClass(error)}`,
        );
      }
    })();
    return () => { cancelled = true; };
  }, [
    accountPrincipal,
    authLoading,
    sessionVerificationRequired,
    userId,
    vaultRetryTick,
    config.autoReviewerLogin,
    config.enabled,
    config.expectedUserId,
    humanReviewer,
    config.vaultPassphrase,
    operatorReviewer,
    isVaultUnlocked,
    setNativeUser,
    unlockVault,
    user,
  ]);

  return null;
}
