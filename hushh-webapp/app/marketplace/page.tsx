"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Building2,
  Compass,
  List,
  MapPin,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsDetailPanel } from "@/components/profile/settings-ui";
import {
  buildKaiTestMarketplaceInvestor,
  canShowKaiTestProfile,
  getKaiTestUserId,
  isKaiTestProfileUser,
} from "@/components/ria/ria-client-test-profile";
import { RiaSurface } from "@/components/ria/ria-page-shell";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { resolveAppEnvironment } from "@/lib/app-env";
import { Button } from "@/lib/morphy-ux/button";
import {
  isMarketplaceInvestorConnectable,
  isMarketplaceInvestorShortlistable,
  isPublicSecMarketplaceInvestor,
  marketplaceInvestorActionTarget,
  marketplaceInvestorCardId,
  marketplaceInvestorCurationLabel,
  marketplaceInvestorSourceLabel,
  marketplaceInvestorUserId,
} from "@/lib/marketplace/investor-discovery";
import { usePersonaState } from "@/lib/persona/persona-context";
import { buildMarketplaceConnectionsRoute, buildRiaClientWorkspaceRoute } from "@/lib/navigation/routes";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import { buildMarketplaceContactLookups } from "@/lib/marketplace/contact-matching";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type MarketplaceContactMatch,
  type MarketplaceInvestor,
  type MarketplaceInvestorDeckResponse,
  type MarketplaceRia,
  type RiaClientAccess,
} from "@/lib/services/ria-service";
import { cn } from "@/lib/utils";

type DiscoveryView = "swipe" | "list";
type SelectedProfile =
  | { kind: "ria"; id: string }
  | { kind: "investor"; id: string };

type DiscoveryCard = {
  id: string;
  kind: "ria" | "investor";
  title: string;
  headline: string;
  summary: string;
  metaLine: string;
  canConnect: boolean;
  isTestProfile?: boolean;
  verificationStatus?: string | null;
  profile: MarketplaceRia | MarketplaceInvestor;
};

function connectionBadgeLabel(status?: string | null) {
  switch (String(status).toLowerCase()) {
    case "active":
    case "approved":
      return "Connected";
    case "request_pending":
    case "pending":
      return "Pending";
    case "revoked":
    case "cancelled":
    case "denied":
      return "Not connected";
    default:
      return "Available";
  }
}

function isConnectableAdvisor(status?: string | null) {
  return ["active", "verified", "finra_verified"].includes(
    String(status || "").toLowerCase()
  );
}

function ProfileAvatar({
  kind,
  label,
  className,
}: {
  kind: "ria" | "investor";
  label: string;
  className?: string;
}) {
  const Icon = kind === "ria" ? Building2 : UserRound;
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");

  return (
    <div
      className={cn(
        "flex h-14 w-14 items-center justify-center rounded-[20px] border shadow-[0_20px_50px_-34px_rgba(15,23,42,0.28)]",
        kind === "ria"
          ? "border-sky-500/15 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.18),transparent_58%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.92))]"
          : "border-emerald-500/15 bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.16),transparent_58%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.92))]",
        className
      )}
    >
      <div className="flex flex-col items-center justify-center gap-1">
        <Icon className={cn("h-4 w-4", kind === "ria" ? "text-sky-700" : "text-emerald-700")} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground/72">
          {initials || (kind === "ria" ? "RIA" : "INV")}
        </span>
      </div>
    </div>
  );
}

function toSelectedProfile(item: DiscoveryCard): SelectedProfile {
  return item.kind === "ria"
    ? { kind: "ria", id: (item.profile as MarketplaceRia).id }
    : { kind: "investor", id: marketplaceInvestorCardId(item.profile as MarketplaceInvestor) };
}

function discoveryCardUserId(item: DiscoveryCard): string | null {
  if (item.kind === "ria") return (item.profile as MarketplaceRia).user_id;
  return marketplaceInvestorUserId(item.profile as MarketplaceInvestor);
}

function formatEvidenceAddress(address?: Record<string, unknown> | null): string | null {
  if (!address) return null;
  const parts = [
    address.street1,
    address.street2,
    address.city,
    address.state,
    address.zip,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatEvidenceForms(forms?: Array<{ form?: string | null; last_filed_at?: string | null }>): string {
  if (!Array.isArray(forms) || forms.length === 0) return "Official SEC filing evidence";
  return forms
    .map((form) => {
      const label = String(form.form || "SEC filing").trim();
      const date = String(form.last_filed_at || "").trim();
      return date ? `${label} filed ${date}` : label;
    })
    .join(" · ");
}

export default function MarketplacePage() {
  const router = useRouter();
  const { user } = useAuth();
  const { personaState } = usePersonaState();
  const environment = resolveAppEnvironment();
  const allowTestProfiles = environment !== "production";
  const allowKaiTestInvestor = canShowKaiTestProfile();
  const kaiTestUserId = getKaiTestUserId();
  const currentPersona =
    personaState?.active_persona || personaState?.last_active_persona || "investor";
  const directoryKind = currentPersona === "ria" ? "investors" : "rias";
  const searchPlaceholder = "Search people by name, advisor, or investor";

  const [view, setView] = useState<DiscoveryView>("list");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hasLoadedDirectory, setHasLoadedDirectory] = useState(false);
  const [actionLoadingUserId, setActionLoadingUserId] = useState<string | null>(null);
  const [rias, setRias] = useState<MarketplaceRia[]>([]);
  const [investors, setInvestors] = useState<MarketplaceInvestor[]>([]);
  const [investorDeckMeta, setInvestorDeckMeta] =
    useState<MarketplaceInvestorDeckResponse | null>(null);
  const [relationships, setRelationships] = useState<RiaClientAccess[]>([]);
  const [advisorConnections, setAdvisorConnections] = useState<ConsentCenterEntry[]>([]);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<SelectedProfile | null>(null);
  const [selectedRiaProfile, setSelectedRiaProfile] = useState<MarketplaceRia | null>(null);
  const [selectedRiaLoading, setSelectedRiaLoading] = useState(false);
  const [selectedRiaError, setSelectedRiaError] = useState<string | null>(null);
  const [passedRiaIds, setPassedRiaIds] = useState<string[]>([]);
  const [passedInvestorIds, setPassedInvestorIds] = useState<string[]>([]);
  const [shortlistedInvestorIds, setShortlistedInvestorIds] = useState<string[]>([]);
  const [contactMatches, setContactMatches] = useState<MarketplaceContactMatch[]>([]);
  const [contactMatchLoading, setContactMatchLoading] = useState(false);
  const [contactMatchError, setContactMatchError] = useState<string | null>(null);
  const [contactScanSummary, setContactScanSummary] = useState<string | null>(null);
  const [deckRefreshNonce, setDeckRefreshNonce] = useState(0);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const injectedTestCards = useMemo<DiscoveryCard[]>(() => {
    if (!allowTestProfiles || directoryKind !== "rias") return [];
    return [
      {
        id: "demo-ria-hudson",
        kind: "ria",
        title: "Hudson Advisory Group",
        headline: "New York wealth planning for founders, executives, and families.",
        summary:
          "Demo advisor profile for UI review. Use it to evaluate the Connect experience and compare card density, not to start a live connection.",
        metaLine: "New York · Multi-family wealth planning",
        canConnect: false,
        isTestProfile: true,
        profile: {
          id: "demo-ria-hudson",
          user_id: "demo_ria_hudson",
          display_name: "Hudson Advisory Group",
          headline: "New York wealth planning for founders, executives, and families.",
          strategy_summary:
            "Tax-aware planning, concentrated equity risk management, and long-term family allocation design.",
          verification_status: "active",
          firms: [
            {
              firm_id: "demo-ria-hudson-firm",
              legal_name: "Hudson Advisory Group",
              role_title: "Principal Advisor",
              is_primary: true,
            },
          ],
          bio: "Demo profile used to test the Connect experience in non-production environments.",
          strategy:
            "Long-term, tax-aware portfolio planning with executive compensation and liquidity event support.",
          disclosures_url: null,
          is_test_profile: true,
        },
      },
      {
        id: "demo-ria-pacific",
        kind: "ria",
        title: "Pacific Crest Private Wealth",
        headline: "West Coast advisory team focused on liquidity events and durable income plans.",
        summary:
          "Demo advisor profile for non-production browsing. Helpful for testing long names, richer summaries, and sheet presentation.",
        metaLine: "San Francisco · Executive planning",
        canConnect: false,
        isTestProfile: true,
        profile: {
          id: "demo-ria-pacific",
          user_id: "demo_ria_pacific",
          display_name: "Pacific Crest Private Wealth",
          headline: "West Coast advisory team focused on liquidity events and durable income plans.",
          strategy_summary:
            "Concentrated stock transitions, retirement income planning, and downside-aware portfolio structuring.",
          verification_status: "active",
          firms: [
            {
              firm_id: "demo-ria-pacific-firm",
              legal_name: "Pacific Crest Private Wealth",
              role_title: "Lead Advisor",
              is_primary: true,
            },
          ],
          bio: "Demo profile used to test the Connect experience in non-production environments.",
          strategy:
            "High-touch executive planning with disciplined re-risking after liquidity events.",
          disclosures_url: null,
          is_test_profile: true,
        },
      },
    ];
  }, [allowTestProfiles, directoryKind]);

  const injectedKaiTestInvestor = useMemo<DiscoveryCard | null>(() => {
    if (!allowKaiTestInvestor || !kaiTestUserId || directoryKind !== "investors") return null;
    if (investors.some((investor) => marketplaceInvestorUserId(investor) === kaiTestUserId)) return null;
    const investor = buildKaiTestMarketplaceInvestor(kaiTestUserId);
    return {
      id: marketplaceInvestorCardId(investor),
      kind: "investor",
      title: investor.display_name,
      headline: investor.headline || "Open to advisor connections",
      summary:
        investor.strategy_summary ||
        "Preloaded PKM-aligned explorer example for advisor-side Kai and data-view validation.",
      metaLine: investor.location_hint || "Public discovery profile",
      canConnect: true,
      isTestProfile: true,
      profile: investor,
    };
  }, [allowKaiTestInvestor, directoryKind, investors, kaiTestUserId]);

  useEffect(() => {
    if (!user || typeof window === "undefined") {
      setShortlistedInvestorIds([]);
      return;
    }

    const prefix = `marketplace:ria:${user.uid}`;
    const readIds = (key: string) => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
        return Array.isArray(parsed)
          ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
      } catch {
        return [];
      }
    };

    setPassedInvestorIds(readIds(`${prefix}:passed-investors`));
    setShortlistedInvestorIds(readIds(`${prefix}:shortlisted-investors`));
  }, [user]);

  const persistInvestorAction = useCallback(
    async (
      investor: MarketplaceInvestor,
      action: "view_more" | "pass" | "shortlist" | "connect_request",
      metadata?: Record<string, unknown>,
    ) => {
      if (!user || investor.is_test_profile) return null;
      const target = marketplaceInvestorActionTarget(investor);
      if (target.source_type === "public_sec" && !target.public_profile_id) return null;
      if (target.source_type === "hushh_user" && !target.target_user_id) return null;
      const idToken = await user.getIdToken();
      return RiaService.recordInvestorAction(idToken, {
        action,
        ...target,
        metadata: {
          surface: "marketplace",
          persona: currentPersona,
          ...metadata,
        },
      });
    },
    [currentPersona, user],
  );

  useEffect(() => {
    if (!user || directoryKind !== "investors") return;
    let cancelled = false;
    const activeUser = user;

    async function loadPersistedInvestorActions() {
      try {
        const idToken = await activeUser.getIdToken();
        const actions = await RiaService.listInvestorActions(idToken, { limit: 100 });
        if (cancelled) return;

        const passed = actions
          .filter((item) =>
            item.status === "passed" ||
            item.status === "shortlisted" ||
            item.status === "connect_requested"
          )
          .map((item) => String(item.target_key || "").trim())
          .filter(Boolean);
        const shortlisted = actions
          .filter((item) => item.status === "shortlisted")
          .map((item) => String(item.target_key || "").trim())
          .filter(Boolean);

        setPassedInvestorIds((current) => Array.from(new Set([...current, ...passed])));
        setShortlistedInvestorIds((current) =>
          Array.from(new Set([...current, ...shortlisted])),
        );
      } catch (error) {
        console.warn("[Marketplace] Could not load persisted investor deck actions", error);
      }
    }

    void loadPersistedInvestorActions();
    return () => {
      cancelled = true;
    };
  }, [directoryKind, user]);

  const rememberInvestorDeckDecision = useCallback(
    (kind: "passed" | "shortlisted", investorId: string) => {
      if (!user || typeof window === "undefined") return;
      const normalizedId = investorId.trim();
      if (!normalizedId) return;
      const key = `marketplace:ria:${user.uid}:${
        kind === "passed" ? "passed-investors" : "shortlisted-investors"
      }`;
      try {
        const current = JSON.parse(window.localStorage.getItem(key) || "[]");
        const ids = Array.isArray(current)
          ? current.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        if (!ids.includes(normalizedId)) {
          window.localStorage.setItem(key, JSON.stringify([...ids, normalizedId]));
        }
      } catch {
        window.localStorage.setItem(key, JSON.stringify([normalizedId]));
      }
    },
    [user]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadRelationshipContext() {
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const nextClients = await RiaService.listClients(idToken, {
          userId: user.uid,
        }).catch(() => ({
          items: [] as RiaClientAccess[],
          total: 0,
          page: 1,
          limit: 50,
          has_more: false,
        }));
        if (!cancelled) {
          setRelationships(nextClients.items);
        }
      } catch {
        if (!cancelled) {
          setRelationships([]);
        }
      }
    }

    void loadRelationshipContext();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    async function loadInvestorConnections() {
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const [pending, active, previous] = await Promise.all([
          ConsentCenterService.listEntries({
            idToken,
            userId: user.uid,
            actor: "investor",
            mode: "connections",
            surface: "pending",
            top: 50,
          }),
          ConsentCenterService.listEntries({
            idToken,
            userId: user.uid,
            actor: "investor",
            mode: "connections",
            surface: "active",
            top: 50,
          }),
          ConsentCenterService.listEntries({
            idToken,
            userId: user.uid,
            actor: "investor",
            mode: "connections",
            surface: "previous",
            top: 50,
          }),
        ]);
        if (!cancelled) {
          setAdvisorConnections([
            ...(active.items || []),
            ...(pending.items || []),
            ...(previous.items || []),
          ]);
        }
      } catch {
        if (!cancelled) {
          setAdvisorConnections([]);
        }
      }
    }

    void loadInvestorConnections();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    async function loadMarketplace() {
      setLoading(true);
      setHasLoadedDirectory(false);
      setIamUnavailable(false);
      try {
        const investorLoader = async (): Promise<MarketplaceInvestorDeckResponse> => {
          if (user && currentPersona === "ria") {
            const idToken = await user.getIdToken();
            return RiaService.searchInvestorDeck(idToken, {
              query,
              limit: 32,
              persona: "ria",
              deck: "qualified",
            });
          }
          const items = await RiaService.searchInvestors({
            query,
            limit: 32,
            persona: "ria",
            deck: "qualified",
          });
          return {
            items,
            remaining_count: items.length,
            handled_count: 0,
            deck_complete: items.length === 0,
          };
        };
        const [riaResult, investorResult] = await Promise.allSettled([
          RiaService.searchRias({
            query,
            limit: 32,
            verification_status: "active",
          }),
          investorLoader(),
        ]);
        if (!cancelled) {
          if (riaResult.status === "fulfilled") {
            setRias(riaResult.value);
          } else {
            setRias([]);
          }
          if (investorResult.status === "fulfilled") {
            setInvestors(investorResult.value.items);
            setInvestorDeckMeta(investorResult.value);
          } else {
            setInvestors([]);
            setInvestorDeckMeta(null);
          }
          const failures = [riaResult, investorResult].filter(
            (result) => result.status === "rejected"
          ) as PromiseRejectedResult[];
          setIamUnavailable(failures.some((result) => isIAMSchemaNotReadyError(result.reason)));
        }
      } catch (error) {
        if (!cancelled) {
          setIamUnavailable(isIAMSchemaNotReadyError(error));
          setRias([]);
          setInvestors([]);
          setInvestorDeckMeta(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHasLoadedDirectory(true);
        }
      }
    }

    void loadMarketplace();
    return () => {
      cancelled = true;
    };
  }, [currentPersona, deckRefreshNonce, query, user]);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedRiaProfile() {
      if (!selectedProfile || selectedProfile.kind !== "ria") {
        setSelectedRiaProfile(null);
        setSelectedRiaError(null);
        setSelectedRiaLoading(false);
        return;
      }

      const injected = injectedTestCards.find(
        (item) => item.kind === "ria" && item.id === selectedProfile.id
      );
      if (injected) {
        setSelectedRiaProfile(injected.profile as MarketplaceRia);
        setSelectedRiaError(null);
        setSelectedRiaLoading(false);
        return;
      }

      try {
        setSelectedRiaLoading(true);
        setSelectedRiaError(null);
        const next = await RiaService.getRiaPublicProfile(selectedProfile.id);
        if (!cancelled) {
          setSelectedRiaProfile(next);
        }
      } catch (error) {
        if (!cancelled) {
          setSelectedRiaProfile(null);
          setSelectedRiaError(
            error instanceof Error ? error.message : "Could not load advisor profile."
          );
        }
      } finally {
        if (!cancelled) {
          setSelectedRiaLoading(false);
        }
      }
    }

    void loadSelectedRiaProfile();
    return () => {
      cancelled = true;
    };
  }, [injectedTestCards, selectedProfile]);

  const relationshipMap = useMemo(() => {
    const map = new Map<string, RiaClientAccess>();
    for (const item of relationships) {
      if (item.investor_user_id) {
        map.set(item.investor_user_id, item);
      }
    }
    return map;
  }, [relationships]);

  const advisorConnectionMap = useMemo(() => {
    const map = new Map<string, ConsentCenterEntry>();
    for (const item of advisorConnections) {
      if (item.counterpart_id && !map.has(item.counterpart_id)) {
        map.set(item.counterpart_id, item);
      }
    }
    return map;
  }, [advisorConnections]);

  const investorMap = useMemo(() => {
    const contactInvestors = contactMatches
      .filter((item) => item.kind === "investor")
      .map((item) => item.profile as MarketplaceInvestor);
    return new Map(
      [...investors, ...contactInvestors].map((item) => [marketplaceInvestorCardId(item), item])
    );
  }, [contactMatches, investors]);

  const advisorCards = useMemo<DiscoveryCard[]>(() => {
    return rias.map((ria) => {
      const connection = advisorConnectionMap.get(ria.user_id);
      const connectionState = connectionBadgeLabel(
        connection?.relationship_status || connection?.status
      );
      const canConnect =
        currentPersona === "investor" &&
        isConnectableAdvisor(ria.verification_status) &&
        connectionState !== "Connected" &&
        connectionState !== "Pending";
      return {
        id: ria.id,
        kind: "ria" as const,
        title: ria.display_name,
        headline: ria.headline || "Advisor profile available",
        summary:
          ria.strategy_summary ||
          "Explore public fit cues first, then open the profile sheet before you connect.",
        metaLine:
          Array.isArray(ria.firms) && ria.firms.length > 0
            ? ria.firms.map((firm) => firm.legal_name).join(" • ")
            : "Public advisory profile",
        canConnect,
        isTestProfile: false,
        verificationStatus: ria.verification_status,
        profile: ria,
      };
    });
  }, [advisorConnectionMap, currentPersona, rias]);

  const investorCards = useMemo<DiscoveryCard[]>(() => {
    return investors.map((investor) => {
      const investorId = marketplaceInvestorCardId(investor);
      const userId = marketplaceInvestorUserId(investor);
      const sourceLabel = marketplaceInvestorSourceLabel(investor);
      const curationLabel = marketplaceInvestorCurationLabel(investor);
      const relationship = userId ? relationshipMap.get(userId) : null;
      const connectionState = connectionBadgeLabel(
        relationship?.relationship_status || relationship?.status
      );
      const canConnect =
        currentPersona === "ria" &&
        isMarketplaceInvestorConnectable(investor) &&
        connectionState !== "Connected" &&
        connectionState !== "Pending";
      return {
        id: investorId,
        kind: "investor" as const,
        title: investor.display_name,
        headline: investor.headline || "Open to advisor connections",
        summary:
          investor.strategy_summary ||
          investor.location_hint ||
          "Qualified discovery lead backed by public evidence.",
        metaLine: [curationLabel, sourceLabel, investor.location_hint]
          .filter(Boolean)
          .join(" · ") || "Qualified discovery profile",
        canConnect,
        isTestProfile: Boolean(investor.is_test_profile || (userId && isKaiTestProfileUser(userId))),
        profile: investor,
      };
    });
  }, [currentPersona, investors, relationshipMap]);

  const directoryCards = useMemo<DiscoveryCard[]>(() => {
    const base = directoryKind === "rias" ? advisorCards : investorCards;
    if (directoryKind === "rias") {
      return [...base, ...injectedTestCards];
    }
    return injectedKaiTestInvestor ? [injectedKaiTestInvestor, ...base] : base;
  }, [advisorCards, directoryKind, injectedKaiTestInvestor, injectedTestCards, investorCards]);
  const searchCards = useMemo<DiscoveryCard[]>(() => {
    return [
      ...advisorCards,
      ...injectedTestCards,
      ...(injectedKaiTestInvestor ? [injectedKaiTestInvestor] : []),
      ...investorCards,
    ];
  }, [advisorCards, injectedKaiTestInvestor, injectedTestCards, investorCards]);
  const activeCards = view === "list" ? searchCards : directoryCards;
  const passedIds = directoryKind === "rias" ? passedRiaIds : passedInvestorIds;
  const shuffledSwipeCards = useMemo(() => {
    const items = directoryCards.filter((item) => !passedIds.includes(item.id));
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      const currentItem = copy[index]!;
      const swapItem = copy[swapIndex]!;
      copy[index] = swapItem;
      copy[swapIndex] = currentItem;
    }
    return copy;
  }, [directoryCards, passedIds]);
  const swipeCards = shuffledSwipeCards;
  const swipeCard = swipeCards[0] || null;
  const investorDeckComplete =
    directoryKind === "investors" &&
    Boolean(investorDeckMeta?.deck_complete) &&
    swipeCards.length === 0;
  const investorSavedLeadCount = shortlistedInvestorIds.length;
  const selectedInvestor =
    selectedProfile?.kind === "investor"
      ? investorMap.get(selectedProfile.id) ||
        (injectedKaiTestInvestor?.id === selectedProfile.id
          ? (injectedKaiTestInvestor.profile as MarketplaceInvestor)
          : null)
      : null;
  const selectedInvestorUserId = selectedInvestor
    ? marketplaceInvestorUserId(selectedInvestor)
    : null;
  const selectedInvestorIsTest = Boolean(
    selectedInvestor?.is_test_profile ||
      (selectedInvestorUserId && isKaiTestProfileUser(selectedInvestorUserId))
  );
  const selectedInvestorSourceLabel = selectedInvestor
    ? marketplaceInvestorSourceLabel(selectedInvestor)
    : null;
  const selectedInvestorConnectable = selectedInvestor
    ? isMarketplaceInvestorConnectable(selectedInvestor)
    : false;
  const selectedInvestorShortlistable = selectedInvestor
    ? isMarketplaceInvestorShortlistable(selectedInvestor)
    : false;
  const selectedInvestorEvidence = selectedInvestor?.evidence || null;
  const selectedInvestorAddress = formatEvidenceAddress(
    selectedInvestorEvidence?.business_address
  );
  const selectedInvestorEvidenceLinks = Array.isArray(selectedInvestorEvidence?.source_urls)
    ? selectedInvestorEvidence.source_urls
        .filter((url): url is string => Boolean(url))
        .slice(0, 3)
    : [];
  const selectedInvestorFormsLabel = formatEvidenceForms(selectedInvestorEvidence?.forms);
  const selectedInvestorCurationLabel = selectedInvestor
    ? marketplaceInvestorCurationLabel(selectedInvestor)
    : null;
  const selectedInvestorIsShortlisted = selectedInvestor
    ? shortlistedInvestorIds.includes(marketplaceInvestorCardId(selectedInvestor))
    : false;
  const selectedInjectedRia =
    selectedProfile?.kind === "ria"
      ? ((injectedTestCards.find((item) => item.kind === "ria" && item.id === selectedProfile.id)
          ?.profile as MarketplaceRia | undefined) || null)
      : null;
  const selectedAdvisor =
    selectedProfile?.kind === "ria" ? selectedInjectedRia || selectedRiaProfile : null;
  const selectedAdvisorFirmNames = Array.isArray(selectedAdvisor?.firms)
    ? selectedAdvisor.firms
        .map((firm) => String(firm?.legal_name || "").trim())
        .filter(Boolean)
        .join(" · ")
    : "";
  const swipeRotation = Math.max(-14, Math.min(14, dragOffset.x / 18));
  const swipeOpacity = Math.max(0.72, 1 - Math.abs(dragOffset.x) / 520);
  const connectionsRoute = buildMarketplaceConnectionsRoute({ tab: "active" });

  const matchContacts = useCallback(async () => {
    if (!user) {
      toast.error("Sign in required", {
        description: "Connect needs your signed-in account before matching contacts.",
      });
      return;
    }
    try {
      setContactMatchLoading(true);
      setContactMatchError(null);
      const lookupResult = await buildMarketplaceContactLookups({ limit: 500 });
      if (lookupResult.lookups.length === 0) {
        setContactMatches([]);
        setContactScanSummary("No phone numbers found in contacts.");
        return;
      }
      const idToken = await user.getIdToken();
      const matches = await RiaService.matchMarketplaceContacts(idToken, {
        phone_lookups: lookupResult.lookups.map(({ hash, last4 }) => ({ hash, last4 })),
        limit: 50,
      });
      setContactMatches(matches);
      setContactScanSummary(
        `${matches.length} match${matches.length === 1 ? "" : "es"} from ${lookupResult.totalContacts} contacts.`
      );
      if (matches.length === 0) {
        toast.info("No Hushh contacts found", {
          description: "Search is still available across public profiles.",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not match contacts.";
      setContactMatchError(message);
      toast.error(message);
    } finally {
      setContactMatchLoading(false);
    }
  }, [user]);

  const openTestInvestorWorkspace = useCallback(
    (userId: string) => {
      router.push(buildRiaClientWorkspaceRoute(userId, { tab: "overview", testProfile: true }));
    },
    [router]
  );

  const createConnectionToInvestor = useCallback(async (investor: MarketplaceInvestor) => {
    if (!user) return;
    const investorUserId = marketplaceInvestorUserId(investor);
    if (!isMarketplaceInvestorConnectable(investor) || !investorUserId) {
      toast.info("Public investor profile", {
        description: "This profile is discovery-only until an invite or verified Hushh account exists.",
      });
      return;
    }
    try {
      setActionLoadingUserId(investorUserId);
      const idToken = await user.getIdToken();
      const request = await ConsentCenterService.createRequest({
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
      await persistInvestorAction(investor, "connect_request", {
        request_id:
          request && typeof request === "object" && "request_id" in request
            ? String(request.request_id || "")
            : null,
        gesture: "right_swipe_or_connect",
      });
      const investorId = marketplaceInvestorCardId(investor);
      setPassedInvestorIds((current) =>
        current.includes(investorId) ? current : [...current, investorId]
      );
      rememberInvestorDeckDecision("passed", investorId);
      toast.success("Connection request sent", {
        description: "The investor can review it in their pending connections.",
      });
      router.push(buildMarketplaceConnectionsRoute({ tab: "pending" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send connection request");
    } finally {
      setActionLoadingUserId(null);
    }
  }, [persistInvestorAction, rememberInvestorDeckDecision, router, user]);

  const createConnectionToAdvisor = useCallback(async (ria: MarketplaceRia) => {
    if (!user) return;
    try {
      setActionLoadingUserId(ria.user_id);
      const idToken = await user.getIdToken();
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
      toast.success("Connection request sent", {
        description: "The advisor can review it in their pending connections.",
      });
      router.push(buildMarketplaceConnectionsRoute({ tab: "pending" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send connection request");
    } finally {
      setActionLoadingUserId(null);
    }
  }, [router, user]);

  const shortlistInvestor = useCallback(async (investor: MarketplaceInvestor) => {
    const investorId = marketplaceInvestorCardId(investor);
    try {
      await persistInvestorAction(investor, "shortlist", { gesture: "right_swipe_or_save" });
      setShortlistedInvestorIds((current) =>
        current.includes(investorId) ? current : [...current, investorId]
      );
      setPassedInvestorIds((current) =>
        current.includes(investorId) ? current : [...current, investorId]
      );
      rememberInvestorDeckDecision("shortlisted", investorId);
      rememberInvestorDeckDecision("passed", investorId);
      toast.success("Investor lead saved", {
        description: "Saved to the database-backed RIA deck shortlist.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save investor lead");
    }
  }, [persistInvestorAction, rememberInvestorDeckDecision]);

  const openDiscoveryProfile = useCallback((card: DiscoveryCard) => {
    if (card.kind === "investor") {
      void persistInvestorAction(card.profile as MarketplaceInvestor, "view_more", {
        gesture: "view_more",
      }).catch((error) => {
        console.warn("[Marketplace] Could not persist investor view action", error);
      });
    }
    setSelectedProfile(toSelectedProfile(card));
  }, [persistInvestorAction]);

  const openContactMatch = useCallback((match: MarketplaceContactMatch) => {
    if (match.kind === "ria") {
      const profile = match.profile as MarketplaceRia;
      if (profile.id) {
        setSelectedProfile({ kind: "ria", id: profile.id });
      }
      return;
    }
    const profile = match.profile as MarketplaceInvestor;
    setSelectedProfile({ kind: "investor", id: marketplaceInvestorCardId(profile) });
  }, []);

  const performPrimaryCardAction = useCallback((card: DiscoveryCard) => {
    if (
      currentPersona === "ria" &&
      card.kind === "investor" &&
      card.isTestProfile
    ) {
      const userId = discoveryCardUserId(card);
      if (userId) openTestInvestorWorkspace(userId);
      return;
    }
    if (card.kind === "ria") {
      void createConnectionToAdvisor(card.profile as MarketplaceRia);
      return;
    }
    const investor = card.profile as MarketplaceInvestor;
    if (isMarketplaceInvestorShortlistable(investor)) {
      void shortlistInvestor(investor);
      return;
    }
    if (card.canConnect) {
      void createConnectionToInvestor(investor);
      return;
    }
    openDiscoveryProfile(card);
  }, [
    createConnectionToAdvisor,
    createConnectionToInvestor,
    currentPersona,
    openDiscoveryProfile,
    openTestInvestorWorkspace,
    shortlistInvestor,
  ]);

  const passCurrentCard = useCallback(() => {
    if (!swipeCard) return;
    if (directoryKind === "rias") {
      setPassedRiaIds((current) => (current.includes(swipeCard.id) ? current : [...current, swipeCard.id]));
      return;
    }
    setPassedInvestorIds((current) =>
      current.includes(swipeCard.id) ? current : [...current, swipeCard.id]
    );
    rememberInvestorDeckDecision("passed", swipeCard.id);
    if (swipeCard.kind === "investor") {
      void persistInvestorAction(swipeCard.profile as MarketplaceInvestor, "pass", {
        gesture: "left_swipe_or_pass",
      }).catch((error) => {
        console.warn("[Marketplace] Could not persist investor pass action", error);
      });
    }
  }, [directoryKind, persistInvestorAction, rememberInvestorDeckDecision, swipeCard]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!dragStartRef.current) return;
      setDragOffset({
        x: event.clientX - dragStartRef.current.x,
        y: Math.max(-24, Math.min(24, (event.clientY - dragStartRef.current.y) * 0.2)),
      });
    }

    function handlePointerUp() {
      if (!dragStartRef.current) return;
      const shouldPass = dragOffset.x < -110;
      const shouldAct = dragOffset.x > 110;
      dragStartRef.current = null;
      setDragOffset({ x: 0, y: 0 });
      if (shouldPass) {
        passCurrentCard();
        return;
      }
      if (shouldAct && swipeCard) {
        performPrimaryCardAction(swipeCard);
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragOffset.x, passCurrentCard, performPrimaryCardAction, swipeCard]);

  function resetSwipeDeck() {
    if (directoryKind === "rias") {
      setPassedRiaIds([]);
      return;
    }
    setDragOffset({ x: 0, y: 0 });
    setDeckRefreshNonce((current) => current + 1);
  }

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-36"
      nativeTest={{
        routeId: "/marketplace",
        marker: "native-route-marketplace",
        authState: user ? "authenticated" : "pending",
        dataState: loading
          ? "loading"
          : rias.length > 0 || investors.length > 0
            ? "loaded"
            : iamUnavailable
              ? "unavailable-valid"
              : "empty-valid",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Connect"
          title="Search people"
          description="Find investors, RIAs, and contacts already on Hushh."
          icon={Compass}
          accent="marketplace"
          actions={
            <Button
              variant="none"
              effect="fade"
              size="sm"
              className="rounded-full bg-card px-3 shadow-[var(--app-card-shadow-standard)]"
              onClick={() => router.push(connectionsRoute)}
            >
              Connections
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-4 pb-24 pt-0">
        <div className="sticky top-[calc(var(--top-shell-reserved-height)+6px)] z-[115] rounded-[28px] bg-background/90 p-1.5 shadow-[var(--app-card-shadow-standard)] backdrop-blur-[var(--blur-standard)]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95",
                  searchOpen && "bg-primary/10 text-primary"
                )}
                aria-label="Toggle search"
                onClick={() => setSearchOpen((current) => !current)}
              >
                <Search className="h-4 w-4" />
              </button>
              <Button
                variant="none"
                effect="fade"
                size="sm"
                className="h-10 rounded-full bg-card px-3"
                onClick={() => void matchContacts()}
                disabled={contactMatchLoading}
              >
                {contactMatchLoading ? "Matching..." : "Contacts"}
              </Button>
              <button
                type="button"
                className="grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95"
                aria-label={directoryKind === "investors" ? "Refresh deck" : "Restart deck"}
                onClick={resetSwipeDeck}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95",
                  view === "swipe" && "bg-primary/10 text-primary"
                )}
                aria-label="Swipe view"
                onClick={() => setView("swipe")}
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95",
                  view === "list" && "bg-primary/10 text-primary"
                )}
                aria-label="List view"
                onClick={() => setView("list")}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {searchOpen ? (
            <div className="mt-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  className="min-h-11 rounded-[22px] border-0 bg-card pl-10 text-sm"
                />
              </div>
              {contactScanSummary || contactMatchError ? (
                <p
                  className={cn(
                    "mt-2 line-clamp-1 px-1 text-xs",
                    contactMatchError ? "text-red-500" : "text-muted-foreground"
                  )}
                >
                  {contactMatchError || contactScanSummary}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {!iamUnavailable && contactMatches.length > 0 ? (
          <RiaSurface className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  Contacts
                </p>
                <h3 className="mt-1 line-clamp-1 text-[15px] font-semibold leading-snug tracking-normal text-foreground">
                  Already on Hushh
                </h3>
              </div>
              <Button
                variant="none"
                effect="fade"
                size="sm"
                className="shrink-0"
                onClick={() => setContactMatches([])}
              >
                Clear
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {contactMatches.map((match) => (
                <button
                  key={`${match.kind}-${match.user_id}`}
                  type="button"
                  className="flex min-w-0 items-center gap-3 rounded-2xl bg-background/60 p-3 text-left transition-colors hover:bg-background dark:bg-white/5"
                  onClick={() => openContactMatch(match)}
                >
                  <ProfileAvatar
                    kind={match.kind}
                    label={match.display_name}
                    className="h-11 w-11 rounded-2xl"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-1 text-sm font-medium text-foreground">
                      {match.display_name}
                    </span>
                    <span className="block line-clamp-1 text-xs text-muted-foreground">
                      {match.kind === "ria" ? "RIA" : "Investor"}
                      {match.phone_last4 ? ` · ${match.phone_last4}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </RiaSurface>
        ) : null}

      {iamUnavailable ? (
        <RiaSurface className="border-dashed border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm text-muted-foreground">
            Connect is waiting on IAM schema readiness in this environment.
          </p>
        </RiaSurface>
      ) : null}

      {!iamUnavailable && view === "swipe" ? (
        <div className={cn("pb-16", searchOpen && "pt-12")}>
          {!hasLoadedDirectory || loading ? (
            <div className="flex min-h-[420px] items-center justify-center px-6 py-14 text-center">
              <p className="text-sm text-muted-foreground">Loading discovery…</p>
            </div>
          ) : swipeCard ? (
            <div className="px-0 pb-2 pt-1 sm:px-1 sm:pt-2">
              <div className="relative mx-auto flex w-full max-w-[720px] items-center justify-center pt-1 sm:pt-2">
                <div className="absolute inset-x-4 top-2 h-[calc(100%-14px)] rounded-[var(--radius-lg)] bg-card/50 opacity-50 sm:inset-x-6 sm:top-3" />
                <div className="absolute inset-x-2 top-3 h-[calc(100%-10px)] rounded-[var(--radius-lg)] bg-card/70 opacity-70 sm:inset-x-3 sm:top-4" />
                <div
                  className="relative flex w-full touch-pan-y flex-col justify-between rounded-[var(--radius-lg)] border-0 bg-card p-5 shadow-[var(--app-card-shadow-feature)] transition-[transform,opacity] duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] sm:p-6"
                  style={{
                    transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0) rotate(${swipeRotation}deg)`,
                    opacity: swipeOpacity,
                    minHeight: "min(60dvh, 560px)",
                  }}
                  onPointerDown={(event) => {
                    dragStartRef.current = { x: event.clientX, y: event.clientY };
                  }}
                >
                  <div className="space-y-5">
                    <div className="flex items-center gap-4">
                      <ProfileAvatar kind={swipeCard.kind} label={swipeCard.title} className="h-20 w-20 shrink-0 rounded-[24px]" />
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[22px] font-semibold leading-tight tracking-normal text-foreground sm:text-[24px]">
                            {swipeCard.title}
                          </h3>
                          {swipeCard.isTestProfile ? (
                            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                              Test
                            </span>
                          ) : null}
                          {swipeCard.kind === "ria" && swipeCard.verificationStatus && !swipeCard.isTestProfile ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                              <ShieldCheck className="h-3 w-3" />
                              Verified
                            </span>
                          ) : null}
                        </div>
                        <p className="text-[14px] leading-[1.45] text-foreground/78">{swipeCard.headline}</p>
                      </div>
                    </div>

                    <div className="rounded-[var(--radius-md)] bg-background/50 p-4 dark:bg-white/5">
                      <p className="text-[14px] leading-[1.5] text-foreground/86">{swipeCard.summary}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
                        <span className="inline-flex items-center gap-2">
                          {swipeCard.kind === "ria" ? (
                            <Building2 className="h-4 w-4" />
                          ) : (
                            <MapPin className="h-4 w-4" />
                          )}
                          {swipeCard.metaLine}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      className="justify-center"
                      onClick={passCurrentCard}
                      aria-label="Pass card"
                    >
                      <X className="h-4 w-4 sm:mr-2" />
                      <span className="hidden sm:inline">Pass</span>
                    </Button>
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      className="justify-center"
                      onClick={() => openDiscoveryProfile(swipeCard)}
                      aria-label="View profile"
                    >
                      <span className="hidden sm:inline">View</span>
                      <ArrowUpRight className="h-4 w-4 sm:ml-2" />
                    </Button>
                    <Button
                      variant="blue-gradient"
                      effect="fill"
                      size="sm"
                      className="justify-center"
                      onClick={() => performPrimaryCardAction(swipeCard)}
                      disabled={
                        (Boolean(discoveryCardUserId(swipeCard)) &&
                          actionLoadingUserId === discoveryCardUserId(swipeCard)) ||
                        (Boolean(swipeCard.isTestProfile) && swipeCard.kind === "ria")
                      }
                    >
                      <span className="truncate">
                        {swipeCard.isTestProfile
                          ? swipeCard.kind === "investor" && currentPersona === "ria"
                            ? "Open workspace"
                            : "Demo"
                          : Boolean(discoveryCardUserId(swipeCard)) &&
                              actionLoadingUserId === discoveryCardUserId(swipeCard)
                            ? "Connecting..."
                            : currentPersona === "investor"
                              ? "Request advisory"
                              : swipeCard.canConnect
                                ? "Send request"
                                : swipeCard.kind === "investor" &&
                                    isMarketplaceInvestorShortlistable(
                                      swipeCard.profile as MarketplaceInvestor
                                    )
                                  ? "Save lead"
                                  : "View profile"}
                      </span>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
              <h3 className="text-[18px] font-semibold leading-tight tracking-normal text-foreground">
                {investorDeckComplete ? "Deck complete" : "That&apos;s everyone for now"}
              </h3>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                {investorDeckComplete
                  ? `You handled every eligible investor in this deck. ${investorSavedLeadCount} saved lead${investorSavedLeadCount === 1 ? "" : "s"} remain in your database-backed shortlist.`
                  : `You've browsed through all available ${directoryKind === "rias" ? "advisors" : "investors"} in this session. New profiles appear as more people join the marketplace.`}
              </p>
              {directoryKind === "investors" && investorDeckMeta ? (
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {investorDeckMeta.handled_count} handled · {investorDeckMeta.remaining_count} unseen
                </p>
              ) : null}
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="blue-gradient" effect="fill" size="sm" onClick={resetSwipeDeck}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {directoryKind === "investors" ? "Refresh deck" : "Start over"}
                </Button>
                <Button variant="none" effect="fade" size="sm" onClick={() => setView("list")}>
                  <List className="mr-2 h-4 w-4" />
                  Switch to list
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {!iamUnavailable && view === "list" ? (
        <div className="grid gap-4 pb-16 md:grid-cols-2 xl:grid-cols-3">
          {activeCards.map((item) => {
            const userId = discoveryCardUserId(item);
            const isPublicSecInvestor =
              item.kind === "investor" &&
              isPublicSecMarketplaceInvestor(item.profile as MarketplaceInvestor);
            return (
              <RiaSurface
                key={`${item.kind}-${item.id}`}
                className="grid h-full grid-rows-[auto_1fr_auto] gap-4 rounded-[28px] p-4 sm:p-5"
              >
                <div className="flex items-start gap-4">
                  <ProfileAvatar kind={item.kind} label={item.title} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[17px] font-semibold leading-snug tracking-normal text-foreground">
                        {item.title}
                      </h3>
                      {item.isTestProfile ? (
                        <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                          Test
                        </span>
                      ) : null}
                      {item.kind === "ria" && item.verificationStatus && !item.isTestProfile ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                          <ShieldCheck className="h-3 w-3" />
                          Verified
                        </span>
                      ) : null}
                      {isPublicSecInvestor ? (
                        <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                          Public SEC
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[14px] leading-[1.45] text-foreground/78">{item.headline}</p>
                  </div>
                </div>

                <div className="rounded-[var(--radius-md)] bg-background/50 p-4 dark:bg-white/5">
                  <p className="text-[14px] leading-[1.5] text-foreground/86">{item.summary}</p>
                  <p className="mt-3 text-[13px] text-muted-foreground">{item.metaLine}</p>
                </div>

                <div className="mt-auto grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    className="justify-center"
                    onClick={() => performPrimaryCardAction(item)}
                    disabled={
                      (Boolean(userId) && actionLoadingUserId === userId) ||
                      (Boolean(item.isTestProfile) && item.kind === "ria")
                    }
                  >
                    {item.isTestProfile
                      ? item.kind === "investor" && currentPersona === "ria"
                        ? "Open workspace"
                        : "Demo"
                      : Boolean(userId) && actionLoadingUserId === userId
                        ? "Connecting..."
                        : currentPersona === "investor"
                          ? "Request advisory"
                          : item.canConnect
                            ? "Send request"
                            : item.kind === "investor" &&
                                isMarketplaceInvestorShortlistable(
                                  item.profile as MarketplaceInvestor
                                )
                              ? "Save lead"
                              : "View profile"}
                  </Button>
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    className="justify-center"
                    onClick={() => openDiscoveryProfile(item)}
                  >
                    View details
                    <ArrowUpRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </RiaSurface>
            );
          })}

          {!loading && activeCards.length === 0 ? (
            <RiaSurface className="col-span-full p-6 text-center">
              <h3 className="text-[17px] font-semibold leading-snug tracking-normal text-foreground">No profiles</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Try a broader search.
              </p>
            </RiaSurface>
          ) : null}
        </div>
      ) : null}

      <SettingsDetailPanel
        open={Boolean(selectedProfile)}
        onOpenChange={(open) => {
          if (!open) setSelectedProfile(null);
        }}
        title={
          selectedProfile?.kind === "ria"
            ? selectedAdvisor?.display_name || "Advisor details"
            : selectedInvestor?.display_name || "Investor details"
        }
        description={
          selectedProfile?.kind === "ria"
            ? selectedAdvisor?.headline ||
              "Review this advisor profile before you decide whether to connect."
            : selectedInvestor?.headline ||
              "Review this investor profile before you decide whether to connect."
        }
      >
        <div className="space-y-4">
          {selectedProfile?.kind === "ria" && selectedRiaLoading ? (
            <p className="text-sm text-muted-foreground">Loading advisor details…</p>
          ) : null}
          {selectedProfile?.kind === "ria" && selectedRiaError ? (
            <RiaSurface className="border-red-500/20 bg-red-500/5 p-4">
              <p className="text-sm text-red-500">{selectedRiaError}</p>
            </RiaSurface>
          ) : null}

          {selectedProfile?.kind === "ria" && selectedAdvisor ? (
            <>
              <div className="flex items-start gap-4">
                <ProfileAvatar kind="ria" label={selectedAdvisor.display_name} className="h-16 w-16" />
                <div className="space-y-2">
                  {selectedInjectedRia ? (
                    <span className="inline-flex rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                      Test
                    </span>
                  ) : null}
                  <p className="text-sm leading-6 text-muted-foreground">
                    {selectedAdvisorFirmNames || "No public firm details shared yet."}
                  </p>
                </div>
              </div>

              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Strategy summary
                </p>
                <p className="mt-3 text-sm leading-7 text-foreground">
                  {selectedAdvisor.strategy_summary ||
                    selectedAdvisor.strategy ||
                    selectedAdvisor.bio ||
                    "No public strategy summary is available yet."}
                </p>
              </RiaSurface>

              <div className="flex flex-wrap gap-2">
                {currentPersona === "investor" ? (
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    onClick={() => void createConnectionToAdvisor(selectedAdvisor)}
                    disabled={actionLoadingUserId === selectedAdvisor.user_id || Boolean(selectedInjectedRia)}
                  >
                    {selectedInjectedRia
                      ? "Demo"
                      : actionLoadingUserId === selectedAdvisor.user_id
                        ? "Connecting..."
                        : "Request advisory"}
                  </Button>
                ) : null}
                {selectedAdvisor.disclosures_url ? (
                  <Button asChild variant="none" effect="fade" size="sm">
                    <a href={selectedAdvisor.disclosures_url} target="_blank" rel="noopener noreferrer">
                      Public disclosure
                      <ArrowUpRight className="ml-2 h-4 w-4" />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => router.push(connectionsRoute)}
                >
                  View connections
                </Button>
              </div>
            </>
          ) : null}

          {selectedProfile?.kind === "investor" && selectedInvestor ? (
            <>
              <div className="flex items-start gap-4">
                <ProfileAvatar kind="investor" label={selectedInvestor.display_name} className="h-16 w-16" />
                <div className="space-y-2">
                  {selectedInvestorIsTest ? (
                    <span className="inline-flex rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                      Test
                    </span>
                  ) : null}
                  {isPublicSecMarketplaceInvestor(selectedInvestor) ? (
                    <span className="inline-flex rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                      Public SEC profile
                    </span>
                  ) : null}
                  {selectedInvestorCurationLabel ? (
                    <span className="inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                      {selectedInvestorCurationLabel}
                    </span>
                  ) : null}
                  <p className="text-sm leading-6 text-muted-foreground">
                    {selectedInvestor.location_hint ||
                      selectedInvestorSourceLabel ||
                      "Public discovery profile"}
                  </p>
                </div>
              </div>

              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Fit summary
                </p>
                <p className="mt-3 text-sm leading-7 text-foreground">
                  {selectedInvestor.strategy_summary ||
                    (selectedInvestorConnectable
                      ? "This investor has opted into discovery and is available for a connection flow."
                      : "This public investor profile is available for discovery review. Direct consent requests require a verified Hushh investor account.")}
                </p>
              </RiaSurface>

              <RiaSurface className="space-y-3 p-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Evidence
                  </p>
                  <p className="mt-2 text-sm leading-6 text-foreground">
                    {selectedInvestorFormsLabel}
                  </p>
                </div>
                {selectedInvestorAddress ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    {selectedInvestorAddress}
                  </p>
                ) : null}
                {selectedInvestor.curation_reason ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    {selectedInvestor.curation_reason}
                  </p>
                ) : null}
                {typeof selectedInvestor.quality_score === "number" ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    Quality score: {selectedInvestor.quality_score}/100
                  </p>
                ) : null}
                {selectedInvestorEvidenceLinks.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedInvestorEvidenceLinks.map((url) => (
                      <Button key={url} asChild variant="none" effect="fade" size="sm">
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          SEC source
                          <ArrowUpRight className="ml-2 h-4 w-4" />
                        </a>
                      </Button>
                    ))}
                  </div>
                ) : null}
              </RiaSurface>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="sm"
                  onClick={() => {
                    if (
                      currentPersona === "ria" &&
                      selectedInvestorIsTest
                    ) {
                      if (selectedInvestorUserId) {
                        openTestInvestorWorkspace(selectedInvestorUserId);
                      }
                      return;
                    }
                    if (selectedInvestorShortlistable) {
                      void shortlistInvestor(selectedInvestor);
                      setSelectedProfile(null);
                      return;
                    }
                    if (selectedInvestorConnectable) {
                      void createConnectionToInvestor(selectedInvestor);
                    }
                  }}
                  disabled={
                    (!selectedInvestorConnectable && !selectedInvestorShortlistable) ||
                    (Boolean(selectedInvestorUserId) &&
                      actionLoadingUserId === selectedInvestorUserId &&
                      !selectedInvestorIsTest)
                  }
                >
                  {selectedInvestorIsTest
                    ? "Open workspace"
                    : Boolean(selectedInvestorUserId) &&
                        actionLoadingUserId === selectedInvestorUserId
                      ? "Connecting..."
                      : selectedInvestorConnectable
                        ? "Send request"
                        : selectedInvestorShortlistable
                          ? selectedInvestorIsShortlisted
                            ? "Saved lead"
                            : "Save lead"
                          : "Discovery only"}
                </Button>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => router.push(connectionsRoute)}
                >
                  View connections
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </SettingsDetailPanel>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
