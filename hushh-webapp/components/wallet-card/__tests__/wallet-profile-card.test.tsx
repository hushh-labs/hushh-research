import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletProfileCard } from "../wallet-profile-card";
import { authorizedWalletProfileUrl, walletProfilePresentation } from "@/components/wallet-card/wallet-profile-presentation";
import { decodePayload } from "./qr-code-test-decoder";

const url = `https://one.hushh.ai/c/${"a".repeat(43)}`;

describe("Wallet profile presentation", () => {
  it("uses only approved fields and never infers verification from account details", () => {
    const model = walletProfilePresentation({ displayName: "Ada", cardPayload: { email: "ada@example.com", phone: "+1 202 555 0142", organisation: "Analytical Engine", headline: "Engineer" }, shareUrl: url });
    const html = renderToStaticMarkup(<WalletProfileCard profile={model} />);
    for (const value of ["Ada", "ada@example.com", "+1 202 555 0142", "Analytical Engine", "Engineer", "Scan to connect"]) expect(html).toContain(value);
    expect(html).not.toContain("Verified by Hushh");
    const document = new DOMParser().parseFromString(html, "text/html");
    const svg = document.querySelector('svg[aria-label="Profile QR code: Scan to connect"]')!;
    const size = Number(svg.getAttribute("viewBox")!.split(" ")[2]) - 8;
    const modules = new Uint8Array(size * size);
    for (const rect of svg.querySelectorAll("g rect")) {
      const x = Number(rect.getAttribute("x")) - 4;
      const y = Number(rect.getAttribute("y")) - 4;
      const width = Number(rect.getAttribute("width"));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(size);
      for (let offset = 0; offset < width; offset++) modules[y * size + x + offset] = 1;
    }
    expect(decodePayload({ size, modules })).toBe(url);
    expect(model.authorizedProfileUrl).not.toContain(model.email);
  });
  it("omits absent fields and an unavailable QR without inventing details", () => {
    const html = renderToStaticMarkup(<WalletProfileCard profile={walletProfilePresentation()} />);
    expect(html).toContain("Your profile");
    expect(html).not.toContain("Scan to connect");
    expect(html).not.toContain("Email");
    expect(html).not.toContain("Verified by Hushh");
  });
  it.each(["unknown", "unverified", "verified"] as const)("renders the verification state %s accurately", verification => {
    const html = renderToStaticMarkup(<WalletProfileCard profile={{ ...walletProfilePresentation(), verification }} />);
    expect(html.includes("Verified by Hushh")).toBe(verification === "verified");
  });
  it.each(["javascript:alert(1)", `${url}?email=ada@example.com`, `${url}#token=secret`, "https://one.hushh.ai/c/ada@example.com", "https://user:password@one.hushh.ai/c/" + "a".repeat(43), "https://one.hushh.ai/profile"])("omits unsafe QR destination %s", value => {
    expect(authorizedWalletProfileUrl(value)).toBeNull();
  });
  it("preserves long names and optional fields in the expanded presentation", () => {
    const name = "Alexandra ".repeat(8).trim();
    const profile = walletProfilePresentation({ cardPayload: { full_name: name, organisation: "Organization ".repeat(6).trim(), email: "", phone: "", headline: " " } });
    const html = renderToStaticMarkup(<WalletProfileCard profile={profile} />);
    expect(html).toContain(name);
    expect(profile.email).toBeNull();
    expect(profile.phone).toBeNull();
    expect(profile.professionalTitle).toBeNull();
    expect(profile.avatarUrl).toBeNull();
  });
});
