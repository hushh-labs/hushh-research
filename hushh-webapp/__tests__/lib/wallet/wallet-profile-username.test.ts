import { describe, expect, it } from "vitest";
import { validateWalletProfileUsername, walletProfileUsername } from "@/lib/wallet/wallet-profile-username";

describe("Wallet Profile username contract", () => {
  it.each([["Ankit Kumar Singh", "ankit.kumar.singh"], ["Élodie Martin", "elodie.martin"], ["李", "member"], ["Admin", "member"]])("generates %s as %s", (name, expected) => {
    expect(walletProfileUsername(name)).toBe(expected);
    expect(validateWalletProfileUsername(expected)).toBeNull();
  });
  it.each(["ab", "a".repeat(31), "Ankit", "user_name", ".name", "name.", "a..b", "user@domain.com", "sex", "s.e.x", "sex123", "user.porn", "admin", "support1", "<script>"])("rejects %s before saving", (value) => {
    expect(validateWalletProfileUsername(value)).not.toBeNull();
  });
});
