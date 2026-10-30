import { z } from "zod";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { overviewFacts } from "@/components/kai/views/portfolio-display-facts";
import { isCashEquivalentHolding } from "@/lib/kai/holding-validation";
import type { RecipientPayloadEnvelope } from "@/lib/one-location/encryption";

export const financeSections = ["allocation", "performance", "holdings", "note"] as const;
export type FinanceSection = typeof financeSections[number];
export type FinanceSelection = { sections: FinanceSection[]; holdingSymbols: string[]; showAmounts: boolean; note: string };
export type FinanceSource = { kind: "statement" | "plaid"; snapshotId: string | null; representation?: "current-v7" };
export type FinancePolicyV1 = {
  version: 1; mode: "snapshot" | "ongoing"; sections: FinanceSection[]; selectionHash: string;
  showAmounts: boolean; model_processing: { version: 1; allowed: boolean }; durationSeconds: 3600 | 86400 | 604800 | null;
};
export type FinancePolicyV2 = {
  version: 2; purpose: "verified_ria_review"; mode: "snapshot" | "ongoing"; sections: FinanceSection[]; selectionHash: string;
  showAmounts: true; model_processing: { version: 1; allowed: false }; durationSeconds: 3600 | 86400 | 604800 | null;
};
export type FinancePolicy = FinancePolicyV1 | FinancePolicyV2;
export type FinancePolicyInput = Omit<FinancePolicyV1, "selectionHash"> | Omit<FinancePolicyV2, "selectionHash">;
export type FinanceGrant = {
  id: string; requestId: string; ownerUserId: string; recipientUserId: string; recipientPersonRef: string; recipientKeyId: string;
  senderName: string; recipientName: string; policy: FinancePolicy; revision: number; contentHash: string;
  createdAt: string; updatedAt: string; expiresAt: string | null; serverNow: string;
  status: "active" | "expired" | "stopped"; direction: "outgoing" | "received";
  envelope?: RecipientPayloadEnvelope; ownerConfig?: RecipientPayloadEnvelope;
};
export type FinanceOwnerConfig = { source: FinanceSource; sourceFence: string; selection: FinanceSelection; commitmentNonce?: string };

const hexHash = z.string().regex(/^[a-f0-9]{64}$/);
export const financeOwnerConfigSchema = z.object({
  source: z.object({ kind: z.enum(["statement", "plaid"]), snapshotId: z.string().max(300).nullable(), representation: z.literal("current-v7").optional() }).strict(),
  sourceFence: hexHash,
  selection: z.object({ sections: z.array(z.enum(financeSections)).min(1).max(4), holdingSymbols: z.array(z.string().regex(/^[A-Z0-9.^-]{1,16}$/)).max(100), showAmounts: z.boolean(), note: z.string().max(1000) }).strict(),
  commitmentNonce: hexHash.optional(),
}).strict();
const recipientEnvelopeSchema = z.object({
  algorithm: z.literal("ECDH-P256-AES256-GCM"), recipientKeyId: z.string().min(1).max(160), ciphertext: z.string().min(24).max(180000).regex(/^[A-Za-z0-9_-]+$/), iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  senderEphemeralPublicKeyJwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ext: z.literal(true).optional(), key_ops: z.array(z.string()).length(0).optional() }).strict(),
}).strict();
const financePolicyV1Schema = z.object({
  version: z.literal(1), mode: z.enum(["snapshot", "ongoing"]), sections: z.array(z.enum(financeSections)).min(1).max(4), selectionHash: hexHash,
  showAmounts: z.boolean(), model_processing: z.object({ version: z.literal(1), allowed: z.boolean() }).strict(),
  durationSeconds: z.union([z.literal(3600), z.literal(86400), z.literal(604800), z.null()]),
}).strict().refine(p => new Set(p.sections).size === p.sections.length && (p.mode !== "snapshot" || p.durationSeconds !== null));
const financePolicyV2Schema = z.object({
  version: z.literal(2), purpose: z.literal("verified_ria_review"), mode: z.enum(["snapshot", "ongoing"]),
  sections: z.array(z.enum(financeSections)).length(3), selectionHash: hexHash,
  showAmounts: z.literal(true), model_processing: z.object({ version: z.literal(1), allowed: z.literal(false) }).strict(),
  durationSeconds: z.union([z.literal(3600), z.literal(86400), z.literal(604800), z.null()]),
}).strict().refine(p => (p.mode !== "snapshot" || p.durationSeconds !== null) && new Set(p.sections).size === 3 && ["allocation", "performance", "holdings"].every(s => p.sections.includes(s as FinanceSection)));
export const financePolicySchema = z.union([financePolicyV1Schema, financePolicyV2Schema]);
export const financeGrantSchema = z.object({
  id: z.string().uuid(), requestId: z.string().uuid(), ownerUserId: z.string().min(1).max(160), recipientUserId: z.string().min(1).max(160), recipientPersonRef: z.string().uuid(), recipientKeyId: z.string().min(1).max(160),
  senderName: z.string().max(300), recipientName: z.string().max(300), policy: financePolicySchema, revision: z.number().int().positive(), contentHash: hexHash,
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }).nullable(), serverNow: z.string().datetime({ offset: true }),
  status: z.enum(["active", "expired", "stopped"]), direction: z.enum(["outgoing", "received"]), envelope: recipientEnvelopeSchema.optional(), ownerConfig: recipientEnvelopeSchema.nullable().optional(),
}).strict();
export const financeHistorySchema = z.object({ items: z.array(financeGrantSchema).max(50), nextCursor: z.string().uuid().nullable() }).strict();

const finite = z.number().finite();
const money = z.object({ value: finite, currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const observation = z.object({ date: z.string().max(40), value: finite }).strict();
const financeProjectionV1Schema = z.object({
  schema: z.literal("finance-share-v1"),
  source: z.enum(["statement", "plaid"]),
  sourcePeriod: z.string().max(100).nullable(),
  allocation: z.array(z.object({ name: z.string().max(160), percent: finite, amount: money.optional() }).strict()).max(100).optional(),
  sectors: z.array(z.object({ name: z.string().max(160), percent: finite, amount: money.optional() }).strict()).max(100).optional(),
  performance: z.object({
    balanceChangePct: finite.nullable(), unit: z.enum(["percent", "USD"]),
    history: z.array(observation).max(366), total: money.optional(),
  }).strict().optional(),
  holdings: z.array(z.object({
    symbol: z.string().regex(/^[A-Z0-9.^-]{1,16}$/), name: z.string().max(160), weightPct: finite,
    amount: money.optional(), quantity: finite.optional(), price: money.optional(),
    gainLoss: money.nullable().optional(), gainLossPct: finite.nullable(),
  }).strict()).max(100).optional(),
  note: z.string().max(1000).optional(),
  commitmentNonce: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const financeProjectionV2Schema = financeProjectionV1Schema.extend({
  schema: z.literal("finance-share-v2"),
  cashBalance: money.nullable(),
  holdings: z.array(z.object({
    symbol: z.string().max(160), name: z.string().max(160), weightPct: finite,
    amount: money, quantity: finite.optional(), price: money.optional(), costBasis: money.optional(), gainLoss: money.optional(),
    assetType: z.string().max(160).optional(), sector: z.string().max(160).optional(),
    gainLossPct: finite.nullable(), isCashEquivalent: z.boolean(),
  }).strict()).max(100),
});
export const financeProjectionSchema = z.discriminatedUnion("schema", [financeProjectionV1Schema, financeProjectionV2Schema]);
export type FinanceProjection = z.infer<typeof financeProjectionSchema>;

/** Keep low-entropy financial figures out of guessable server-side digests. */
function commitmentNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}
export function committedFinanceProjection(projection: FinanceProjection, policy: FinancePolicy): FinanceProjection {
  return readFinanceProjection({ ...projection, commitmentNonce: commitmentNonce() }, policy);
}
export function committedFinanceConfig(config: FinanceOwnerConfig): FinanceOwnerConfig {
  const { selection } = config;
  return financeOwnerConfigSchema.parse({
    source: config.source, sourceFence: config.sourceFence,
    selection: {
      sections: selection.sections,
      holdingSymbols: selection.sections.includes("holdings") ? [...new Set(selection.holdingSymbols)].sort() : [],
      showAmounts: selection.showAmounts,
      note: selection.sections.includes("note") ? selection.note.trim() : "",
    },
    commitmentNonce: commitmentNonce(),
  });
}
export function financeInformation(projection: FinanceProjection): Omit<FinanceProjection, "commitmentNonce"> {
  const { commitmentNonce: _nonce, ...information } = projection;
  return information;
}

export async function financeDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}

export const financeContext = (g: Pick<FinanceGrant, "requestId" | "id" | "ownerUserId" | "recipientUserId" | "policy" | "revision">) => JSON.stringify([
  g.policy.version === 2 ? "finance-share-v2:verified_ria_review" : "finance-share-v1", g.requestId, g.id, g.ownerUserId, g.recipientUserId, g.policy.mode,
  [...g.policy.sections].sort(), g.policy.selectionHash, g.policy.showAmounts,
  g.policy.model_processing.allowed, g.policy.durationSeconds, g.revision,
]);
export const financeConfigContext = (owner: string, requestId: string) => JSON.stringify(["finance-share-config-v1", owner, requestId]);
export const financeReference = (content: string) => /^\[finance-share:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]$/i.exec(content)?.[1] ?? null;

/** Construct from named fields only. Raw records and source identifiers never enter the export. */
export function projectFinance(model: DashboardViewModel, selection: FinanceSelection, source: FinanceSource): FinanceProjection {
  const selected = new Set(selection.sections);
  if (!selected.size) throw new Error("Choose at least one section.");
  const total = model.canonicalModel.totals.marketValue;
  const amount = (value: number) => ({ value, currency: "USD" });
  const projection: FinanceProjection = { schema: "finance-share-v1", source: source.kind, sourcePeriod: model.hero.statementPeriod ?? null };
  if (selected.has("allocation")) {
    projection.allocation = model.canonicalModel.allocation.map(row => ({ name: row.label, percent: row.pct,
      ...(selection.showAmounts ? { amount: amount(row.value) } : {}) }));
    projection.sectors = model.equity_sector_allocation.map(row => ({ name: row.sector, percent: row.pct,
      ...(selection.showAmounts ? { amount: amount(row.value) } : {}) }));
  }
  if (selected.has("performance")) {
    const history = model.quality.historyReady ? model.history : [];
    const base = history[0]?.value;
    const usable = typeof base === "number" && base > 0;
    // Percent-only projections contain rebased observations, never dollar values.
    projection.performance = {
      balanceChangePct: usable && history.length >= 2 ? (history[history.length - 1]!.value / base - 1) * 100 : null,
      unit: selection.showAmounts ? "USD" : "percent",
      history: usable ? history.map(row => ({ date: row.date, value: selection.showAmounts ? row.value : (row.value / base - 1) * 100 })) : [],
      ...(selection.showAmounts ? { total: amount(total) } : {}),
    };
  }
  if (selected.has("holdings")) {
    const wanted = new Set(selection.holdingSymbols);
    if (!wanted.size || wanted.size > 100) throw new Error("Choose between 1 and 100 stocks.");
    const positions = model.canonicalModel.positions.filter(p => p.tickerSymbol && wanted.has(p.tickerSymbol) && p.identifierType === "ticker");
    if (new Set(positions.map(p => p.tickerSymbol)).size !== wanted.size) throw new Error("A selected stock is no longer available. Review your selection.");
    projection.holdings = [...wanted].sort().map(symbol => {
      const entries = positions.filter(p => p.tickerSymbol === symbol);
      const value = entries.reduce((sum, p) => sum + p.marketValue, 0);
      const cost = entries.reduce((sum, p) => sum + p.costBasis, 0);
      const gain = entries.every(p => p.gainLoss !== null) ? entries.reduce((sum, p) => sum + p.gainLoss!, 0) : null;
      return { symbol, name: entries[0]!.name, weightPct: total > 0 ? value / total * 100 : 0,
        gainLossPct: gain !== null && entries.every(p => p.costBasis > 0) && cost > 0 ? gain / cost * 100 : null,
        ...(selection.showAmounts ? { amount: amount(value), gainLoss: gain === null ? null : amount(gain) } : {}) };
    });
  }
  if (selected.has("note")) projection.note = selection.note.trim();
  return financeProjectionSchema.parse(projection);
}

/** A bounded, explicit snapshot; never include account identifiers or raw source records. */
export function projectAdvisorFinance(model: DashboardViewModel, portfolio: PortfolioData, source: FinanceSource): FinanceProjection {
  const positions = portfolio.holdings || [];
  if (positions.length > 100) throw new Error("This portfolio cannot be shared in full. Advisor review supports up to 100 positions.");
  if (!positions.length) {
    const cash = portfolio.account_summary?.cash_balance ?? portfolio.cash_balance;
    const total = portfolio.total_value ?? portfolio.account_summary?.ending_value;
    if (typeof cash !== "number" || !Number.isFinite(cash) || cash < 0 || (total != null && total !== cash)) {
      throw new Error("This source has no complete, shareable cash balance.");
    }
  }
  // The dashboard model clamps some negative values and can drop unnamed rows.
  // Refuse unsupported entries rather than present a partial view as complete.
  for (const p of positions) {
    const numberFields = [p.market_value, p.quantity, p.price, p.cost_basis];
    const side = String(p.position_side || "").trim().toLowerCase();
    if ((!String(p.name || "").trim() && !String(p.symbol || "").trim())
      || p.is_short || p.is_short_position || p.is_liability_position || (side !== "" && side !== "long")
      || typeof p.market_value !== "number" || !Number.isFinite(p.market_value) || p.market_value < 0
      || numberFields.some(v => v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0))) {
      throw new Error("This portfolio includes a position that cannot be shared accurately. Advisor review is unavailable for this source.");
    }
  }
  const base = projectFinance(model, { sections: ["allocation", "performance"], holdingSymbols: [], showAmounts: true, note: "" }, source);
  const total = model.hero.totalValue;
  const cash = overviewFacts(model, portfolio).cash;
  return financeProjectionV2Schema.parse({ ...base, schema: "finance-share-v2", cashBalance: cash === null ? null : { value: cash, currency: "USD" },
    holdings: positions.map(p => ({ symbol: String(p.symbol || "").trim(), name: String(p.name || p.symbol).trim(),
      weightPct: total > 0 ? p.market_value / total * 100 : 0, amount: { value: p.market_value, currency: "USD" },
      ...(typeof p.quantity === "number" ? { quantity: p.quantity } : {}),
      ...(typeof p.price === "number" ? { price: { value: p.price, currency: "USD" } } : {}),
      ...(typeof p.cost_basis === "number" ? { costBasis: { value: p.cost_basis, currency: "USD" } } : {}),
      ...(typeof p.unrealized_gain_loss === "number" && Number.isFinite(p.unrealized_gain_loss) ? { gainLoss: { value: p.unrealized_gain_loss, currency: "USD" } } : {}),
      ...(p.asset_type || p.asset_class ? { assetType: String(p.asset_type || p.asset_class) } : {}),
      ...(p.sector ? { sector: String(p.sector) } : {}),
      gainLossPct: typeof p.unrealized_gain_loss_pct === "number" && Number.isFinite(p.unrealized_gain_loss_pct) ? p.unrealized_gain_loss_pct : null,
      isCashEquivalent: isCashEquivalentHolding(p) })) });
}

/** Validate decrypted contents against the approved fields before rendering or model use. */
export function readFinanceProjection(value: unknown, policy: FinancePolicy): FinanceProjection {
  const p = financeProjectionSchema.parse(value);
  if ((policy.version === 2) !== (p.schema === "finance-share-v2")) throw new Error("Shared information does not match the approval.");
  const selected = new Set(policy.sections);
  for (const field of ["allocation", "performance", "holdings", "note"] as const) {
    if ((p[field] !== undefined) !== selected.has(field)) throw new Error("Shared sections do not match the approval.");
  }
  if (p.sectors && !selected.has("allocation")) throw new Error("Unapproved sectors.");
  if (!policy.showAmounts && (p.allocation?.some(r => r.amount) || p.sectors?.some(r => r.amount)
    || p.performance?.total || (p.performance && p.performance.unit !== "percent")
    || p.holdings?.some(r => r.amount || ("price" in r && r.price) || ("quantity" in r && r.quantity !== undefined) || ("gainLoss" in r && r.gainLoss !== undefined)))) {
    throw new Error("Unapproved amounts.");
  }
  return p;
}
