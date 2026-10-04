/** Compatibility level for vault writes, independent of the app release version. */
export const VAULT_WRITE_PROTOCOL_VERSION =
  String(process.env.NEXT_PUBLIC_VAULT_WRITE_PROTOCOL_VERSION || "").trim() ||
  "2.0.0";

/**
 * The level a PKM request reports to the reserved-branch registry, or null when
 * an override is not semver (the server would refuse a malformed one, and
 * omitting it reads as an older client). One value for the mutation plan's
 * `client_version` and the `x-hushh-client-version` header on the PKM upgrade
 * and metadata routes, so the two can never disagree.
 */
export const PKM_CLIENT_VERSION: string | null = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(
  VAULT_WRITE_PROTOCOL_VERSION
)
  ? VAULT_WRITE_PROTOCOL_VERSION
  : null;

/**
 * Header for the PKM upgrade and metadata routes. Builds before the migration
 * release never sent it there, which is how the server keeps them off the
 * reserved-branch relocation they cannot perform.
 */
export function pkmClientVersionHeaders(): Record<string, string> {
  return PKM_CLIENT_VERSION ? { "x-hushh-client-version": PKM_CLIENT_VERSION } : {};
}
