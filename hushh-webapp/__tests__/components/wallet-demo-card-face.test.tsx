import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, type WalletDemoProfile } from "@/components/wallet/wallet-demo-cards";

vi.mock("@/components/wallet-card/wallet-card-qr", () => ({
  WalletCardQr: ({ value, label }: { value: string; label: string }) => <span role="img" aria-label={label} data-qr-value={value} />,
}));

const profile: WalletDemoProfile = {
  displayName: "Ankit Kumar Singh",
  cardPayload: { username: "ankit.kumar.singh" },
  shareUrl: "https://one.hushh.ai/c/profile-token",
  referralUrl: "https://one.hushh.ai/r/referral-slug",
  memberSince: "2021-04-14T00:00:00.000Z",
  walletId: "wallet-1234abcd",
};

function card(kind: string) {
  return WALLET_DEMO_CARDS.find((entry) => entry.cardId === `agent-one-${kind}`)!;
}

describe("Agent One card faces", () => {
  it("keeps the sample NWS face free of QR controls and uses live owner fields", () => {
    const { container } = render(<WalletDemoCardFace summary={card("nws")} profile={profile} />);
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByLabelText("QR unavailable")).toBeNull();
    expect(screen.getByText("Sample NWS score: 900 out of 1000. This is not an evaluated net worth score.")).toHaveClass("sr-only");
    expect(container.querySelector("iframe")).toHaveAttribute("src", "/wallet/agent-one-card-nws.html?v=5");
    const identity = container.querySelector("dl")!;
    expect(identity).toHaveTextContent("ankit.kumar.singh");
    expect(identity).toHaveTextContent("2021");
    expect(identity).toHaveTextContent("1234ABCD");
  });

  it("preserves the distinct live QR and approved artwork on Profile and Referral", () => {
    const { rerender, container } = render(<WalletDemoCardFace summary={card("profile")} profile={profile} />);
    expect(screen.getByRole("img", { name: "Agent One Profile QR code" })).toHaveAttribute("data-qr-value", profile.shareUrl);
    expect(container.querySelector("iframe")).toHaveAttribute("src", "/wallet/agent-one-card-profile.html?v=4");
    rerender(<WalletDemoCardFace summary={card("referral")} profile={profile} />);
    expect(screen.getByRole("img", { name: "Agent One Referral QR code" })).toHaveAttribute("data-qr-value", profile.referralUrl);
    expect(container.querySelector("iframe")).toHaveAttribute("src", "/wallet/agent-one-card-referral.html?v=4");
  });

  it("ships the requested 900/1000 NWS sample in the supplied score layout", () => {
    const html = readFileSync(join(process.cwd(), "public/wallet/agent-one-card-nws.html"), "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    const artwork = document.querySelector("article.nws")!;
    const score = artwork.querySelector("text.score")!;
    expect(score.textContent).toBe("900");
    expect(score.getAttribute("x")).toBe("98");
    expect(score.getAttribute("y")).toBe("382");
    expect(score.getAttribute("font-size")).toBe("150");
    expect(artwork.textContent).toContain("NET WORTH SCORE");
    expect(artwork.textContent).toContain("/1000");
    expect(artwork.textContent).not.toContain("Not available yet");
    expect(artwork.querySelector("desc")?.textContent).toContain("sample score of 900 out of 1000");
  });
});
