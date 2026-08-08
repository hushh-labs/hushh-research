"use client";

/**
 * "From your SEC record." — the public regulatory facts behind a claimed
 * profile, rendered identically on the claim done-screen and the profile tab
 * so the two surfaces cannot drift.
 *
 * Accepts either the condensed claim facts (`RiaClaimProfileFacts`, what
 * /claim/complete returns) or the fuller persisted snapshot from
 * `ria_verification_events.reference_metadata` (`firm_record` /
 * `advisor_record`). Selected keys only: raw metadata is never dumped —
 * it carries the claimant's phone digits — and absent values omit their row
 * entirely rather than rendering "N/A".
 */

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import type { RiaClaimProfileFacts } from "@/lib/services/ria-service";

/** The adviser snapshot persisted at claim time (`advisor_record`). */
export interface RiaSecAdvisorRecord {
  crd?: number | string | null;
  registered_since?: string | null;
  exams?: { code?: string | null; name?: string | null; date?: string | null }[] | null;
  registered_states?: {
    state?: string | null;
    scope?: string | null;
    status?: string | null;
    date?: string | null;
  }[] | null;
  previous_firms?: {
    firm_name?: string | null;
    firm_crd?: number | null;
    from?: string | null;
    to?: string | null;
  }[] | null;
  branch?: {
    city?: string | null;
    state?: string | null;
    street1?: string | null;
    zip?: string | null;
  } | null;
  has_disclosures?: boolean | null;
  disclosure_count?: number | null;
  report_url?: string | null;
}

/** The firm snapshot persisted at claim time (`firm_record`). */
export interface RiaSecFirmRecord {
  crd?: number | string | null;
  name?: string | null;
  registration_status?: string | null;
  registration_type?: string | null;
  aum?: number | null;
  num_accounts?: number | null;
  total_employees?: number | null;
  advisory_employees?: number | null;
  registrations?: {
    jurisdiction?: string | null;
    status?: string | null;
    effective_date?: string | null;
  }[] | null;
  notice_filed_states?: string[] | null;
  form_adv_pdf_url?: string | null;
  form_crs_url?: string | null;
  brochures?: {
    name?: string | null;
    date_submitted?: string | null;
    url?: string | null;
  }[] | null;
  website?: string | null;
  report_url?: string | null;
}

export interface RiaSecRecordSectionProps {
  /** The condensed facts shape the claim done-screen already has. */
  facts?: RiaClaimProfileFacts | null;
  /** The fuller persisted snapshots; they win over `facts` where both exist. */
  advisorRecord?: RiaSecAdvisorRecord | null;
  firmRecord?: RiaSecFirmRecord | null;
  /** Rendered right of the caption — the verification chip lives here. */
  headerAccessory?: ReactNode;
}

export function formatAum(aum: number | null | undefined): string | null {
  if (!aum || aum <= 0) return null;
  if (aum >= 1_000_000_000) return `$${(aum / 1_000_000_000).toFixed(1)}B AUM`;
  if (aum >= 1_000_000) return `$${Math.round(aum / 1_000_000)}M AUM`;
  return `$${Math.round(aum / 1_000)}K AUM`;
}

export function titleCase(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const keepUpper = new Set(["llc", "lp", "llp", "pc", "pa", "ltd", "inc"]);
  return text
    .split(/\s+/)
    .map((word) => {
      const cleaned = word.replace(/[.,]+$/, "").toLowerCase();
      if (keepUpper.has(cleaned)) return word.toLowerCase().replace(cleaned, cleaned.toUpperCase());
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/** One labelled fact row, matching the review-card grammar. */
export function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4 border-t border-[color:var(--border)] px-4 py-2.5 first:border-t-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-right text-[15px] font-medium">{value}</span>
    </div>
  );
}

/** Regulator label from the firm's registration type ("sec" → SEC). */
function regulatorLabel(registrationType: string | null | undefined): string | null {
  if (!registrationType) return null;
  return registrationType === "sec" ? "SEC" : "State";
}

function advisorFromFacts(facts: RiaClaimProfileFacts): RiaSecAdvisorRecord {
  return {
    crd: facts.crd_number,
    registered_since: facts.registered_since,
    exams: facts.exams,
    registered_states: facts.registered_states,
    previous_firms: facts.previous_firms,
    branch:
      facts.branch_city || facts.branch_state
        ? { city: facts.branch_city, state: facts.branch_state }
        : null,
    has_disclosures: facts.has_disclosures,
    report_url: facts.report_url,
  };
}

function firmFromFacts(facts: RiaClaimProfileFacts): RiaSecFirmRecord {
  return {
    registration_status: facts.regulator_status,
    registration_type: facts.regulator === "SEC" ? "sec" : null,
    aum: facts.aum,
    num_accounts: facts.num_accounts,
    notice_filed_states: facts.notice_filed_states,
    website: facts.firm_website,
  };
}

/** Later sources fill only what earlier ones left empty. */
function mergeRecords<T extends object>(primary: T | null | undefined, fallback: T): T {
  const merged: Record<string, unknown> = { ...(fallback as Record<string, unknown>) };
  for (const [key, value] of Object.entries(primary ?? {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged as T;
}

type Row = { label: string; value: string };
type LinkItem = { label: string; href: string };

function truncatedList(values: string[], max = 3): string {
  return values.slice(0, max).join(", ") + (values.length > max ? "…" : "");
}

function buildRows(advisor: RiaSecAdvisorRecord, firmRecord: RiaSecFirmRecord): Row[] {
  const rows: Row[] = [];

  const crd = advisor.crd ?? firmRecord.crd;
  if (crd) rows.push({ label: "CRD", value: String(crd) });

  const regulator = regulatorLabel(firmRecord.registration_type);
  if (regulator || firmRecord.registration_status) {
    rows.push({
      label: "Regulator",
      value: [regulator, firmRecord.registration_status].filter(Boolean).join(" · "),
    });
  }
  if (advisor.registered_since) {
    rows.push({ label: "Registered since", value: advisor.registered_since });
  }

  const branch = advisor.branch ?? null;
  const office = [titleCase(branch?.city), branch?.state].filter(Boolean).join(", ");
  if (office) rows.push({ label: "Office", value: office });

  const aum = formatAum(firmRecord.aum);
  if (aum) rows.push({ label: "Firm assets", value: aum.replace(" AUM", "") });
  if (firmRecord.num_accounts) {
    rows.push({ label: "Accounts", value: firmRecord.num_accounts.toLocaleString() });
  }
  const employees = firmRecord.total_employees ?? firmRecord.advisory_employees;
  if (employees) rows.push({ label: "Employees", value: employees.toLocaleString() });

  const exams = (advisor.exams ?? []).map((e) => e.code).filter(Boolean) as string[];
  if (exams.length) rows.push({ label: "Exams", value: exams.join(", ") });

  const stateEntries = (advisor.registered_states ?? []).filter((s) => s.state);
  if (stateEntries.length) {
    const states = stateEntries.map((s) => String(s.state));
    const statuses = new Set(
      stateEntries.map((s) => String(s.status ?? "").trim()).filter(Boolean),
    );
    const uniformStatus = statuses.size === 1 ? titleCase([...statuses][0]) : null;
    rows.push({
      label: stateEntries.length === 1 ? "Registered in" : `Registered in ${stateEntries.length}`,
      value: [truncatedList(states), uniformStatus].filter(Boolean).join(" · "),
    });
  }

  const filed = firmRecord.notice_filed_states ?? [];
  if (filed.length) {
    rows.push({ label: `Notice filed in ${filed.length}`, value: truncatedList(filed) });
  }

  for (const registration of (firmRecord.registrations ?? []).slice(0, 3)) {
    if (!registration.jurisdiction) continue;
    const value = [titleCase(registration.status), registration.effective_date]
      .filter(Boolean)
      .join(" · ");
    if (!value) continue;
    rows.push({ label: String(registration.jurisdiction), value });
  }

  for (const prior of (advisor.previous_firms ?? []).slice(0, 3)) {
    if (!prior.firm_name) continue;
    const dates = [prior.from, prior.to].filter(Boolean).join("–");
    rows.push({
      label: "Previously",
      value: [titleCase(prior.firm_name), dates].filter(Boolean).join(" · "),
    });
  }

  if (advisor.has_disclosures) {
    rows.push({
      label: "Disclosures",
      value: advisor.disclosure_count ? String(advisor.disclosure_count) : "On record",
    });
  }

  return rows;
}

function buildLinks(advisor: RiaSecAdvisorRecord, firmRecord: RiaSecFirmRecord): LinkItem[] {
  const links: LinkItem[] = [];
  const reportUrl = advisor.report_url ?? firmRecord.report_url;
  if (reportUrl) links.push({ label: "View on adviserinfo.sec.gov", href: reportUrl });
  if (firmRecord.form_adv_pdf_url) links.push({ label: "Form ADV", href: firmRecord.form_adv_pdf_url });
  if (firmRecord.form_crs_url) links.push({ label: "Form CRS", href: firmRecord.form_crs_url });
  for (const brochure of (firmRecord.brochures ?? []).slice(0, 3)) {
    if (!brochure.url) continue;
    links.push({ label: titleCase(brochure.name) || "Brochure", href: brochure.url });
  }
  if (firmRecord.website) links.push({ label: "Website", href: firmRecord.website });
  return links;
}

/** What the regulator publishes, filled in without asking the adviser. */
export function RiaSecRecordSection({
  facts,
  advisorRecord,
  firmRecord,
  headerAccessory,
}: RiaSecRecordSectionProps) {
  const advisor = mergeRecords(advisorRecord, facts ? advisorFromFacts(facts) : {});
  const firm = mergeRecords(firmRecord, facts ? firmFromFacts(facts) : {});
  const rows = buildRows(advisor, firm);
  const links = buildLinks(advisor, firm);
  if (!rows.length) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">From your SEC record.</p>
        {headerAccessory ?? null}
      </div>
      <div className="overflow-hidden rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)] shadow-[0_8px_24px_rgba(62,48,30,0.05)]">
        {rows.map((row, index) => (
          <FactRow key={`${row.label}-${index}`} label={row.label} value={row.value} />
        ))}
      </div>
      {links.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {links.map((link, index) => (
            <a
              key={`${link.label}-${index}`}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--app-accent)]"
            >
              {link.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
