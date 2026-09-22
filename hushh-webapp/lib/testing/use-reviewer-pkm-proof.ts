"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createAgentPkmCaptureGuard, isAgentPkmProcessingReady } from "@/lib/agent/agent-pkm-capture-runtime";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { createReviewerPkmProof, type ReviewerPkmJson } from "@/lib/testing/reviewer-pkm-proof";
import type {} from "@/lib/testing/native-test";

const consumedBridges = new WeakSet<object>();

export function useReviewerPkmProof(state: {
  userId: string | null;
  authLoading: boolean;
  sessionVerificationRequired: boolean;
  isVaultUnlocked: boolean;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  tokenExpiresAt: number | null;
}) {
  const latest = useRef(state);
  useLayoutEffect(() => { latest.current = state; });
  useEffect(() => {
    const bridge = window.__HUSHH_NATIVE_TEST__;
    const { userId, vaultKey, vaultOwnerToken } = latest.current;
    const admitted = () => Boolean(bridge && window.__HUSHH_NATIVE_TEST__ === bridge &&
      bridge.enabled === true && bridge.autoReviewerLogin === true && bridge.pkmProofEnabled === true &&
      bridge.expectedUserId === userId && latest.current.userId === userId &&
      bridge.reviewerMutationPolicy === "bounded_mutation" && vaultOwnerToken &&
      isAgentPkmProcessingReady(latest.current, vaultOwnerToken));
    if (!bridge || !userId || !vaultKey || !vaultOwnerToken || !admitted()) return;
    const controller = new AbortController();
    const guard = createAgentPkmCaptureGuard({ userId, signal: controller.signal, isEnabled: admitted });
    const proof = createReviewerPkmProof({
      owner: userId, isCurrent: guard.isCurrent,
      load: async domain => {
        await guard.assertCurrent();
        const result = await PersonalKnowledgeModelService.loadDomainSnapshot({
          userId, domain, vaultKey, vaultOwnerToken, force: true,
        });
        await guard.assertCurrent();
        if (!result.snapshot || !result.data) return null;
        return { userId: result.snapshot.userId, domain: result.snapshot.domain,
          contentRevision: result.snapshot.contentRevision,
          data: result.data as Record<string, ReviewerPkmJson> };
      },
    });
    const api = {
      begin: async () => {
        if (consumedBridges.has(bridge) || !bridge.pkmProofExpectation) {
          return { ok: false, code: "refused" as const };
        }
        consumedBridges.add(bridge);
        return proof.begin(bridge.pkmProofExpectation);
      },
      verify: proof.verify,
    };
    bridge.pkmProof = api;
    return () => {
      controller.abort();
      proof.dispose();
      if (bridge.pkmProof === api) bridge.pkmProof = null;
    };
  }, [state.userId, state.vaultKey, state.vaultOwnerToken, state.isVaultUnlocked,
    state.authLoading, state.sessionVerificationRequired, state.tokenExpiresAt]);
}
