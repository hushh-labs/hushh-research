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
  UserRound,
  X,
} from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsDetailPanel } from "@/components/profile/settings-ui";
import { RiaSurface } from "@/components/ria/ria-page-shell";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { resolveAppEnvironment } from "@/lib/app-env";
import { Button } from "@/lib/morphy-ux/button";
import { usePersonaState } from "@/lib/persona/persona-context";
import { buildMarketplaceConnectionsRoute } from "@/lib/navigation/routes";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type MarketplaceInvestor,
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
  return ["active", "verified", "finra_verified", "bypassed"].includes(
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
    : { kind: "investor", id: item.profile.user_id };
}

export default function MarketplacePage() {
  const router = useRouter();
  const { user } = useAuth();
  const { personaState } = usePersonaState();
  const environment = resolveAppEnvironment();
  const allowTestProfiles = environment !== "production";
  const currentPersona =
    personaState?.active_persona || personaState?.last_active_persona || "investor";
  const directoryKind = currentPersona === "ria" ? "investors" : "rias";
  const searchPlaceholder =
    currentPersona === "ria" ? "Search investors by name" : "Search RIAs by name or firm";

  const [view, setView] = useState<DiscoveryView>("swipe");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasLoadedDirectory, setHasLoadedDirectory] = useState(false);
  const [actionLoadingUserId, setActionLoadingUserId] = useState<string | null>(null);
  const [rias, setRias] = useState<MarketplaceRia[]>([]);
  const [investors, setInvestors] = useState<MarketplaceInvestor[]>([]);
  const [relationships, setRelationships] = useState<RiaClientAccess[]>([]);
  const [advisorConnections, setAdvisorConnections] = useState<ConsentCenterEntry[]>([]);
  const [iamUnavailable, setIamUnavailable] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<SelectedProfile | null>(null);
  const [selectedRiaProfile, setSelectedRiaProfile] = useState<MarketplaceRia | null>(null);
  const [selectedRiaLoading, setSelectedRiaLoading] = useState(false);
  const [selectedRiaError, setSelectedRiaError] = useState<string | null>(null);
  const [passedRiaIds, setPassedRiaIds] = useState<string[]>([]);
  const [passedInvestorIds, setPassedInvestorIds] = useState<string[]>([]);
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
        if (directoryKind === "rias") {
          const data = await RiaService.searchRias({
            query,
            limit: 32,
            verification_status: "active",
          });
          if (!cancelled) setRias(data);
          return;
        }

        const data = await RiaService.searchInvestors({ query, limit: 32 });
        if (!cancelled) setInvestors(data);
      } catch (error) {
        if (!cancelled) {
          setIamUnavailable(isIAMSchemaNotReadyError(error));
          if (directoryKind === "rias") setRias([]);
          else setInvestors([]);
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
  }, [directoryKind, query]);

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
    return new Map(investors.map((item) => [item.user_id, item]));
  }, [investors]);

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
        profile: ria,
      };
    }).filter((item) => item.canConnect);
  }, [advisorConnectionMap, currentPersona, rias]);

  const investorCards = useMemo<DiscoveryCard[]>(() => {
    return investors.map((investor) => {
      const relationship = relationshipMap.get(investor.user_id);
      const connectionState = connectionBadgeLabel(
        relationship?.relationship_status || relationship?.status
      );
      const canConnect =
        currentPersona === "ria" &&
        connectionState !== "Connected" &&
        connectionState !== "Pending";
      return {
        id: investor.user_id,
        kind: "investor" as const,
        title: investor.display_name,
        headline: investor.headline || "Open to advisor connections",
        summary:
          investor.strategy_summary ||
          investor.location_hint ||
          "Discovery metadata only until both sides move into a connection flow.",
        metaLine: investor.location_hint || "Public discovery profile",
        canConnect,
        isTestProfile: false,
        profile: investor,
      };
    }).filter((item) => item.canConnect);
  }, [currentPersona, investors, relationshipMap]);

  const activeCards = useMemo<DiscoveryCard[]>(() => {
    const base = directoryKind === "rias" ? advisorCards : investorCards;
    if (directoryKind === "rias") {
      return [...base, ...injectedTestCards];
    }
    return base;
  }, [advisorCards, directoryKind, injectedTestCards, investorCards]);
  const passedIds = directoryKind === "rias" ? passedRiaIds : passedInvestorIds;
  const shuffledSwipeCards = useMemo(() => {
    const items = activeCards.filter((item) => !passedIds.includes(item.id));
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      const currentItem = copy[index]!;
      const swapItem = copy[swapIndex]!;
      copy[index] = swapItem;
      copy[swapIndex] = currentItem;
    }
    return copy;
  }, [activeCards, passedIds]);
  const swipeCards = shuffledSwipeCards;
  const swipeCard = swipeCards[0] || null;
  const selectedInvestor =
    selectedProfile?.kind === "investor" ? investorMap.get(selectedProfile.id) || null : null;
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

  async function createConnectionToInvestor(investor: MarketplaceInvestor) {
    if (!user) return;
    try {
      setActionLoadingUserId(investor.user_id);
      const idToken = await user.getIdToken();
      await ConsentCenterService.createRequest({
        idToken,
        userId: user.uid,
        payload: {
          subject_user_id: investor.user_id,
          requester_actor_type: "ria",
          subject_actor_type: "investor",
          scope_template_id: "ria_financial_summary_v1",
          duration_mode: "preset",
          duration_hours: 168,
        },
      });
      toast.success("Connection request sent", {
        description: "The investor can review it in their pending connections.",
      });
      router.push(buildMarketplaceConnectionsRoute({ tab: "pending" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send connection request");
    } finally {
      setActionLoadingUserId(null);
    }
  }

  async function createConnectionToAdvisor(ria: MarketplaceRia) {
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
  }

  const passCurrentCard = useCallback(() => {
    if (!swipeCard) return;
    if (directoryKind === "rias") {
      setPassedRiaIds((current) => (current.includes(swipeCard.id) ? current : [...current, swipeCard.id]));
      return;
    }
    setPassedInvestorIds((current) =>
      current.includes(swipeCard.id) ? current : [...current, swipeCard.id]
    );
  }, [directoryKind, swipeCard]);

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
      const shouldPass = Math.abs(dragOffset.x) > 110;
      dragStartRef.current = null;
      setDragOffset({ x: 0, y: 0 });
      if (shouldPass) {
        passCurrentCard();
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
  }, [dragOffset.x, passCurrentCard]);

  function resetSwipeDeck() {
    if (directoryKind === "rias") {
      setPassedRiaIds([]);
      return;
    }
    setPassedInvestorIds([]);
  }

  const connectionsRoute = buildMarketplaceConnectionsRoute({ tab: "active" });

  return (
    <AppPageShell
      as="main"
      width="content"
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
          title={currentPersona === "ria" ? "Find investors" : "Find advisors"}
          description="Public discovery first. Private access only after consent."
          icon={Compass}
          accent="sky"
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
        <div className="sticky top-[calc(var(--top-shell-reserved-height)+4px)] z-20">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground shadow-[var(--app-card-shadow-standard)] transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95",
                  searchOpen && "bg-primary/10 text-primary"
                )}
                aria-label="Toggle search"
                onClick={() => setSearchOpen((current) => !current)}
              >
                <Search className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground shadow-[var(--app-card-shadow-standard)] transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95"
                aria-label="Restart deck"
                onClick={resetSwipeDeck}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground shadow-[var(--app-card-shadow-standard)] transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95",
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
                  "grid h-10 w-10 place-items-center rounded-full border-0 bg-card text-foreground shadow-[var(--app-card-shadow-standard)] transition-[background-color,transform] duration-200 hover:scale-105 active:scale-95",
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
            <div className="mt-2 px-1">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  className="min-h-11 rounded-2xl border-0 bg-card pl-10 text-sm shadow-[var(--app-card-shadow-standard)]"
                />
              </div>
            </div>
          ) : null}
        </div>

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
                          <h3 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[2.1rem]">
                            {swipeCard.title}
                          </h3>
                          {swipeCard.isTestProfile ? (
                            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                              Test
                            </span>
                          ) : null}
                        </div>
                        <p className="text-sm leading-6 text-foreground/86 sm:text-base">{swipeCard.headline}</p>
                      </div>
                    </div>

                    <div className="rounded-[var(--radius-md)] bg-background/50 p-4 dark:bg-white/5">
                      <p className="text-sm leading-6 text-foreground">{swipeCard.summary}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
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
                    >
                      <X className="h-4 w-4 sm:mr-2" />
                      <span className="hidden sm:inline">Pass</span>
                    </Button>
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      className="justify-center"
                      onClick={() => setSelectedProfile(toSelectedProfile(swipeCard))}
                    >
                      <span className="hidden sm:inline">View</span>
                      <ArrowUpRight className="h-4 w-4 sm:ml-2" />
                    </Button>
                    <Button
                      variant="blue-gradient"
                      effect="fill"
                      size="sm"
                      className="justify-center"
                      onClick={() =>
                        swipeCard.kind === "ria"
                          ? void createConnectionToAdvisor(swipeCard.profile as MarketplaceRia)
                          : void createConnectionToInvestor(swipeCard.profile as MarketplaceInvestor)
                      }
                      disabled={actionLoadingUserId === swipeCard.profile.user_id || Boolean(swipeCard.isTestProfile)}
                    >
                      <span className="truncate">
                        {swipeCard.isTestProfile
                          ? "Demo"
                          : actionLoadingUserId === swipeCard.profile.user_id
                            ? "Connecting..."
                            : "Connect"}
                      </span>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
              <h3 className="text-xl font-semibold tracking-tight text-foreground">
                That&apos;s everyone for now
              </h3>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                You&apos;ve browsed through all available {directoryKind === "rias" ? "advisors" : "investors"} in this session. New profiles appear as more people join the marketplace.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="blue-gradient" effect="fill" size="sm" onClick={resetSwipeDeck}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Start over
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
            const userId = item.kind === "ria" ? item.profile.user_id : item.profile.user_id;
            return (
              <RiaSurface
                key={`${item.kind}-${item.id}`}
                className="grid h-full grid-rows-[auto_1fr_auto] gap-4 rounded-[28px] p-4 sm:p-5"
              >
                <div className="flex items-start gap-4">
                  <ProfileAvatar kind={item.kind} label={item.title} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <h3 className="text-lg font-semibold tracking-tight text-foreground">{item.title}</h3>
                    <p className="text-sm leading-6 text-foreground/84">{item.headline}</p>
                  </div>
                </div>

                <div className="rounded-[var(--radius-md)] bg-background/50 p-4 dark:bg-white/5">
                  <p className="text-sm leading-6 text-foreground">{item.summary}</p>
                  <p className="mt-3 text-sm text-muted-foreground">{item.metaLine}</p>
                </div>

                <div className="mt-auto grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    className="justify-center"
                    onClick={() =>
                      item.kind === "ria"
                        ? void createConnectionToAdvisor(item.profile as MarketplaceRia)
                        : void createConnectionToInvestor(item.profile as MarketplaceInvestor)
                    }
                    disabled={actionLoadingUserId === userId || Boolean(item.isTestProfile)}
                  >
                    {item.isTestProfile
                      ? "Demo"
                      : actionLoadingUserId === userId
                        ? "Connecting..."
                        : "Connect"}
                  </Button>
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    className="justify-center"
                    onClick={() => setSelectedProfile(toSelectedProfile(item))}
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
              <h3 className="text-lg font-semibold tracking-tight text-foreground">No profiles</h3>
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
                      : "Connect"}
                </Button>
                {selectedAdvisor.disclosures_url ? (
                  <Button asChild variant="none" effect="fade" size="sm">
                    <a href={selectedAdvisor.disclosures_url} target="_blank" rel="noreferrer">
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
                  <p className="text-sm leading-6 text-muted-foreground">
                    {selectedInvestor.location_hint || "Public discovery profile"}
                  </p>
                </div>
              </div>

              <RiaSurface className="p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Fit summary
                </p>
                <p className="mt-3 text-sm leading-7 text-foreground">
                  {selectedInvestor.strategy_summary ||
                    "This investor has opted into discovery and is available for a connection flow."}
                </p>
              </RiaSurface>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="sm"
                  onClick={() => void createConnectionToInvestor(selectedInvestor)}
                  disabled={actionLoadingUserId === selectedInvestor.user_id}
                >
                  {actionLoadingUserId === selectedInvestor.user_id ? "Connecting..." : "Connect"}
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
