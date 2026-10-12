/** Profile labels are owner scoped; public access uses the opaque QR link. */
const RESERVED = new Set(["admin", "administrator", "support", "system", "hushh", "agentone"]);
const BLOCKED = new Set(["sex", "sexy", "porn", "porno", "pornhub", "xxx", "fuck", "fucker", "shit", "bitch", "cunt", "nigger", "nigga"]);

/** Mirror of one_wallet_card_username.py; the server remains authoritative. */
export function validateWalletProfileUsername(value: string): string | null {
  if (value.length < 3 || value.length > 30 || !/^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(value)) {
    return "Use 3–30 lowercase letters, numbers or single dots.";
  }
  const words = value.split(".").map((part) => part.replace(/[0-9]/g, ""));
  const compact = words.join("");
  if (RESERVED.has(compact) || BLOCKED.has(compact) || words.some((word) => BLOCKED.has(word))) {
    return "Choose another username.";
  }
  return null;
}

export function walletProfileUsername(name: string | null | undefined): string {
  const value = (name ?? "").normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")
    .slice(0, 30).replace(/\.+$/g, "");
  return validateWalletProfileUsername(value) ? "member" : value;
}
