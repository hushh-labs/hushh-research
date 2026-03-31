"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Search, UserRound } from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import { RiaPageShell, RiaSurface } from "@/components/ria/ria-page-shell";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { usePersonaState } from "@/lib/persona/persona-context";
import { buildMarketplaceRiaProfileRoute, ROUTES } from "@/lib/navigation/routes";
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

export default function MarketplacePage() {
  const router = useRouter();
  const { isAuthenticated, user } = useAuth();
  const { personaState } = usePersonaState();
  const defaultTab: "rias" | "investors" =
    personaState?.active_persona === "ria" ? "investors" : "rias";
  const [tab, setTab] = useState<"rias" | "investors">(defaultTab);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoadingUserId, setActionLoadingUserId] = useState<string | null>(null);
  const [rias, setRias] = useState<MarketplaceRia[]>([]);
  const [investors, setInvestors] = useState<MarketplaceInvestor[]>([]);
  const [relationships, setRelationships] = useState<RiaClientAccess[]>([]);
  const [advisorConnections, setAdvisorConnections] = useState<ConsentCenterEntry[]>([]);
  const [iamUnavailable, setIamUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadRelationshipContext() {
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const nextClients = await RiaService.listClients(idToken, {
          userId: user.uid,
        }).catch(() => ({ items: [] as RiaClientAccess[], total: 0, page: 1, limit: 50, has_more: false }));
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

    async function load() {
      setLoading(true);
      setIamUnavailable(false);
      try {
        if (tab === "rias") {
          const data = await RiaService.searchRias({ query, limit: 20 });
          if (!cancelled) setRias(data);
          return;
        }

        const data = await RiaService.searchInvestors({ query, limit: 20 });
        if (!cancelled) setInvestors(data);
      } catch (error) {
        if (!cancelled) {
          setIamUnavailable(isIAMSchemaNotReadyError(error));
          if (tab === "rias") setRias([]);
          else setInvestors([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [query, tab]);

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

  const currentPersona =
    personaState?.active_persona || personaState?.last_active_persona || "investor";

  useEffect(() => {
    setTab(currentPersona === "ria" ? "investors" : "rias");
  }, [currentPersona]);

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
      router.push(`${ROUTES.CONSENTS}?actor=ria&mode=connections&tab=pending`);
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
      router.push(`${ROUTES.CONSENTS}?actor=investor&mode=connections&tab=pending`);
    } finally {
      setActionLoadingUserId(null);
    }
  }

  function connectionBadgeLabel(status?: string | null) {
    if (!status) return "available";
    switch (String(status).toLowerCase()) {
      case "active":
      case "approved":
        return "connected";
      case "request_pending":
      case "pending":
        return "pending";
      case "revoked":
      case "cancelled":
      case "denied":
        return "closed";
      default:
        return String(status).replaceAll("_", " ");
    }
  }

  return (
    <RiaPageShell
      eyebrow="Marketplace"
      title="Public discovery first. Private access only after consent."
      description="Marketplace cards expose verified public metadata only. Connection actions stay persona-aware and never bypass the consent boundary."
    >
      <section className="space-y-3">
        <SectionHeader
          eyebrow="Discovery"
          title="Search public profiles before you open a connection"
          description="Use one shared discovery surface for both personas, then move approval and scoped access into consent manager."
          icon={Search}
        />
        <RiaSurface className="space-y-4">
          <SettingsSegmentedTabs
            value={tab}
            onValueChange={(value) => setTab(value as "rias" | "investors")}
            options={[
              { value: "rias", label: "Find RIAs" },
              { value: "investors", label: "Find investors" },
            ]}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tab === "rias" ? "Search RIAs by name" : "Search investors"}
              className="min-h-11 rounded-2xl border-border/80 bg-background/80 pl-10 text-sm"
            />
          </div>
        </RiaSurface>
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Loading marketplace…</p> : null}
      {iamUnavailable ? (
        <RiaSurface className="border-dashed border-amber-500/40 bg-amber-500/5">
          <p className="text-sm text-muted-foreground">
            Marketplace surfaces are waiting on IAM schema readiness in this environment.
          </p>
        </RiaSurface>
      ) : null}

      {tab === "rias" ? (
        <section className="space-y-3">
          <SectionHeader
            eyebrow="Advisor directory"
            title="RIA profiles"
            description="Verified public metadata stays lightweight here so investors can browse before opening a connection or a deeper profile."
            icon={Building2}
          />
          <SettingsGroup>
            {rias.map((ria) => {
              const connection = advisorConnectionMap.get(ria.user_id);
              const connectionState = connectionBadgeLabel(
                connection?.relationship_status || connection?.status
              );
              return (
                <SettingsRow
                  key={ria.id}
                  icon={Building2}
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{ria.display_name}</span>
                      <Badge
                        variant="outline"
                        className="border-border/70 bg-background/80 text-[10px] font-semibold uppercase text-muted-foreground"
                      >
                        {connection ? connectionState : ria.verification_status}
                      </Badge>
                    </div>
                  }
                  description={
                    <>
                      <p>{ria.headline || "Verified public advisor profile"}</p>
                      {Array.isArray(ria.firms) && ria.firms.length > 0 ? (
                        <p className="mt-1">{ria.firms.map((firm) => firm.legal_name).join(" • ")}</p>
                      ) : null}
                    </>
                  }
                  trailing={
                    isAuthenticated && currentPersona === "investor" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="blue-gradient"
                          effect="fill"
                          size="sm"
                          onClick={() => void createConnectionToAdvisor(ria)}
                          disabled={
                            actionLoadingUserId === ria.user_id ||
                            connectionState === "connected" ||
                            connectionState === "pending"
                          }
                        >
                          {actionLoadingUserId === ria.user_id
                            ? "Connecting..."
                            : connectionState === "connected"
                              ? "Connected"
                              : connectionState === "pending"
                                ? "Pending"
                                : "Connect"}
                        </Button>
                        <Button asChild variant="none" effect="fade" size="sm">
                          <Link href={buildMarketplaceRiaProfileRoute(ria.id)}>Open profile</Link>
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Switch to investor mode to start an advisor connection.
                      </span>
                    )
                  }
                />
              );
            })}
            {rias.length === 0 && !loading && !iamUnavailable ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                No RIA profiles found.
              </div>
            ) : null}
          </SettingsGroup>
        </section>
      ) : (
        <section className="space-y-3">
          <SectionHeader
            eyebrow="Investor directory"
            title="Lead-friendly investor profiles"
            description="Surface status, headline, and strategy cues first, then let connection actions flow through consent manager."
            icon={UserRound}
          />
          <SettingsGroup>
            {investors.map((investor) => {
              const relationship = relationshipMap.get(investor.user_id);
              const relationshipState = connectionBadgeLabel(
                relationship?.relationship_status || relationship?.status || "lead"
              );
              return (
                <SettingsRow
                  key={investor.user_id}
                  icon={UserRound}
                  stackTrailingOnMobile
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{investor.display_name}</span>
                      <Badge variant="outline" className="border-border/70 bg-background/80 text-[10px] font-semibold uppercase text-muted-foreground">
                        {relationshipState}
                      </Badge>
                    </div>
                  }
                  description={
                    <>
                      <p>{investor.headline || "Opt-in investor profile"}</p>
                      <p className="mt-1">
                        {investor.strategy_summary || investor.location_hint || "Public discovery metadata only."}
                      </p>
                    </>
                  }
                  trailing={
                    isAuthenticated && currentPersona === "ria" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="blue-gradient"
                          effect="fill"
                          size="sm"
                          onClick={() => void createConnectionToInvestor(investor)}
                          disabled={
                            actionLoadingUserId === investor.user_id ||
                            relationshipState === "connected" ||
                            relationshipState === "pending"
                          }
                        >
                          {actionLoadingUserId === investor.user_id
                            ? "Connecting..."
                            : relationshipState === "connected"
                              ? "Connected"
                              : relationshipState === "pending"
                                ? "Pending"
                                : "Connect"}
                        </Button>
                        <Button asChild variant="none" effect="fade" size="sm">
                          <Link
                            href={`${ROUTES.CONSENTS}?actor=ria&mode=connections&tab=pending&investor=${encodeURIComponent(
                              investor.user_id
                            )}`}
                          >
                            Review
                          </Link>
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Switch to RIA mode to start an investor connection.
                      </span>
                    )
                  }
                />
              );
            })}
            {investors.length === 0 && !loading && !iamUnavailable ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                No investor profiles found.
              </div>
            ) : null}
          </SettingsGroup>
        </section>
      )}
    </RiaPageShell>
  );
}
