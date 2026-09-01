import type { MarketplaceInvestor } from "@/lib/services/ria-service";

export type MarketplaceEvidenceLink = {
  id: string;
  label: string;
  url: string;
};

export function marketplaceInvestorCardId(investor: MarketplaceInvestor): string {
  const explicitId = String(investor.id || "").trim();
  if (explicitId) return explicitId;

  const userId = marketplaceInvestorUserId(investor);
  if (userId) return userId;

  const publicProfileId = String(investor.public_profile_id || "").trim();
  if (publicProfileId) return `public_sec:${publicProfileId}`;

  return `investor:${String(investor.display_name || "unknown").trim().toLowerCase()}`;
}

export function marketplaceInvestorUserId(investor: MarketplaceInvestor): string | null {
  const userId = String(investor.user_id || "").trim();
  return userId || null;
}

export function isPublicSecMarketplaceInvestor(investor: MarketplaceInvestor): boolean {
  return String(investor.source_type || "").toLowerCase() === "public_sec";
}

export function isMarketplaceInvestorConnectable(investor: MarketplaceInvestor): boolean {
  if (isPublicSecMarketplaceInvestor(investor)) return false;
  if (investor.connectable === false) return false;
  return Boolean(marketplaceInvestorUserId(investor));
}

export function marketplaceInvestorActions(investor: MarketplaceInvestor): string[] {
  if (Array.isArray(investor.actions) && investor.actions.length > 0) {
    return investor.actions
      .map((action) => String(action || "").trim().toLowerCase())
      .filter(Boolean);
  }
  if (isPublicSecMarketplaceInvestor(investor)) return ["shortlist", "view_more"];
  if (isMarketplaceInvestorConnectable(investor)) return ["connect", "view_more"];
  return ["view_more"];
}

export function isMarketplaceInvestorShortlistable(investor: MarketplaceInvestor): boolean {
  return marketplaceInvestorActions(investor).includes("shortlist");
}

export function marketplaceInvestorActionTarget(investor: MarketplaceInvestor): {
  source_type: "public_sec" | "hushh_user";
  public_profile_id?: string | number | null;
  target_user_id?: string | null;
} {
  if (isPublicSecMarketplaceInvestor(investor)) {
    const publicProfileId = investor.public_profile_id ?? (
      String(investor.id || "").startsWith("public_sec:")
        ? String(investor.id).replace("public_sec:", "")
        : null
    );
    return {
      source_type: "public_sec",
      public_profile_id: publicProfileId,
      target_user_id: null,
    };
  }

  return {
    source_type: "hushh_user",
    public_profile_id: null,
    target_user_id: marketplaceInvestorUserId(investor),
  };
}

export function marketplaceInvestorSourceLabel(investor: MarketplaceInvestor): string | null {
  if (isPublicSecMarketplaceInvestor(investor)) return "Public SEC profile";
  if (String(investor.source_type || "").toLowerCase() === "hushh_user") {
    return "Qualified Hussh investor";
  }
  return null;
}

export function marketplaceInvestorCurationLabel(investor: MarketplaceInvestor): string | null {
  const tier = String(investor.curation_tier || "").trim().toLowerCase();
  if (tier === "showcase") return "Showcase";
  if (tier === "qualified") return "Qualified";
  return null;
}

const SEC_ACCESSION_PATTERN = /\b\d{10}-\d{2}-\d{6}\b/;
const SEC_ACCESSION_COMPACT_PATTERN = /\b\d{18}\b/;

function compactAccessionToDashed(value: string): string {
  return `${value.slice(0, 10)}-${value.slice(10, 12)}-${value.slice(12)}`;
}

function normalizeSecAccession(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text) return null;

  const dashed = text.match(SEC_ACCESSION_PATTERN)?.[0];
  if (dashed) return dashed;

  const compact = text.match(SEC_ACCESSION_COMPACT_PATTERN)?.[0];
  return compact ? compactAccessionToDashed(compact) : null;
}

function normalizeEvidenceUrl(value: unknown): string | null {
  const rawUrl = String(value || "").trim();
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function evidenceUrlParts(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function evidenceCikFromUrl(parsed: URL | null): string | null {
  if (!parsed) return null;

  const queryCik = parsed.searchParams.get("CIK");
  if (queryCik) return queryCik.trim() || null;

  const pathCik = parsed.pathname.match(/CIK(\d+)\.json$/i)?.[1];
  return pathCik || null;
}

function primaryEvidenceForm(
  forms?: Array<{ form?: string | null; last_filed_at?: string | null }>
): { form: string | null; lastFiledAt: string | null } {
  const first = Array.isArray(forms) ? forms[0] : null;
  return {
    form: String(first?.form || "").trim() || null,
    lastFiledAt: String(first?.last_filed_at || "").trim() || null,
  };
}

function evidenceLabel(params: {
  parsed: URL | null;
  url: string;
  forms?: Array<{ form?: string | null; last_filed_at?: string | null }>;
  fallbackIndex: number;
}): string {
  const { form, lastFiledAt } = primaryEvidenceForm(params.forms);
  const accession = normalizeSecAccession(params.url);
  if (accession) return form ? `SEC Form ${form} - ${accession}` : `SEC filing - ${accession}`;

  const host = params.parsed?.hostname.toLowerCase() || "";
  const path = params.parsed?.pathname || "";
  const cik = evidenceCikFromUrl(params.parsed);

  if (host === "data.sec.gov" && /\/submissions\/CIK\d+\.json$/i.test(path)) {
    return cik ? `SEC submissions - CIK ${cik}` : "SEC submissions";
  }

  if (host.endsWith("sec.gov") && path.toLowerCase().includes("/edgar/browse/")) {
    return cik ? `SEC company page - CIK ${cik}` : "SEC company page";
  }

  if (host.endsWith("sec.gov") && form) {
    return lastFiledAt ? `SEC Form ${form} - ${lastFiledAt}` : `SEC Form ${form}`;
  }

  return `SEC filing ${params.fallbackIndex}`;
}

function evidenceIdentity(url: string): string {
  const accession = normalizeSecAccession(url);
  if (accession) return `sec-accession:${accession}`;

  const normalizedUrl = normalizeEvidenceUrl(url);
  return `url:${normalizedUrl || url}`;
}

export function marketplaceInvestorEvidenceLinks(
  evidence: MarketplaceInvestor["evidence"],
  limit = 3
): MarketplaceEvidenceLink[] {
  const sourceUrls = Array.isArray(evidence?.source_urls) ? evidence.source_urls : [];
  const links: MarketplaceEvidenceLink[] = [];
  const seen = new Set<string>();

  for (const sourceUrl of sourceUrls) {
    const url = normalizeEvidenceUrl(sourceUrl);
    if (!url) continue;

    const id = evidenceIdentity(url);
    if (seen.has(id)) continue;

    seen.add(id);
    links.push({
      id,
      label: evidenceLabel({
        parsed: evidenceUrlParts(url),
        url,
        forms: evidence?.forms,
        fallbackIndex: links.length + 1,
      }),
      url,
    });

    if (links.length >= limit) break;
  }

  return links;
}
