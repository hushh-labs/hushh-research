/** Shared encrypted `secrets.items` website-login format. Legacy Search Console
 * records keep their existing `value` and `credential` fields; no second store. */
export const WEBSITE_SECRET_ID = /^sec_[a-f0-9]{16}$/;
export type WebsiteCredentialItemV1 = Record<string, unknown> & {
  schema_version: 1;
  label: string;
  kind: "credential";
  pattern_id: "website_credential";
  file_to: "none";
  offer_noun: null;
  value: string;
  created_at: string;
  updated_at: string;
  credential: Record<string, unknown> & { title: string; origin: string; domain: string; url: string; username: string; notes?: string };
  bound_origins: string[];
  totp_secret?: string;
  stay_signed_in_enabled: boolean;
  revision: number;
  legacy_credential_id?: string;
};
export type WebsiteLoginInput = { label: string; boundOrigins: string[]; username: string; password: string;
  totpSecret?: string; notes?: string; staySignedInEnabled: boolean };
export type WebsiteLoginSummary = { id: string; label: string; boundOrigins: string[]; revision: number; updatedAt: string; staySignedInEnabled: boolean };
export class WebsiteCredentialError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WebsiteCredentialError"; }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function websiteOrigins(values: readonly string[]): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 16) throw new WebsiteCredentialError("WEBSITE_ORIGIN_INVALID");
  return [...new Set(values.map(value => {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value)) throw new WebsiteCredentialError("WEBSITE_ORIGIN_INVALID");
    let url: URL;
    try { url = new URL(value); } catch { throw new WebsiteCredentialError("WEBSITE_ORIGIN_INVALID"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.origin !== value.replace(/\/$/, "")) throw new WebsiteCredentialError("WEBSITE_ORIGIN_INVALID");
    return url.origin;
  }))];
}
export function websiteLoginInput(input: WebsiteLoginInput): WebsiteLoginInput {
  if (!input || typeof input.label !== "string" || !input.label.trim() || input.label.length > 128 ||
      typeof input.username !== "string" || input.username.length > 1024 || typeof input.password !== "string" ||
      !input.password || input.password.length > 8192 || typeof input.staySignedInEnabled !== "boolean" ||
      input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 4096) ||
      input.totpSecret !== undefined && (typeof input.totpSecret !== "string" || !/^[A-Z2-7]{16,128}$/.test(input.totpSecret))) {
    throw new WebsiteCredentialError("WEBSITE_LOGIN_INVALID");
  }
  if (input.label.includes(input.password) || input.totpSecret && input.label.includes(input.totpSecret)) throw new WebsiteCredentialError("WEBSITE_LABEL_INVALID");
  return { ...input, label: input.label.trim(), boundOrigins: websiteOrigins(input.boundOrigins) };
}
/** Legacy records are read in place; normalizing never writes or drops fields. */
export function parseWebsiteCredentialItem(id: string, value: unknown): WebsiteCredentialItemV1 | null {
  if (!WEBSITE_SECRET_ID.test(id) || !object(value) || value.pattern_id !== "website_credential" ||
    value.kind !== "credential" || !object(value.credential) || typeof value.value !== "string" || !value.value ||
    typeof value.credential.username !== "string" || typeof value.credential.origin !== "string" ||
    value.schema_version !== undefined && value.schema_version !== 1 ||
    value.stay_signed_in_enabled !== undefined && typeof value.stay_signed_in_enabled !== "boolean") return null;
  if (value.schema_version === 1 && (value.file_to !== "none" || value.offer_noun !== null ||
    !Array.isArray(value.bound_origins) || typeof value.stay_signed_in_enabled !== "boolean" ||
    !Number.isSafeInteger(value.revision) || typeof value.created_at !== "string" || typeof value.updated_at !== "string" ||
    typeof value.credential.title !== "string" || typeof value.credential.domain !== "string" || typeof value.credential.url !== "string")) return null;
  try {
    const origins = websiteOrigins(Array.isArray(value.bound_origins) ? value.bound_origins : [value.credential.origin]);
    if (!origins.includes(value.credential.origin)) return null;
    const input = websiteLoginInput({ label: String(value.label || value.credential.title || new URL(origins[0]!).hostname),
      username: value.credential.username, password: value.value, boundOrigins: origins,
      ...(value.totp_secret !== undefined ? { totpSecret: value.totp_secret as string } : {}),
      ...(typeof value.credential.notes === "string" ? { notes: value.credential.notes } : {}),
      staySignedInEnabled: value.stay_signed_in_enabled === true });
    const revision = value.revision === undefined ? 1 : value.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) return null;
    return { ...value, schema_version: 1, label: input.label, kind: "credential", pattern_id: "website_credential", file_to: "none", offer_noun: null,
      value: input.password, created_at: typeof value.created_at === "string" ? value.created_at : "", updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
      credential: { ...value.credential, title: typeof value.credential.title === "string" ? value.credential.title : input.label,
        origin: value.credential.origin, domain: new URL(value.credential.origin).hostname, url: typeof value.credential.url === "string" ? value.credential.url : value.credential.origin,
        username: input.username }, bound_origins: origins, stay_signed_in_enabled: input.staySignedInEnabled, revision: revision as number };
  } catch { return null; }
}
export function websiteCredentialSummary(id: string, item: WebsiteCredentialItemV1): WebsiteLoginSummary {
  return { id, label: item.label, boundOrigins: item.bound_origins, revision: item.revision, updatedAt: item.updated_at, staySignedInEnabled: item.stay_signed_in_enabled };
}

export function buildWebsiteCredentialItem(input: WebsiteLoginInput, existing?: WebsiteCredentialItemV1, now = new Date().toISOString()): WebsiteCredentialItemV1 {
  const checked = websiteLoginInput(input);
  const origin = checked.boundOrigins[0]!;
  let url = origin;
  try { if (existing?.credential.url && new URL(existing.credential.url).origin === origin) url = existing.credential.url; } catch { /* Preserve the selected origin when old URL metadata is malformed. */ }
  const item: WebsiteCredentialItemV1 = { ...existing, schema_version: 1, label: checked.label, kind: "credential", pattern_id: "website_credential", file_to: "none", offer_noun: null,
    value: checked.password, created_at: existing?.created_at || now, updated_at: now,
    credential: { ...existing?.credential, title: checked.label, origin, domain: new URL(origin).hostname, url, username: checked.username },
    bound_origins: checked.boundOrigins, stay_signed_in_enabled: checked.staySignedInEnabled, revision: (existing?.revision ?? 0) + 1 };
  if (checked.notes) item.credential.notes = checked.notes; else delete item.credential.notes;
  if (checked.totpSecret) item.totp_secret = checked.totpSecret; else delete item.totp_secret;
  return item;
}
