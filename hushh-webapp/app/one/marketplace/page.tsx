"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, RefreshCw, Store } from "lucide-react";
import { toast } from "sonner";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PkmSectionPreview } from "@/components/profile/pkm-section-preview";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { SettingsSegmentedTabs } from "@/components/profile/settings-ui";
import {
  buildPkmSectionPreviewPresentation,
  type PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/morphy";
import { useVault } from "@/lib/vault/vault-context";
import {
  PersonalKnowledgeModelService,
  PkmScopeExposureError,
  type DomainSummary,
  type PkmVisibilityPosture,
} from "@/lib/services/personal-knowledge-model-service";
import { type DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  buildPkmDomainPermissionPresentation,
  type PkmDomainPermissionPresentation,
} from "@/lib/profile/pkm-profile-presentation";
import {
  applyManifestExposureChange,
  applySlicePosture,
} from "@/lib/personal-knowledge-model/slice-publishing";
import {
  categoryFromSensitivity,
  formatCents,
  SlicePricingService,
  type PricingMood,
  type PricingPower,
  type SlicePriceBreakdown,
  type SlicePricingInput,
} from "@/lib/services/slice-pricing-service";

type MarketplaceView = "owner" | "buyer" | "flow";

/**
 * In-session demo request. NOT a real consent grant and NOT persisted — clears on
 * refresh. Real access requests live in the Consent Guardian; wiring the
 * marketplace to file them there is a later phase.
 */
interface MarketRequest {
  id: string;
  sliceName: string;
  domainKey: string;
  domainTitle: string;
  topLevelScopePath: string;
  description: string;
  input: SlicePricingInput;
  createdAt: number;
  status: "pending" | "approved" | "denied";
}

interface DomainRecord {
  summary: DomainSummary;
  manifest: DomainManifest;
}

const POWER_OPTIONS: { value: PricingPower; label: string }[] = [
  { value: "mass", label: "Mass · under $50k" },
  { value: "affluent", label: "Affluent · $150k–500k" },
  { value: "uhnw", label: "UHNW · $25M+ net worth" },
];
const MOOD_OPTIONS: { value: PricingMood; label: string }[] = [
  { value: "passive", label: "Passive" },
  { value: "affinity", label: "Affinity" },
  { value: "in_market", label: "In-market" },
  { value: "hot", label: "Hot big-ticket" },
];
const POSTURE_OPTIONS: { value: PkmVisibilityPosture; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "consent_required", label: "Ask first" },
  { value: "default_available", label: "Available" },
];

// Structural (system / non-personal) scope keys that can NEVER be published as
// `default_available`, even with explicit owner consent — the backend
// hard-blocks these too. These are not the owner's personal data.
const DEFAULT_AVAILABLE_BLOCKED_KEYS = new Set([
  "hash",
  "metadata",
  "provenance",
  "schema_version",
  "workflow",
  "workflow_id",
]);

// Only structural blocked keys are refused up front. `restricted`-tier data is
// the owner's own sensitive data: it IS publishable once the owner explicitly
// consents in the marketplace (the backend honors that consent via
// owner_consent_override), so we no longer block it client-side.
function isStructurallyBlockedForPublish(topLevelScopePath: string): boolean {
  return topLevelScopePath
    .split(".")
    .some((part) => DEFAULT_AVAILABLE_BLOCKED_KEYS.has(part));
}

function attributeCountFor(manifest: DomainManifest, scopeHandle: string | null): number {
  const entry = (manifest.scope_registry || []).find((s) => s.scope_handle === scopeHandle);
  return (entry?.segment_ids || []).length || 1;
}

function usePrice(input: SlicePricingInput | null, token?: string) {
  const [result, setResult] = useState<SlicePriceBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const key = input
    ? `${input.category}:${input.attributeCount}:${input.power}:${input.mood}`
    : "none";
  useEffect(() => {
    let cancelled = false;
    if (!input || !token) {
      setResult(null);
      return;
    }
    setLoading(true);
    SlicePricingService.getSuggestedPrice(input, token)
      .then((next) => !cancelled && setResult(next))
      .catch(() => !cancelled && setResult(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);
  return { result, loading };
}

function dollars(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function factor(n: number): string {
  return `×${(Number.isFinite(n) ? n : 1).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}`;
}

/** Slide-style price math: ( floor + data value ) × buyer fit × freshness × exclusivity. */
function PriceMath({ result }: { result: SlicePriceBreakdown }) {
  const b = result.breakdown as Record<string, number>;
  const floor = (Number(b.floor_cents) || 10) / 100;
  const dataValue = Math.max(0, (Number(b.composite_dollars) || floor) - floor);
  const buyerFit = Number(b.multiplier_b) || 1;
  const freshness = Number(b.multiplier_f) || 1;
  const exclusivity = Number(b.multiplier_x) || 1;
  const geo = Number(b.multiplier_g) || 1;
  const final = formatCents(result.suggestedPriceCents, result.currency);

  return (
    <div className="mt-3 rounded-xl border bg-muted/30 p-4 text-sm">
      <div className="font-mono text-[12.5px] leading-6">
        Price = ( <span className="text-muted-foreground">floor</span> {dollars(floor)} +{" "}
        <span className="text-blue-600 dark:text-blue-400">data value</span> {dollars(dataValue)} ){" "}
        <span className="text-blue-600 dark:text-blue-400">buyer fit</span> {factor(buyerFit)}{" "}
        <span className="text-blue-600 dark:text-blue-400">freshness</span> {factor(freshness)}{" "}
        <span className="text-blue-600 dark:text-blue-400">exclusivity</span> {factor(exclusivity)}
        {geo !== 1 ? (
          <>
            {" "}
            <span className="text-blue-600 dark:text-blue-400">geo</span> {factor(geo)}
          </>
        ) : null}{" "}
        = <span className="font-semibold text-emerald-700 dark:text-emerald-300">{final}</span>
      </div>
      <dl className="mt-3 space-y-1.5 text-[12.5px] text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Data value</span> — financial data counts most,
          plain demographics least; more attributes help, with diminishing returns.
        </div>
        <div>
          <span className="font-medium text-foreground">Buyer fit</span> — spending power × buying mood; an
          about-to-buy signal matters more than raw wealth.
        </div>
        <div>
          <span className="font-medium text-foreground">Freshness</span> — updated today = full value; stale
          data fades toward a floor.
        </div>
        <div>
          <span className="font-medium text-foreground">Exclusivity</span> — sold to everyone = base; sold to
          one buyer = worth more.
        </div>
      </dl>
    </div>
  );
}

/**
 * The actual safe summary that would be shared for a slice — loaded from the
 * owner's real (vault-decrypted) section data and reduced to the same safe
 * projection that `default_available` publishes. Never raw PKM.
 */
function extractColumns(p: PkmSectionPreviewPresentation): string[] {
  const cols = new Set<string>();
  for (const s of p.stats || []) if (s?.label) cols.add(s.label);
  for (const g of (p.groups || []) as Array<Record<string, unknown>>) {
    const fields = g.fields as Array<{ label?: string }> | undefined;
    if (Array.isArray(fields)) for (const f of fields) if (f?.label) cols.add(f.label);
    const entities = g.entities as Array<{ sections?: Array<{ label?: string }> }> | undefined;
    if (Array.isArray(entities)) {
      for (const e of entities) {
        if (Array.isArray(e.sections)) for (const sec of e.sections) if (sec?.label) cols.add(sec.label);
      }
    }
  }
  return [...cols];
}

function SharedDataPreview({
  userId,
  vaultKey,
  token,
  domainKey,
  domainTitle,
  topLevelScopePath,
  label,
  description,
  columnsOnly,
}: {
  userId?: string;
  vaultKey: string | null;
  token?: string;
  domainKey: string;
  domainTitle: string;
  topLevelScopePath: string;
  label: string;
  description?: string | null;
  columnsOnly?: boolean;
}) {
  const [presentation, setPresentation] = useState<PkmSectionPreviewPresentation | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId || !vaultKey) {
      setErr("Unlock your vault to preview the shared summary.");
      return;
    }
    setLoading(true);
    setErr(null);
    PersonalKnowledgeModelService.loadDomainData({
      userId,
      domain: domainKey,
      vaultKey,
      vaultOwnerToken: token,
      segmentIds: [topLevelScopePath],
    })
      .then((value) => {
        if (cancelled) return;
        setPresentation(
          buildPkmSectionPreviewPresentation({
            domain: domainKey,
            domainTitle,
            permissionLabel: label,
            permissionDescription: description || null,
            topLevelScopePath,
            value,
          })
        );
      })
      .catch(() => !cancelled && setErr("Could not load the shared summary."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, vaultKey, token, domainKey, topLevelScopePath]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading safe summary…</div>;
  }
  if (err) {
    return <div className="text-sm text-muted-foreground">{err}</div>;
  }
  if (!presentation) return null;

  if (columnsOnly) {
    const columns = extractColumns(presentation);
    return (
      <div className="rounded-xl border bg-muted/20 p-4">
        <div className="mb-2 text-xs text-muted-foreground">
          Fields included · <span className="font-medium text-foreground">values are revealed only
          after the owner approves your request</span>
        </div>
        {columns.length === 0 ? (
          <div className="text-sm text-muted-foreground">Safe summary fields only.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {columns.map((c) => (
              <span
                key={c}
                className="rounded-full bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
              >
                {c}: •••
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <PkmSectionPreview presentation={presentation} />
    </div>
  );
}

interface PreviewFields {
  userId?: string;
  vaultKey: string | null;
  token?: string;
  domainKey: string;
  domainTitle: string;
  topLevelScopePath: string;
  label: string;
  description?: string | null;
  columnsOnly?: boolean;
}

/** Expander — shows the real safe summary (owner) or field names only (buyer). */
function PreviewToggle(props: PreviewFields) {
  const [open, setOpen] = useState(false);
  const showLabel = props.columnsOnly ? "See fields included" : "Preview shared data";
  const hideLabel = props.columnsOnly ? "Hide fields" : "Hide shared data";
  return (
    <div className="mt-3">
      <Button type="button" size="sm" variant="none" effect="fade" onClick={() => setOpen((v) => !v)}>
        {open ? hideLabel : showLabel}
      </Button>
      {open ? (
        <div className="mt-2">
          <SharedDataPreview {...props} />
        </div>
      ) : null}
    </div>
  );
}

function PriceLine({
  input,
  token,
  showMath,
}: {
  input: SlicePricingInput | null;
  token?: string;
  showMath?: boolean;
}) {
  const { result, loading } = usePrice(input, token);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-2xl font-semibold tracking-tight">
          {loading ? (
            "…"
          ) : result ? (
            <>
              {formatCents(result.suggestedPriceCents, result.currency)}{" "}
              <span className="text-sm font-medium text-muted-foreground">/ 30 days</span>
            </>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">—</span>
          )}
        </div>
        {showMath ? (
          <Button
            type="button"
            size="sm"
            variant="none"
            effect="fade"
            disabled={!result}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide math" : "Show math"}
          </Button>
        ) : null}
      </div>
      {showMath && open && result ? <PriceMath result={result} /> : null}
    </div>
  );
}

export default function OneMarketplacePage() {
  const router = useRouter();
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const token = vaultOwnerToken ?? undefined;

  const [view, setView] = useState<MarketplaceView>("owner");
  const [power, setPower] = useState<PricingPower>("affluent");
  const [mood, setMood] = useState<PricingMood>("affinity");
  const [purchaseSection, setPurchaseSection] = useState<Section | null>(null);
  // Owner is about to publish this section to the marketplace and must explicitly
  // consent first (consent-first). Null when no confirmation is pending.
  const [confirmPublish, setConfirmPublish] = useState<Section | null>(null);
  const [requests, setRequests] = useState<MarketRequest[]>([]);

  const [records, setRecords] = useState<DomainRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [refreshToken, setRefreshToken] = useState(0);

  // Load the owner's real PKM domains + manifests. The scope registry on each
  // manifest is the source of shareable sections and their consent posture.
  useEffect(() => {
    let cancelled = false;
    if (!user?.uid) {
      setRecords([]);
      return;
    }
    // Do NOT wipe an already-loaded list when the vault/token momentarily drops
    // (e.g. the owner token rotating right after a publish) — keep the current
    // sections visible instead of flashing them away.
    if (!isVaultUnlocked || !token) {
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, false, token);
        const summaries = (metadata.domains || []).filter((d) => d.key);
        const loaded = await Promise.all(
          summaries.map(async (summary) => {
            const manifest = await PersonalKnowledgeModelService.getDomainManifest(
              user.uid,
              summary.key,
              token
            ).catch(() => null);
            return { summary, manifest };
          })
        );
        if (cancelled) return;
        // Keep the prior manifest for any domain whose reload transiently failed,
        // so a hiccup never makes a just-published section vanish.
        setRecords((prev) => {
          const prevByKey = new Map(prev.map((r) => [r.summary.key, r]));
          const next: DomainRecord[] = [];
          for (const { summary, manifest } of loaded) {
            if (manifest) next.push({ summary, manifest });
            else {
              const prior = prevByKey.get(summary.key);
              if (prior) next.push(prior);
            }
          }
          return next;
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load your data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, isVaultUnlocked, token, refreshToken]);

  interface Section {
    key: string;
    domainKey: string;
    domainTitle: string;
    manifest: DomainManifest;
    summary: DomainSummary;
    permission: PkmDomainPermissionPresentation;
  }

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    for (const rec of records) {
      const permissions = buildPkmDomainPermissionPresentation({
        domain: rec.summary,
        manifest: rec.manifest,
        activeGrants: [],
        upgradeState: null,
      });
      for (const permission of permissions) {
        out.push({
          key: `${rec.summary.key}:${permission.topLevelScopePath}`,
          domainKey: rec.summary.key,
          domainTitle: rec.summary.displayName || rec.summary.key,
          manifest: rec.manifest,
          summary: rec.summary,
          permission,
        });
      }
    }
    return out;
  }, [records]);

  const priceInput = useCallback(
    (section: Section): SlicePricingInput => ({
      category: categoryFromSensitivity(section.permission.sensitivityTier),
      attributeCount: attributeCountFor(section.manifest, section.permission.scopeHandle),
      power,
      mood,
    }),
    [power, mood]
  );

  const replaceManifest = useCallback((domainKey: string, manifest: DomainManifest) => {
    setRecords((current) =>
      current.map((rec) => (rec.summary.key === domainKey ? { ...rec, manifest } : rec))
    );
  }, []);

  // The actual posture write. Publishing (`default_available`) only reaches here
  // after the owner has explicitly confirmed in the consent modal.
  const runPosture = useCallback(
    async (section: Section, nextPosture: PkmVisibilityPosture) => {
      if (!user?.uid || !vaultOwnerToken) {
        toast.error("Unlock your vault to change sharing.");
        return;
      }
      if (nextPosture === "default_available" && !vaultKey) {
        toast.error("Unlock your vault to publish a slice.");
        return;
      }
      if (
        nextPosture === "default_available" &&
        isStructurallyBlockedForPublish(section.permission.topLevelScopePath)
      ) {
        // Structural (system) keys can never publish, even with owner consent —
        // the backend hard-blocks them too. Restricted-tier personal data is
        // allowed through: the owner's explicit consent (owner_consent_override)
        // lets the backend publish it, so we do not block it here.
        toast.error(
          "This section is system data (not your personal data) and can't be published to the marketplace."
        );
        return;
      }
      const previousManifest = section.manifest;
      const optimistic =
        applyManifestExposureChange(
          previousManifest,
          { scopeHandle: section.permission.scopeHandle, topLevelScopePath: section.permission.topLevelScopePath },
          nextPosture
        ) ?? previousManifest;

      setPending((p) => ({ ...p, [section.key]: true }));
      replaceManifest(section.domainKey, optimistic);
      try {
        const { manifest } = await applySlicePosture({
          userId: user.uid,
          domain: section.domainKey,
          domainTitle: section.domainTitle,
          permission: {
            scopeHandle: section.permission.scopeHandle,
            label: section.permission.label,
            description: section.permission.description,
            topLevelScopePath: section.permission.topLevelScopePath,
          },
          nextPosture,
          previousManifest,
          vaultKey: vaultKey ?? undefined,
          vaultOwnerToken,
          source: "marketplace_owner",
          // Publishing Available from the marketplace goes through the explicit
          // owner consent modal, so forward that consent as the override. The
          // backend still hard-blocks structural (non-personal) scope keys.
          ownerConsentOverride: true,
        });

        // Authoritative re-fetch: the consent guardrail decides the final posture
        // server-side and can downgrade `default_available` (e.g. a scope the
        // backend still tags restricted). Trust what the server actually persisted
        // rather than our optimistic guess, so the UI never shows a fake success
        // that then "reverts" on the next load.
        const fresh = token
          ? await PersonalKnowledgeModelService.getDomainManifest(
              user.uid,
              section.domainKey,
              token,
              true
            ).catch(() => null)
          : null;
        const authoritative = fresh ?? manifest;
        replaceManifest(section.domainKey, authoritative);

        const persistedPosture =
          buildPkmDomainPermissionPresentation({
            domain: section.summary,
            manifest: authoritative,
            activeGrants: [],
            upgradeState: null,
          }).find((p) => p.topLevelScopePath === section.permission.topLevelScopePath)
            ?.visibilityPosture ?? nextPosture;

        if (nextPosture === "default_available" && persistedPosture !== "default_available") {
          // Owner consented, but the guardrail still refused to expose this section.
          // Be honest about it instead of implying the publish stuck.
          toast.error(
            "This section is protected — the consent guardrail keeps it consent-gated, so it can't be published to the marketplace."
          );
        } else {
          toast.success(
            nextPosture === "private"
              ? "This section is private."
              : nextPosture === "default_available"
                ? "Published — available to buyers with a price."
                : "One will ask before sharing this section."
          );
        }
      } catch (err) {
        if (err instanceof PkmScopeExposureError && err.status === 409 && user?.uid && token) {
          // Client manifest was stale (a prior change bumped the version). Re-sync
          // the live manifest so the next toggle uses the current version.
          const fresh = await PersonalKnowledgeModelService.getDomainManifest(
            user.uid,
            section.domainKey,
            token,
            true
          ).catch(() => null);
          replaceManifest(section.domainKey, fresh ?? previousManifest);
          toast.error("Sharing was out of date — refreshed. Tap again.");
        } else {
          replaceManifest(section.domainKey, previousManifest);
          toast.error(err instanceof Error ? err.message : "Couldn't update sharing.");
        }
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[section.key];
          return next;
        });
      }
    },
    [user?.uid, vaultKey, vaultOwnerToken, token, replaceManifest]
  );

  // Publishing to the marketplace is consent-first: route "Available" through an
  // explicit confirmation. Making a section private or consent-gated needs no
  // extra prompt (it only ever tightens sharing).
  const onTogglePosture = useCallback(
    (section: Section, nextPosture: PkmVisibilityPosture) => {
      if (nextPosture === "default_available") {
        if (isStructurallyBlockedForPublish(section.permission.topLevelScopePath)) {
          toast.error(
            "This section is system data (not your personal data) and can't be published to the marketplace."
          );
          return;
        }
        setConfirmPublish(section);
        return;
      }
      void runPosture(section, nextPosture);
    },
    [runPosture]
  );

  const availableSections = sections.filter(
    (s) => s.permission.visibilityPosture === "default_available"
  );

  const pendingRequestCount = requests.filter((r) => r.status === "pending").length;

  const confirmPurchase = useCallback(() => {
    setPurchaseSection((current) => {
      if (!current) return null;
      setRequests((cur) => [
        {
          id: `${current.key}:${Date.now()}`,
          sliceName: current.permission.label,
          domainKey: current.domainKey,
          domainTitle: current.domainTitle,
          topLevelScopePath: current.permission.topLevelScopePath,
          description: current.permission.description,
          input: priceInput(current),
          createdAt: Date.now(),
          status: "pending",
        },
        ...cur,
      ]);
      return null;
    });
    setView("flow");
    toast.success("Request sent — see Consent flow & requests.");
  }, [priceInput]);

  const setRequestStatus = useCallback((id: string, status: MarketRequest["status"]) => {
    setRequests((cur) => cur.map((r) => (r.id === id ? { ...r, status } : r)));
  }, []);

  const bandControls = (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      Buyer band <span className="text-xs">(used only to price your own slices)</span>
      <select
        className="rounded-full border bg-background px-3 py-1.5 text-foreground"
        value={power}
        onChange={(e) => setPower(e.target.value as PricingPower)}
      >
        {POWER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="rounded-full border bg-background px-3 py-1.5 text-foreground"
        value={mood}
        onChange={(e) => setMood(e.target.value as PricingMood)}
      >
        {MOOD_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <PkmSettingsShell
      eyebrow="One / Marketplace"
      title="Data Slice Marketplace"
      description="Your data, your business. Choose what each section shares — Private, Ask first, or Available — and see what it's worth. Nothing is ever shared without your approval."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSegmentedTabs
            value={view}
            onValueChange={(value) => setView(value as MarketplaceView)}
            options={[
              { value: "owner", label: "Owner" },
              { value: "buyer", label: "Buyer" },
              {
                value: "flow",
                label:
                  pendingRequestCount > 0
                    ? `Flow & requests (${pendingRequestCount})`
                    : "Flow & requests",
              },
            ]}
          />
          <Button
            type="button"
            size="sm"
            variant="none"
            effect="fade"
            onClick={() => setRefreshToken((v) => v + 1)}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        </div>
      }
    >
      <NativeTestBeacon
        routeId="/one/marketplace"
        marker="native-route-one-marketplace"
        authState="authenticated"
        dataState={sections.length ? "loaded" : "empty-valid"}
      />

      <div className="mb-5 rounded-2xl border border-amber-200/60 bg-amber-50/40 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/10 dark:text-amber-300">
        Consent-first · a section is shared only after you set it to Available and approve a specific
        buyer. Prices are a research-anchored suggestion computed live — you set the final price. No
        money moves here.
      </div>

      {!isVaultUnlocked ? (
        <div className="flex items-center gap-2 rounded-2xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" aria-hidden />
          Unlock your vault to manage and price your data sections.
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : loading ? (
        <div className="rounded-2xl border p-6 text-center text-sm text-muted-foreground">
          Loading your data sections…
        </div>
      ) : (
        <>
          {/* OWNER VIEW — the single consent-first control panel */}
          {view === "owner" ? (
            <div className="space-y-4">
              {bandControls}
              {sections.length === 0 ? (
                <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  <Store className="mx-auto mb-2 h-6 w-6 opacity-60" aria-hidden />
                  No shareable sections yet. Add some Personal Data (e.g. via onboarding or the PKM
                  workspace), then each section will appear here to price and publish.
                </div>
              ) : (
                sections.map((section) => {
                  const isAvailable = section.permission.visibilityPosture === "default_available";
                  const busy = pending[section.key] === true;
                  const structurallyBlocked = isStructurallyBlockedForPublish(
                    section.permission.topLevelScopePath
                  );
                  return (
                    <div key={section.key} className="rounded-2xl border p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-lg font-semibold">{section.permission.label}</div>
                          <div className="mt-0.5 text-sm text-muted-foreground">
                            {section.domainTitle} ·{" "}
                            {attributeCountFor(section.manifest, section.permission.scopeHandle)}{" "}
                            attribute
                            {attributeCountFor(section.manifest, section.permission.scopeHandle) === 1
                              ? ""
                              : "s"}{" "}
                            · safe summary only
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span className="rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                              safe summary
                            </span>
                            {section.permission.sensitivityTier ? (
                              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                                {section.permission.sensitivityTier}
                              </span>
                            ) : null}
                            {structurallyBlocked ? (
                              <span className="rounded-full bg-rose-500/12 px-2.5 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                                system data · can’t publish
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className={"mt-4 " + (busy ? "pointer-events-none opacity-60" : "")}>
                        <SettingsSegmentedTabs
                          value={section.permission.visibilityPosture}
                          onValueChange={(next) =>
                            onTogglePosture(section, next as PkmVisibilityPosture)
                          }
                          options={POSTURE_OPTIONS}
                          mobileColumns={1}
                        />
                      </div>
                      {structurallyBlocked ? (
                        <div className="mt-2 text-[12px] text-muted-foreground">
                          This is system data (not your personal data), so it can’t be published to the
                          marketplace. Your own sections — including restricted ones — can be set to
                          “Available” with your explicit consent.
                        </div>
                      ) : null}

                      <div className="mt-4 border-t pt-4">
                        {isAvailable ? (
                          <>
                            <PriceLine input={priceInput(section)} token={token} showMath />
                            <PreviewToggle
                              userId={user?.uid}
                              vaultKey={vaultKey}
                              token={token}
                              domainKey={section.domainKey}
                              domainTitle={section.domainTitle}
                              topLevelScopePath={section.permission.topLevelScopePath}
                              label={section.permission.label}
                              description={section.permission.description}
                            />
                          </>
                        ) : (
                          <div className="text-sm text-muted-foreground">
                            Set to <span className="font-medium text-foreground">Available</span> to
                            publish a safe summary and see its suggested price.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}

          {/* BUYER — available slices, purchasable */}
          {view === "buyer" ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Slices available to buy — only the safe summary, never raw data. Purchase grants 30-day
                scoped access, and it is only ever delivered after the owner approves your request.
              </p>
              {availableSections.length === 0 ? (
                <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  <Store className="mx-auto mb-2 h-6 w-6 opacity-60" aria-hidden />
                  Nothing on the market yet. In the <span className="font-medium text-foreground">Owner</span>{" "}
                  tab, set a section to <span className="font-medium text-foreground">Available</span> and it
                  will list here to buy.
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {availableSections.map((section) => (
                    <div key={section.key} className="flex flex-col rounded-2xl border p-5">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                          available
                        </span>
                        <span className="text-xs text-muted-foreground">{section.domainTitle}</span>
                      </div>
                      <div className="mt-2 text-lg font-semibold">{section.permission.label}</div>
                      <div className="mt-0.5 text-sm text-muted-foreground">
                        {attributeCountFor(section.manifest, section.permission.scopeHandle)} attribute
                        {attributeCountFor(section.manifest, section.permission.scopeHandle) === 1 ? "" : "s"}{" "}
                        · safe summary
                      </div>
                      <div className="mt-4 border-t pt-4">
                        <PriceLine input={priceInput(section)} token={token} showMath />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="none"
                        effect="fade"
                        className="mt-4 self-start"
                        onClick={() => setPurchaseSection(section)}
                      >
                        Purchase 30-day access
                      </Button>
                      <PreviewToggle
                        columnsOnly
                        userId={user?.uid}
                        vaultKey={vaultKey}
                        token={token}
                        domainKey={section.domainKey}
                        domainTitle={section.domainTitle}
                        topLevelScopePath={section.permission.topLevelScopePath}
                        label={section.permission.label}
                        description={section.permission.description}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* FLOW & REQUESTS — marketplace's own consent inbox (in-session demo) */}
          {view === "flow" ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">Access requests</div>
                <Button
                  type="button"
                  size="sm"
                  variant="none"
                  effect="fade"
                  onClick={() => router.push("/consents?tab=pending")}
                >
                  Real Consent Guardian →
                </Button>
              </div>

              {requests.length === 0 ? (
                <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No requests yet. In the <span className="font-medium text-foreground">Buyer</span> tab,
                  buy an available slice — the request lands here for you to approve or deny.
                </div>
              ) : (
                <div className="space-y-3">
                  {requests.map((req) => (
                    <div key={req.id} className="rounded-2xl border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">{req.sliceName}</span>
                            <span
                              className={
                                "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                                (req.status === "pending"
                                  ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
                                  : req.status === "approved"
                                    ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                    : "bg-muted text-muted-foreground")
                              }
                            >
                              {req.status}
                            </span>
                          </div>
                          <div className="mt-0.5 text-sm text-muted-foreground">
                            {req.domainTitle} · 30-day scoped access · safe summary only
                          </div>
                        </div>
                        <div className="text-right">
                          <PriceLine input={req.input} token={token} />
                        </div>
                      </div>
                      {req.status === "pending" ? (
                        <div className="mt-3 flex gap-2 border-t pt-3">
                          <Button
                            type="button"
                            size="sm"
                            variant="none"
                            effect="fade"
                            onClick={() => {
                              setRequestStatus(req.id, "approved");
                              toast.success("Approved — the encrypted slice would be delivered to that buyer only.");
                            }}
                          >
                            Approve
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="none"
                            effect="fade"
                            onClick={() => {
                              setRequestStatus(req.id, "denied");
                              toast("Denied. Nothing shared.");
                            }}
                          >
                            Deny
                          </Button>
                        </div>
                      ) : req.status === "approved" ? (
                        <div className="mt-3 space-y-2 border-t pt-3">
                          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                            The safe summary the buyer would receive (real data · never raw PKM):
                          </div>
                          <SharedDataPreview
                            userId={user?.uid}
                            vaultKey={vaultKey}
                            token={token}
                            domainKey={req.domainKey}
                            domainTitle={req.domainTitle}
                            topLevelScopePath={req.topLevelScopePath}
                            label={req.sliceName}
                            description={req.description}
                          />
                          <div className="text-[11px] text-muted-foreground">
                            Approved (demo). This is the actual projection that would be delivered;
                            encrypted per-buyer delivery and payment are the next phase.
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                          Denied — nothing was shared.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
                In-session demo · these requests are not real consent grants and clear on refresh. Real
                access requests live in your Consent Guardian; filing marketplace requests there (and
                payment settlement) is the next phase.
              </div>

              <div className="rounded-2xl border p-5">
                <div className="mb-3 text-sm font-medium">How a purchase flows</div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {[
                    { t: "1 · Buyer finds slice + price", now: false },
                    { t: "2 · Buyer requests access", now: true },
                    { t: "3 · Owner approves", now: true },
                    { t: "4 · Encrypted slice delivered to that buyer only", now: false },
                  ].map((step, i, arr) => (
                    <span key={step.t} className="flex items-center gap-2">
                      <span
                        className={
                          "rounded-full px-3 py-1.5 font-medium " +
                          (step.now ? "bg-foreground text-background" : "bg-muted text-muted-foreground")
                        }
                      >
                        {step.t}
                      </span>
                      {i < arr.length - 1 ? <span className="text-muted-foreground">→</span> : null}
                    </span>
                  ))}
                </div>
                <div className="mt-4 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
                  Step 3 is mandatory. Today’s app already enforces steps 2–4 via the Consent Guardian.
                  The storefront only adds step 1 (price + browse).
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {/* PURCHASE CONFIRM MODAL */}
      {purchaseSection ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPurchaseSection(null);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-xl">
            <div className="text-lg font-semibold">
              Purchase — {purchaseSection.permission.label}
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              You’re buying <span className="font-medium text-foreground">30-day scoped access</span> to the
              safe summary of{" "}
              <span className="font-medium text-foreground">{purchaseSection.permission.label}</span>. This
              files a request the owner must approve — nothing is shared until they say yes.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Consent-first by design. The request appears under{" "}
              <span className="font-medium text-foreground">Flow &amp; requests</span> (in-session demo). No
              money moves — payment settlement is a later phase.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="none"
                effect="fade"
                onClick={() => setPurchaseSection(null)}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" variant="none" effect="fade" onClick={confirmPurchase}>
                Confirm request
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* CONSENT-FIRST PUBLISH — owner explicitly consents before a section is
          listed on the marketplace. */}
      {confirmPublish ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmPublish(null);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-xl">
            <div className="text-lg font-semibold">
              Publish to the marketplace?
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              You’re consenting to list a{" "}
              <span className="font-medium text-foreground">safe summary</span> of{" "}
              <span className="font-medium text-foreground">{confirmPublish.permission.label}</span> so buyers
              can discover it and request access.
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              <li>• Only the safe summary is shared — never your raw data.</li>
              <li>• Every buyer still needs your approval before anything is delivered.</li>
              <li>• You can switch it back to “Ask first” or “Private” at any time.</li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="none"
                effect="fade"
                onClick={() => setConfirmPublish(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="none"
                effect="fade"
                onClick={() => {
                  const section = confirmPublish;
                  setConfirmPublish(null);
                  void runPosture(section, "default_available");
                }}
              >
                I consent — publish
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </PkmSettingsShell>
  );
}
