"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
  isIAMSchemaNotReadyError,
  RiaService,
  type MarketplaceInvestor,
  type MarketplaceRia,
  type RiaClientAccess,
} from "@/lib/services/ria-service";

export default function MarketplacePage() {
  const { isAuthenticated, user } = useAuth();
  const { personaState } = usePersonaState();
  const [tab, setTab] = useState<"rias" | "investors">("rias");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoadingUserId, setActionLoadingUserId] = useState<string | null>(null);
  const [rias, setRias] = useState<MarketplaceRia[]>([]);
  const [investors, setInvestors] = useState<MarketplaceInvestor[]>([]);
  const [relationships, setRelationships] = useState<RiaClientAccess[]>([]);
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

  const currentPersona =
    personaState?.active_persona || personaState?.last_active_persona || "investor";

  async function createInvite(investor: MarketplaceInvestor) {
    if (!user) return;
    try {
      setActionLoadingUserId(investor.user_id);
      const idToken = await user.getIdToken();
      await RiaService.createInvites(idToken, {
        scope_template_id: "ria_financial_summary_v1",
        duration_mode: "preset",
        duration_hours: 168,
        targets: [
          {
            display_name: investor.display_name,
            investor_user_id: investor.user_id,
            source: "marketplace",
          },
        ],
      });
      const nextClients = await RiaService.listClients(idToken, { userId: user.uid });
      setRelationships(nextClients.items);
    } finally {
      setActionLoadingUserId(null);
    }
  }

  return (
    <RiaPageShell
      eyebrow="Marketplace"
      title="Public discovery first. Private access only after consent."
      description="Marketplace cards expose verified public metadata only. Relationship actions stay persona-aware and never bypass the consent boundary."
    >
      <section className="space-y-3">
        <SectionHeader
          eyebrow="Discovery"
          title="Search public profiles before you open a relationship"
          description="Use the same clean discovery surface for advisor and investor searches. Actions remain persona-aware and consent-safe."
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
            description="Verified public metadata stays lightweight here so investors can browse before opening a deeper profile."
            icon={Building2}
          />
          <SettingsGroup>
            {rias.map((ria) => (
              <SettingsRow
                key={ria.id}
                icon={Building2}
                title={
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{ria.display_name}</span>
                    <Badge variant="outline" className="border-border/70 bg-background/80 text-[10px] font-semibold uppercase text-muted-foreground">
                      {ria.verification_status}
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
                  <Button asChild variant="none" effect="fade" size="sm">
                    <Link href={buildMarketplaceRiaProfileRoute(ria.id)}>
                      Open profile
                    </Link>
                  </Button>
                }
              />
            ))}
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
            description="Surface status, headline, and strategy cues first, then let RIA mode decide which relationship actions are available."
            icon={UserRound}
          />
          <SettingsGroup>
            {investors.map((investor) => {
              const relationship = relationshipMap.get(investor.user_id);
              return (
                <SettingsRow
                  key={investor.user_id}
                  icon={UserRound}
                  stackTrailingOnMobile
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{investor.display_name}</span>
                      <Badge variant="outline" className="border-border/70 bg-background/80 text-[10px] font-semibold uppercase text-muted-foreground">
                        {relationship?.status || "lead"}
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
                          onClick={() => void createInvite(investor)}
                          disabled={actionLoadingUserId === investor.user_id}
                        >
                          {actionLoadingUserId === investor.user_id ? "Inviting..." : "Invite"}
                        </Button>
                        <Button asChild variant="none" effect="fade" size="sm">
                          <Link
                            href={`${ROUTES.CONSENTS}?view=pending&investor=${encodeURIComponent(
                              investor.user_id
                            )}`}
                          >
                            Request access
                          </Link>
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Switch to RIA mode to invite or request access.
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
