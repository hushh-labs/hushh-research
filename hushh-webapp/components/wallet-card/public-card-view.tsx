"use client";

/**
 * Public Wallet Profile card — the surface a stranger sees after scanning the
 * QR on someone's Hussh One Wallet pass.
 *
 * Design rules this file encodes (see the Wallet Card contract):
 * - The visitor has no account, no app, and may be on any device. Identity
 *   first, direct actions second, details last, readable in one screen.
 * - Render only the fields that are actually present. A missing field never
 *   produces an empty row, a dash, or a placeholder.
 * - Values arrive as plain strings and are rendered as text by React. No
 *   `dangerouslySetInnerHTML`, ever.
 * - The server already allowlists and validates `card_payload`; the helpers
 *   here re-validate on the client as defence in depth so a malformed or
 *   hostile projection can never produce a `javascript:` / `data:` link.
 * - No analytics: this module imports nothing from the observability layer.
 */

import { useCallback, useMemo, useState } from "react";
import {
  Briefcase,
  Download,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  Phone,
  type LucideIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the server-side `preferred_contact` closed set. */
export type WalletCardPreferredContact =
  | "email"
  | "phone"
  | "linkedin"
  | "website";

/**
 * The visitor-facing projection, already normalised and re-validated.
 * Every field is nullable because every shared field is optional.
 */
export interface PublicWalletCard {
  fullName: string | null;
  headline: string | null;
  organisation: string | null;
  locationLabel: string | null;
  summary: string | null;
  skills: readonly string[];
  email: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  github: string | null;
  portfolio: string | null;
  preferredContact: WalletCardPreferredContact | null;
  avatarUrl: string | null;
  updatedAt: string | null;
}

/** Length caps mirror the server allowlist so the client cannot render more. */
const MAX_LENGTHS = {
  fullName: 80,
  headline: 120,
  organisation: 80,
  locationLabel: 80,
  summary: 400,
  skill: 40,
  email: 254,
  phone: 32,
  url: 300,
  preferredContact: 16,
  avatarUrl: 2048,
  timestamp: 64,
} as const;

const MAX_SKILLS = 12;
const VCARD_LINE_LIMIT = 75;

const PREFERRED_CONTACTS: readonly WalletCardPreferredContact[] = [
  "email",
  "phone",
  "linkedin",
  "website",
];

// Deliberately conservative: no whitespace, no delimiters that let a value
// break out of a `mailto:` header, exactly one `@`, at least one dot label.
const EMAIL_SHAPE = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\.]+(?:\.[^\s@,;:<>"'\\.]+)+$/;
// Display shape only. The dial string is rebuilt from digits.
const PHONE_SHAPE = /^[+()\-.\s\d]{5,32}$/;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function pickString(
  source: UnknownRecord,
  keys: readonly string[],
  maxLength: number,
): string | null {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return trimmed.slice(0, maxLength);
  }
  return null;
}

/**
 * Accept only absolute `https://` URLs with no embedded credentials.
 * Anything else — `javascript:`, `data:`, `http:`, `user@host` forms,
 * protocol-relative or relative strings — resolves to null and is dropped.
 */
export function safeHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

export function safeEmail(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_LENGTHS.email) return null;
  return EMAIL_SHAPE.test(candidate) ? candidate : null;
}

export function safePhone(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (!PHONE_SHAPE.test(candidate)) return null;
  return candidate.replace(/\D/g, "").length >= 5 ? candidate : null;
}

/** Build a `tel:` target from digits only, keeping a leading `+` if present. */
export function telHref(phone: string): string {
  const trimmed = phone.trim();
  const prefix = trimmed.startsWith("+") ? "+" : "";
  return `tel:${prefix}${trimmed.replace(/\D/g, "")}`;
}

export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
}

function pickSkills(source: UnknownRecord): string[] {
  const raw = source.skills;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, MAX_LENGTHS.skill);
    if (!trimmed) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    skills.push(trimmed);
    if (skills.length >= MAX_SKILLS) break;
  }
  return skills;
}

function pickPreferredContact(
  source: UnknownRecord,
): WalletCardPreferredContact | null {
  const raw = pickString(
    source,
    ["preferredContact", "preferred_contact"],
    MAX_LENGTHS.preferredContact,
  );
  if (!raw) return null;
  const candidate = raw.toLowerCase();
  return (
    PREFERRED_CONTACTS.find((option) => option === candidate) ?? null
  );
}

/**
 * Normalise whatever the public resolve endpoint returned into the exact shape
 * this page renders.
 *
 * Accepts the projection either bare or wrapped (`{ card: … }` / `{ profile: … }`)
 * and tolerates both camelCase and snake_case keys, so a wire-format change on
 * the backend degrades to a missing field rather than a broken page.
 *
 * Returns null when there is nothing renderable — the caller treats that the
 * same way it treats a 404, so a stranger never sees an empty shell.
 */
export function normalizePublicWalletCard(
  raw: unknown,
): PublicWalletCard | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  const source =
    asRecord(envelope.card) ?? asRecord(envelope.profile) ?? envelope;

  const website = safeHttpsUrl(
    pickString(source, ["website"], MAX_LENGTHS.url),
  );
  const portfolioRaw = safeHttpsUrl(
    pickString(source, ["portfolio"], MAX_LENGTHS.url),
  );

  const card: PublicWalletCard = {
    fullName: pickString(
      source,
      ["fullName", "full_name", "displayName", "display_name"],
      MAX_LENGTHS.fullName,
    ),
    headline: pickString(source, ["headline"], MAX_LENGTHS.headline),
    organisation: pickString(
      source,
      ["organisation", "organization"],
      MAX_LENGTHS.organisation,
    ),
    locationLabel: pickString(
      source,
      ["locationLabel", "location_label"],
      MAX_LENGTHS.locationLabel,
    ),
    summary: pickString(source, ["summary"], MAX_LENGTHS.summary),
    skills: pickSkills(source),
    email: safeEmail(pickString(source, ["email"], MAX_LENGTHS.email)),
    phone: safePhone(pickString(source, ["phone"], MAX_LENGTHS.phone)),
    website,
    linkedin: safeHttpsUrl(
      pickString(source, ["linkedin"], MAX_LENGTHS.url),
    ),
    github: safeHttpsUrl(pickString(source, ["github"], MAX_LENGTHS.url)),
    // A portfolio identical to the website would render the same link twice.
    portfolio: portfolioRaw && portfolioRaw !== website ? portfolioRaw : null,
    preferredContact: pickPreferredContact(source),
    avatarUrl: safeHttpsUrl(
      pickString(
        source,
        ["avatarUrl", "avatar_url", "photoUrl", "photo_url"],
        MAX_LENGTHS.avatarUrl,
      ),
    ),
    updatedAt: pickString(
      source,
      ["updatedAt", "updated_at"],
      MAX_LENGTHS.timestamp,
    ),
  };

  return hasRenderableContent(card) ? card : null;
}

function hasRenderableContent(card: PublicWalletCard): boolean {
  return Boolean(
    card.fullName ||
      card.headline ||
      card.organisation ||
      card.summary ||
      card.email ||
      card.phone ||
      card.website ||
      card.linkedin ||
      card.github ||
      card.portfolio ||
      card.skills.length > 0,
  );
}

/* ------------------------------------------------------------------ vCard */

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 6350 line folding: continuation lines start with a single space. */
function foldVCardLine(line: string): string {
  if (line.length <= VCARD_LINE_LIMIT) return line;
  const parts: string[] = [line.slice(0, VCARD_LINE_LIMIT)];
  let index = VCARD_LINE_LIMIT;
  while (index < line.length) {
    parts.push(` ${line.slice(index, index + VCARD_LINE_LIMIT - 1)}`);
    index += VCARD_LINE_LIMIT - 1;
  }
  return parts.join("\r\n");
}

function splitName(fullName: string): { family: string; given: string } {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { family: "", given: "" };
  if (parts.length === 1) return { family: "", given: parts[0] ?? "" };
  return {
    family: parts[parts.length - 1] ?? "",
    given: parts.slice(0, -1).join(" "),
  };
}

/** Build the contact file from the projection. Client-side only, no network. */
export function buildVCard(card: PublicWalletCard): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];

  if (card.fullName) {
    const { family, given } = splitName(card.fullName);
    lines.push(
      `N:${escapeVCardValue(family)};${escapeVCardValue(given)};;;`,
      `FN:${escapeVCardValue(card.fullName)}`,
    );
  }
  if (card.headline) {
    lines.push(`TITLE:${escapeVCardValue(card.headline)}`);
  }
  if (card.organisation) {
    lines.push(`ORG:${escapeVCardValue(card.organisation)}`);
  }
  if (card.email) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(card.email)}`);
  }
  if (card.phone) {
    lines.push(`TEL;TYPE=CELL:${escapeVCardValue(card.phone)}`);
  }
  if (card.locationLabel) {
    lines.push(`ADR;TYPE=WORK:;;;${escapeVCardValue(card.locationLabel)};;;`);
  }
  const urls = [card.website, card.portfolio, card.linkedin, card.github];
  const seenUrls = new Set<string>();
  for (const url of urls) {
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    lines.push(`URL:${escapeVCardValue(url)}`);
  }
  if (card.summary) {
    lines.push(`NOTE:${escapeVCardValue(card.summary)}`);
  }
  lines.push("END:VCARD");

  return `${lines.map(foldVCardLine).join("\r\n")}\r\n`;
}

export function vCardFileName(card: PublicWalletCard): string {
  const slug = (card.fullName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "contact"}.vcf`;
}

/* ---------------------------------------------------------------- actions */

interface CardAction {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  external: boolean;
}

function buildActions(card: PublicWalletCard): CardAction[] {
  const actions: CardAction[] = [];
  if (card.email) {
    actions.push({
      id: "email",
      label: "Email",
      href: mailtoHref(card.email),
      icon: Mail,
      external: false,
    });
  }
  if (card.phone) {
    actions.push({
      id: "phone",
      label: "Call",
      href: telHref(card.phone),
      icon: Phone,
      external: false,
    });
  }
  if (card.linkedin) {
    actions.push({
      id: "linkedin",
      label: "LinkedIn",
      href: card.linkedin,
      icon: ExternalLink,
      external: true,
    });
  }
  if (card.github) {
    actions.push({
      id: "github",
      label: "GitHub",
      href: card.github,
      icon: ExternalLink,
      external: true,
    });
  }
  if (card.portfolio) {
    actions.push({
      id: "portfolio",
      label: "Portfolio",
      href: card.portfolio,
      icon: Globe,
      external: true,
    });
  }
  if (card.website) {
    actions.push({
      id: "website",
      label: "Website",
      href: card.website,
      icon: Globe,
      external: true,
    });
  }

  // The owner's preferred channel leads, so the visitor's first tap is the one
  // the owner actually wants. Everything else keeps its declared order.
  const preferred = card.preferredContact;
  if (!preferred) return actions;
  const preferredIndex = actions.findIndex((action) => action.id === preferred);
  if (preferredIndex <= 0) return actions;
  const [preferredAction] = actions.splice(preferredIndex, 1);
  return preferredAction ? [preferredAction, ...actions] : actions;
}

function initialsFor(fullName: string | null): string {
  if (!fullName) return "";
  const parts = fullName.split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

function formatUpdatedLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function ActionLink({
  action,
  emphasis,
}: {
  action: CardAction;
  emphasis: "primary" | "secondary";
}) {
  const Icon = action.icon;
  return (
    <Button
      asChild
      variant={emphasis === "primary" ? "default" : "outline"}
      className="h-12 w-full justify-start gap-3 px-4 text-[15px]"
    >
      <a
        href={action.href}
        {...(action.external
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        <Icon className="size-[18px]" aria-hidden="true" />
        <span className="truncate">{action.label}</span>
        {action.external ? (
          <span className="sr-only">(opens in a new tab)</span>
        ) : null}
      </a>
    </Button>
  );
}

/* ------------------------------------------------------------------- view */

export function PublicWalletCardView({ card }: { card: PublicWalletCard }) {
  const actions = useMemo(() => buildActions(card), [card]);
  const initials = useMemo(() => initialsFor(card.fullName), [card.fullName]);
  const updatedLabel = useMemo(
    () => formatUpdatedLabel(card.updatedAt),
    [card.updatedAt],
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSaveContact = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    try {
      const blob = new Blob([buildVCard(card)], {
        type: "text/vcard;charset=utf-8",
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = vCardFileName(card);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setSaveError(null);
    } catch {
      setSaveError(
        "We couldn't create the contact file. Use one of the links above instead.",
      );
    }
  }, [card]);

  const [primaryAction, ...secondaryActions] = actions;
  const hasDetails = Boolean(card.summary) || card.skills.length > 0;
  const hasMeta = Boolean(card.organisation) || Boolean(card.locationLabel);

  return (
    <article className="space-y-6 rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--shadow-xs)] sm:p-7">
      <header className="flex flex-col items-center gap-3 text-center">
        <Avatar className="size-20 border border-border/60 sm:size-24">
          {card.avatarUrl ? (
            <AvatarImage src={card.avatarUrl} alt="" />
          ) : null}
          <AvatarFallback className="text-xl font-medium">
            {initials || <Briefcase className="size-7" aria-hidden="true" />}
          </AvatarFallback>
        </Avatar>

        {card.fullName ? (
          <h1 className="break-words text-[26px] font-medium leading-[1.15] tracking-tight sm:text-[30px]">
            {card.fullName}
          </h1>
        ) : (
          <h1 className="sr-only">Shared profile</h1>
        )}

        {card.headline ? (
          <p className="break-words text-base leading-6 text-muted-foreground">
            {card.headline}
          </p>
        ) : null}

        {hasMeta ? (
          <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm leading-6 text-muted-foreground">
            {card.organisation ? (
              <span className="inline-flex items-center gap-1.5">
                <Briefcase className="size-3.5" aria-hidden="true" />
                {card.organisation}
              </span>
            ) : null}
            {card.locationLabel ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5" aria-hidden="true" />
                {card.locationLabel}
              </span>
            ) : null}
          </p>
        ) : null}
      </header>

      <section aria-labelledby="wallet-card-actions-heading" className="space-y-2">
        <h2 id="wallet-card-actions-heading" className="sr-only">
          Ways to get in touch
        </h2>

        {primaryAction ? (
          <ActionLink action={primaryAction} emphasis="primary" />
        ) : null}
        {secondaryActions.map((action) => (
          <ActionLink key={action.id} action={action} emphasis="secondary" />
        ))}

        <div className="space-y-1.5 pt-1">
          <Button
            type="button"
            variant="secondary"
            onClick={handleSaveContact}
            aria-describedby="wallet-card-save-hint"
            className="h-12 w-full justify-start gap-3 px-4 text-[15px]"
          >
            <Download className="size-[18px]" aria-hidden="true" />
            Save contact
          </Button>
          <p
            id="wallet-card-save-hint"
            className="px-1 text-xs leading-5 text-muted-foreground"
          >
            Downloads a contact file. On iPhone, open it and tap Create New
            Contact.
          </p>
          {saveError ? (
            <p role="alert" className="px-1 text-xs leading-5 text-destructive">
              {saveError}
            </p>
          ) : null}
        </div>
      </section>

      {hasDetails ? (
        <section aria-labelledby="wallet-card-details-heading" className="space-y-4">
          <h2 id="wallet-card-details-heading" className="sr-only">
            About
          </h2>
          {card.summary ? (
            <p className="break-words text-sm leading-6 text-foreground/90">
              {card.summary}
            </p>
          ) : null}
          {card.summary && card.skills.length > 0 ? <Separator /> : null}
          {card.skills.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {card.skills.map((skill) => (
                <li key={skill}>
                  <Badge variant="secondary" className="px-2.5 py-1 text-xs">
                    {skill}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <footer className="space-y-1 border-t border-border/60 pt-4 text-center text-xs leading-5 text-muted-foreground">
        <p>Shared from Hussh One</p>
        {updatedLabel ? <p>Updated {updatedLabel}</p> : null}
      </footer>
    </article>
  );
}

/** Cold-load placeholder. Matches the real card's rhythm to avoid a jump. */
export function PublicWalletCardSkeleton() {
  return (
    <div
      className="space-y-6 rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--shadow-xs)] sm:p-7"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading profile.</span>
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="size-20 rounded-full sm:size-24" />
        <Skeleton className="h-7 w-48 rounded-lg" />
        <Skeleton className="h-4 w-36 rounded-lg" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-12 w-full rounded-full" />
        <Skeleton className="h-12 w-full rounded-full" />
        <Skeleton className="h-12 w-full rounded-full" />
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}
