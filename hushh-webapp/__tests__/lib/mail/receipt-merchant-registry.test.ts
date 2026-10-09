import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isVerifiedReceiptLogoDomain,
  resolveVerifiedReceiptMerchant,
} from "@/lib/mail/receipt-merchant-registry";

describe("reviewed merchant registry", () => {
  it("covers many reviewed brands, not a short hard-coded few", () => {
    for (const [sender, name, logo] of [
      ["billing.supabase.io", "Supabase", "supabase.com"],
      ["mail.swiggy.in", "Swiggy", "swiggy.in"],
      ["updates.myntra.com", "Myntra", "myntra.com"],
      ["receipts.uber.com", "Uber", "uber.com"],
      ["mail.notion.so", "Notion", "notion.so"],
    ]) {
      expect(resolveVerifiedReceiptMerchant(sender)).toMatchObject({ displayName: name, logoDomain: logo });
      expect(isVerifiedReceiptLogoDomain(logo)).toBe(true);
    }
  });

  it("selects a brand from the sender domain only, never from look-alikes", () => {
    for (const sender of [
      "evil-amazon.com",
      "amazon.com.evil.example",
      "amazon.evil.example",
      "supabase.io.attacker.example",
      "xn--amazn-mwa.com",
      // A payment processor relays receipts for other merchants.
      "stripe.com",
      "",
      null,
    ]) {
      expect(resolveVerifiedReceiptMerchant(sender)).toBeNull();
    }
    // A logo is only ever looked up by a domain written in the reviewed file.
    for (const domain of ["evil.example", "https://amazon.com", "amazon.com/x", "stripe.com"]) {
      expect(isVerifiedReceiptLogoDomain(domain)).toBe(false);
    }
  });

  it("reads the same reviewed file as the backend, byte for byte", () => {
    const web = readFileSync(join(process.cwd(), "contracts/receipts/verified-merchants.v1.json"), "utf8");
    const backend = readFileSync(
      join(process.cwd(), "../consent-protocol/contracts/receipts/verified-merchants.v1.json"),
      "utf8",
    );
    const root = readFileSync(join(process.cwd(), "../contracts/receipts/verified-merchants.v1.json"), "utf8");
    expect(web.replace(/\r\n/g, "\n")).toBe(root.replace(/\r\n/g, "\n"));
    expect(backend.replace(/\r\n/g, "\n")).toBe(root.replace(/\r\n/g, "\n"));
  });
});
