import { isCurrentPersonExport } from "@/lib/consent/person-export-binding";
import { projectGrantPayload } from "@/lib/consent/project-grant-payload";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import {
  PersonProfileService,
  type InformationRequestBundle,
} from "@/lib/services/person-profile-service";

export type OpenedPersonInformation = {
  requestId: string;
  label: string;
  data: Record<string, unknown>;
};

/**
 * Open what another person approved for this requester, on this device only.
 *
 * The export was encrypted by the owner's browser to this person's connector
 * key; the private half of that key lives inside their own vault. Every step
 * re-reads the ledger, checks that the export still matches the approved item,
 * and re-checks the grant after decrypting, so a revocation mid-open wins. The
 * result stays in memory; nothing here writes or logs it.
 */
export async function openGrantedPersonInformation(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  bundleId: string;
  subjectRef: string;
  domainFor?: (requestId: string) => string | null | undefined;
  isCurrent?: () => boolean;
}): Promise<{ values: OpenedPersonInformation[]; expiresAtMs: number } | null> {
  const current = input.isCurrent ?? (() => true);
  const bundle = await PersonProfileService.getInformationRequest({
    bundleId: input.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (bundle.bundleId !== input.bundleId || bundle.personRef !== input.subjectRef) {
    throw new Error("Mismatched request");
  }
  const granted = bundle.items.filter((item) => item.status === "granted");
  if (!granted.length) throw new Error("No current grant");
  const connector = await OneKycClientZkService.readStoredConnector({
    userId: input.userId,
    vaultKey: input.vaultKey,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (!connector) throw new Error("Connection unavailable");
  const exports = await PersonProfileService.getInformationRequestExports({
    bundleId: bundle.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  const values: OpenedPersonInformation[] = [];
  let expiresAtMs = Number.MAX_SAFE_INTEGER;
  for (const item of granted) {
    const exact = exports.find((entry) => entry.requestId === item.requestId);
    if (!exact || !isCurrentPersonExport({
      item,
      scopeRef: exact.scopeRef,
      exportPackage: exact.encryptedExport,
      nowMs: Date.now(),
    })) {
      throw new Error("Export unavailable or changed");
    }
    const payload = await OneKycClientZkService.decryptScopedExport({
      exportPackage: exact.encryptedExport,
      connector,
    });
    if (!current()) return null;
    values.push({
      requestId: item.requestId,
      label: item.label,
      data: projectGrantPayload(payload, input.domainFor?.(item.requestId)),
    });
    expiresAtMs = Math.min(expiresAtMs, exact.encryptedExport.export_envelope.aad.expires_at_ms);
  }
  const latest = await PersonProfileService.getInformationRequest({
    bundleId: bundle.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (
    latest.bundleId !== bundle.bundleId ||
    latest.personRef !== input.subjectRef ||
    !values.every((value) =>
      latest.items.some((item) => item.requestId === value.requestId && item.status === "granted"),
    )
  ) {
    throw new Error("Grant changed while opening information");
  }
  return { values, expiresAtMs };
}

const MAX_SHARED_TEXT_CHARS = 12_000;

function humanKey(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function appendLines(lines: string[], value: unknown, path: string[]): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object" || entry === null);
    if (scalars.length === value.length) {
      lines.push(`- ${path.join(" > ")}: ${scalars.map(String).join(", ")}`);
      return;
    }
    value.forEach((entry, index) => appendLines(lines, entry, [...path, String(index + 1)]));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Internal bookkeeping keys are not part of what was shared.
      if (key.startsWith("_")) continue;
      appendLines(lines, entry, [...path, humanKey(key)]);
    }
    return;
  }
  lines.push(`- ${path.join(" > ")}: ${String(value)}`);
}

/**
 * The plain text One reads for the one follow-up turn: each approved item as
 * "Label > path: value" lines, bounded to the server's accepted size.
 */
export function formatSharedInformationForAgent(values: OpenedPersonInformation[]): string {
  const lines: string[] = [];
  for (const value of values) appendLines(lines, value.data, [value.label]);
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > MAX_SHARED_TEXT_CHARS) break;
    text = next;
  }
  return text;
}

export type ConsentOutcome = "granted" | "denied" | "expired";

export const CONSENT_OUTCOME_LABELS: Record<ConsentOutcome, string> = {
  granted: "Consent approved",
  denied: "Request declined",
  expired: "Request expired",
};

/** Mirrors the server's `bundle_outcome`: the one answer a chat reports. */
export function informationRequestOutcome(
  bundle: Pick<InformationRequestBundle, "items" | "cancelled">,
): ConsentOutcome | null {
  const statuses = bundle.items.map((item) => item.status);
  if (!statuses.length || bundle.cancelled || statuses.includes("pending")) return null;
  if (statuses.includes("granted")) return "granted";
  if (statuses.includes("denied")) return "denied";
  if (statuses.some((status) => status === "expired" || status === "revoked")) return "expired";
  return null;
}
