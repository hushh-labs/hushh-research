"use client";

/**
 * lib/connect/use-connect-discovery.ts
 *
 * React hook that aggregates all Connect discovery sources.
 * Preserves existing marketplace UX — just provides a cleaner data layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  RiaService,
  type MarketplaceInvestor,
  type MarketplaceInvestorActionRecord,
  type RiaClientAccess,
} from "@/lib/services/ria-service";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  marketplaceInvestorActionTarget,
  marketplaceInvestorCardId,
  marketplaceInvestorUserId,
  isMarketplaceInvestorConnectable,
} from "@/lib/marketplace/investor-discovery";
import {
  buildMarketplaceConnectionsRoute,
  buildRiaClientWorkspaceRoute,
} from "@/lib/navigation/routes";
import { loadConnectPayload, loadContactMatches } from "./service";
import {
  normalizeRiaToCandidate,
  normalizeInvestorToCandidate,
  normalizeContactMatchToCandidate,
  normalizeConsentEntryToCandidate,
  mergeCandidates,
} from "./candidates";
import {
  sortCandidatesByScore,
  applyScoreToCandidate,
} from "./connect-ranking";
import { isDiscoverable, hasConnectionSource } from "./connect-visibility";
import type {
  ConnectCandidate,
  ConnectSection,
  ConnectSectionKey,
  ConnectContactState,
  ConnectDiscoveryOptions,
  ConnectDiscoveryResult,
} from "./types";

// ─── Section Builder ──────────────────────────────────────────────────────────

function buildSections(
  candidates: ConnectCandidate[],
  view: ConnectDiscoveryOptions["view"],
): ConnectSection[] {
  const sectionDefs: Array<{ key: ConnectSectionKey; label: string; filter: (c: ConnectCandidate) => boolean }> = [
    {
      key: "contacts",
      label: "From your contacts",
      filter: (c) => c.sourceTypes.includes("contact_match"),
    },
    {
      key: "active_connections",
      label: "Connected",
      filter: (c) =>
        c.connectionStatus === "connected" &&
        !c.sourceTypes.includes("contact_match"),
    },
    {
      key: "pending_connections",
      label: "Pending",
      filter: (c) =>
        (c.connectionStatus === "pending" || c.connectionStatus === "previous") &&
        !c.sourceTypes.includes("contact_match"),
    },
    {
      key: "advisors",
      label: "Advisors",
      filter: (c) =>
        c.kind === "ria" &&
        !c.sourceTypes.includes("contact_match") &&
        c.connectionStatus === "available",
    },
    {
      key: "investors",
      label: "Investors",
      filter: (c) =>
        (c.kind === "investor" || c.kind === "public_profile") &&
        !c.sourceTypes.includes("contact_match") &&
        c.connectionStatus === "available",
    },
    {
      key: "recommended",
      label: "Recommended",
      filter: (c) =>
        c.connectionStatus === "available" &&
        c.isDiscoverable &&
        !c.sourceTypes.includes("contact_match"),
    },
  ];

  const viewFilterMap: Record<ConnectDiscoveryOptions["view"], ConnectSectionKey[] | "all"> = {
    all: "all",
    contacts: ["contacts"],
    advisors: ["advisors"],
    investors: ["investors"],
    connections: ["active_connections", "pending_connections"],
  };

  const allowedSections = viewFilterMap[view];

  return sectionDefs
    .filter((def) => allowedSections === "all" || allowedSections.includes(def.key))
    .map((def) => {
      const filtered = candidates.filter(def.filter);
      return {
        key: def.key,
        label: def.label,
        candidates: filtered,
        isEmpty: filtered.length === 0,
      };
    });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useConnectDiscovery(
  user: { uid: string; getIdToken(): Promise<string> } | null | undefined,
  options: ConnectDiscoveryOptions,
): ConnectDiscoveryResult {
  const router = useRouter();
  const { query, activePersona, view, limit = 32 } = options;

  // ── Raw data state ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);

  const [rawRias, setRawRias] = useState<unknown[]>([]);
  const [rawInvestors, setRawInvestors] = useState<unknown[]>([]);
  const [rawContactMatches, setRawContactMatches] = useState<unknown[]>([]);
  const [rawActiveConnections, setRawActiveConnections] = useState<ConsentCenterEntry[]>([]);
  const [rawPendingConnections, setRawPendingConnections] = useState<ConsentCenterEntry[]>([]);
  const [rawPreviousConnections, setRawPreviousConnections] = useState<ConsentCenterEntry[]>([]);
  const [rawRiaRelationships, setRawRiaRelationships] = useState<RiaClientAccess[]>([]);
  const [rawInvestorActions, setRawInvestorActions] = useState<MarketplaceInvestorActionRecord[]>([]);

  // ── Local action state (optimistic) ─────────────────────────────────────────
  const [shortlistedIds, setShortlistedIds] = useState<string[]>([]);
  const [passedIds, setPassedIds] = useState<string[]>([]);

  // ── Contact state ────────────────────────────────────────────────────────────
  const [contactState, setContactState] = useState<ConnectContactState>({
    available: true,
    loading: false,
    hasScanned: false,
  });

  // ── Refs ────────────────────────────────────────────────────────────────────
  const actionLoadingRef = useRef<string | null>(null);

  // ── Load persisted local state ───────────────────────────────────────────────
  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    const prefix = `marketplace:ria:${user.uid}`;
    const readIds = (key: string) => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed.map((v) => String(v || "").trim()).filter(Boolean) : [];
      } catch { return []; }
    };
    setPassedIds(readIds(`${prefix}:passed-investors`));
    setShortlistedIds(readIds(`${prefix}:shortlisted-investors`));
  }, [user]);

  // ── Main load effect ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const isRefresh = nonce > 0;

    async function load() {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const idToken = await user!.getIdToken();
        const payload = await loadConnectPayload({
          idToken,
          userId: user!.uid,
          persona: activePersona,
          query,
          limit,
        });

        if (!cancelled) {
          setRawRias(payload.rias);
          setRawInvestors(payload.investors);
          setRawActiveConnections(payload.activeConnections as ConsentCenterEntry[]);
          setRawPendingConnections(payload.pendingConnections as ConsentCenterEntry[]);
          setRawPreviousConnections(payload.previousConnections as ConsentCenterEntry[]);
          setRawRiaRelationships(payload.riaRelationships as RiaClientAccess[]);
          setRawInvestorActions(payload.investorActions as MarketplaceInvestorActionRecord[]);
          setIamUnavailable(payload.iamUnavailable);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load Connect data.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [user, activePersona, query, limit, nonce]);

  // ── Normalize & merge candidates ──────────────────────────────────────────────
  const candidates = useMemo<ConnectCandidate[]>(() => {
    const all: ConnectCandidate[] = [];

    // Normalize RIAs
    for (const ria of rawRias as Parameters<typeof normalizeRiaToCandidate>[0][]) {
      const c = normalizeRiaToCandidate(ria, {
        consentEntries: rawActiveConnections,
        query,
        currentPersona: activePersona,
      });
      all.push(c);
    }

    // Normalize investors
    for (const investor of rawInvestors as MarketplaceInvestor[]) {
      const c = normalizeInvestorToCandidate(investor, {
        riaRelationships: rawRiaRelationships,
        investorActions: rawInvestorActions,
        query,
        currentPersona: activePersona,
        shortlistedIds,
        passedIds,
      });
      all.push(c);
    }

    // Normalize connections
    for (const entry of rawActiveConnections) {
      const c = normalizeConsentEntryToCandidate(entry, { surface: "active", query });
      if (c) all.push(c);
    }
    for (const entry of rawPendingConnections) {
      const c = normalizeConsentEntryToCandidate(entry, { surface: "pending", query });
      if (c) all.push(c);
    }
    for (const entry of rawPreviousConnections) {
      const c = normalizeConsentEntryToCandidate(entry, { surface: "previous", query });
      if (c) all.push(c);
    }

    // Normalize contact matches
    for (const match of rawContactMatches as Parameters<typeof normalizeContactMatchToCandidate>[0][]) {
      const c = normalizeContactMatchToCandidate(match, { existingCandidates: all, query });
      if (c) all.push(c);
    }

    // Merge duplicates
    const merged = mergeCandidates(all);

    // Re-score with current query
    const scored = merged.map((c) => applyScoreToCandidate(c, query));

    // Filter: discovery section only shows discoverable; connections section shows all
    const filtered = scored.filter((c) => {
      if (hasConnectionSource(c.sourceTypes)) return true; // always show connections
      if (!isDiscoverable(c)) return false;
      if (c.connectionStatus === "passed") return false;
      return true;
    });

    return sortCandidatesByScore(filtered);
  }, [
    rawRias, rawInvestors, rawContactMatches, rawActiveConnections,
    rawPendingConnections, rawPreviousConnections, rawRiaRelationships,
    rawInvestorActions, query, activePersona, shortlistedIds, passedIds,
  ]);

  const sections = useMemo(
    () => buildSections(candidates, view),
    [candidates, view],
  );

  // ── Actions ──────────────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  const matchContacts = useCallback(async () => {
    if (!user) {
      toast.error("Sign in required", { description: "Connect needs your account to match contacts." });
      return;
    }
    setContactState((s) => ({ ...s, loading: true, error: null }));
    try {
      const idToken = await user.getIdToken();
      const result = await loadContactMatches(idToken);
      if (result.error) throw new Error(result.error);
      setRawContactMatches(result.matches);
      setContactState((s) => ({
        ...s,
        loading: false,
        hasScanned: true,
        summary: result.matches.length > 0
          ? `${result.matches.length} match${result.matches.length === 1 ? "" : "es"} from ${result.totalContacts} contacts.`
          : "No phone numbers found in contacts.",
      }));
      if (result.matches.length === 0) {
        toast.info("No Hushh contacts found", { description: "Search is still available across public profiles." });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not match contacts.";
      setContactState((s) => ({ ...s, loading: false, error: msg }));
      toast.error(msg);
    }
  }, [user]);

  const recordAction = useCallback(
    async (
      candidate: ConnectCandidate,
      action: "view_more" | "pass" | "shortlist" | "connect_request",
    ) => {
      if (!user || candidate.isTestProfile) return;
      const investor = candidate._rawInvestorProfile as MarketplaceInvestor | undefined;
      if (!investor) return;
      const target = marketplaceInvestorActionTarget(investor);
      if (target.source_type === "public_sec" && !target.public_profile_id) return;
      if (target.source_type === "hushh_user" && !target.target_user_id) return;
      try {
        const idToken = await user.getIdToken();
        await RiaService.recordInvestorAction(idToken, {
          action,
          ...target,
          metadata: { surface: "connect", persona: activePersona },
        });

        const investorId = marketplaceInvestorCardId(investor);
        if (action === "pass") {
          setPassedIds((ids) => ids.includes(investorId) ? ids : [...ids, investorId]);
          if (typeof window !== "undefined") {
            const key = `marketplace:ria:${user.uid}:passed-investors`;
            try {
              const cur = JSON.parse(window.localStorage.getItem(key) || "[]");
              const existing = Array.isArray(cur) ? cur.map((v: unknown) => String(v || "").trim()).filter(Boolean) : [];
              if (!existing.includes(investorId)) window.localStorage.setItem(key, JSON.stringify([...existing, investorId]));
            } catch { /* ignore */ }
          }
        }
        if (action === "shortlist") {
          setShortlistedIds((ids) => ids.includes(investorId) ? ids : [...ids, investorId]);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed.");
      }
    },
    [user, activePersona],
  );

  const connect = useCallback(
    async (candidate: ConnectCandidate) => {
      if (!user) return;
      const { _rawRiaProfile, _rawInvestorProfile, kind } = candidate;

      try {
        actionLoadingRef.current = candidate.candidateId;
        const idToken = await user.getIdToken();

        if (kind === "ria" && _rawRiaProfile) {
          const ria = _rawRiaProfile as { user_id: string };
          await ConsentCenterService.createRequest({
            idToken,
            userId: user.uid,
            payload: {
              subject_user_id: ria.user_id,
              requester_actor_type: "investor",
              subject_actor_type: "ria",
              scope_template_id: "investor_advisor_disclosure_v1",
              duration_mode: "preset",
              duration_hours: 168,
            },
          });
          toast.success("Connection request sent", { description: "The advisor can review it in their pending connections." });
          router.push(buildMarketplaceConnectionsRoute({ tab: "pending" }));
          return;
        }

        if ((kind === "investor" || kind === "public_profile") && _rawInvestorProfile) {
          const investor = _rawInvestorProfile as MarketplaceInvestor;
          const investorUserId = marketplaceInvestorUserId(investor);
          if (!isMarketplaceInvestorConnectable(investor) || !investorUserId) {
            toast.info("Public investor profile", { description: "This profile is discovery-only." });
            return;
          }
          await ConsentCenterService.createRequest({
            idToken,
            userId: user.uid,
            payload: {
              subject_user_id: investorUserId,
              requester_actor_type: "ria",
              subject_actor_type: "investor",
              scope_template_id: "ria_financial_summary_v1",
              duration_mode: "preset",
              duration_hours: 168,
            },
          });
          await recordAction(candidate, "connect_request");
          const investorId = marketplaceInvestorCardId(investor);
          setPassedIds((ids) => ids.includes(investorId) ? ids : [...ids, investorId]);
          toast.success("Connection request sent", { description: "The investor can review it in their pending connections." });
          router.push(buildMarketplaceConnectionsRoute({ tab: "pending" }));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send connection request.");
      } finally {
        actionLoadingRef.current = null;
      }
    },
    [user, router, recordAction],
  );

  const openProfile = useCallback(
    (candidate: ConnectCandidate) => {
      if (candidate.isTestProfile) {
        const userId = candidate.userId;
        if (userId) {
          router.push(buildRiaClientWorkspaceRoute(userId, { tab: "overview", testProfile: true }));
        }
        return;
      }
      // Profile opening is handled by the page (opens detail sheet)
      // This action is a no-op here — page consumes the candidate's profileHref
    },
    [router],
  );

  return {
    candidates,
    sections,
    loading,
    refreshing,
    error,
    iamUnavailable,
    contactState,
    actions: {
      refresh,
      matchContacts,
      recordAction,
      connect,
      openProfile,
    },
  };
}
