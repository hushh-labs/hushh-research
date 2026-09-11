/** Compatibility level for vault writes, independent of the app release version. */
export const VAULT_WRITE_PROTOCOL_VERSION =
  String(process.env.NEXT_PUBLIC_VAULT_WRITE_PROTOCOL_VERSION || "").trim() ||
  "2.0.0";
