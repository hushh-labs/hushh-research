import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, type WalletDemoProfile } from "@/components/wallet/wallet-demo-cards";

const { buildSvg } = vi.hoisted(() => ({ buildSvg: vi.fn() }));
vi.mock("@/lib/wallet/wallet-card-image", async () => ({
  ...await vi.importActual<typeof import("@/lib/wallet/wallet-card-image")>("@/lib/wallet/wallet-card-image"),
  buildWalletCardSvg: buildSvg,
}));

const profile: WalletDemoProfile = { ownerId: "owner-a", displayName: "Ankit Kumar Singh", cardPayload: { username: "ankit.kumar.singh" }, shareUrl: "https://one.hushh.ai/c/profile-token", referralUrl: "https://one.hushh.ai/r/referral-slug", memberSince: "2021-04-14T00:00:00.000Z", walletId: "wallet-1234abcd" };
function card(kind: string) { return WALLET_DEMO_CARDS.find((entry) => entry.cardId === `agent-one-${kind}`)!; }

beforeEach(() => {
  vi.clearAllMocks();
  buildSvg.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"/>');
  let generation = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => `blob:card-${++generation}`);
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Agent One cohesive card faces", () => {
  it("shows no live field or QR overlay before the complete card image is ready", async () => {
    const { container } = render(<WalletDemoCardFace summary={card("profile")} profile={profile} />);
    expect(container.querySelector("iframe")).toBeNull();
    const face = screen.getByTestId("wallet-card-face");
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const image = container.querySelector("img")!;
    expect(face).toHaveAttribute("data-artwork-ready", "false");
    expect(image).not.toBeVisible();
    expect(container.querySelector("dl")).toHaveClass("sr-only");
    expect(container.querySelector("[data-wallet-qr]")).toBeNull();
    await act(async () => { fireEvent.load(image); });
    expect(face).toHaveAttribute("data-artwork-ready", "true");
    expect(image).toBeVisible();
  });

  it("immediately hides a previous owner's image and ignores its late artwork completion", async () => {
    let finish!: (svg: string) => void;
    buildSvg.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const { rerender, container, unmount } = render(<WalletDemoCardFace summary={card("profile")} profile={profile} />);
    rerender(<WalletDemoCardFace summary={card("profile")} profile={{ ...profile, ownerId: "owner-b", cardPayload: { username: "new.owner" } }} />);
    await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", "blob:card-1"));
    await act(async () => { fireEvent.load(container.querySelector("img")!); });
    await act(async () => finish("<svg>old owner</svg>"));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(container.querySelector("dl")).toHaveTextContent("new.owner");
    rerender(<WalletDemoCardFace summary={card("profile")} profile={{ ...profile, shareUrl: "https://one.hushh.ai/c/rotated-token" }} />);
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-artwork-ready", "false");
    expect(container.querySelector('img[src="blob:card-1"]')).toBeNull();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:card-1");
  });

  it("keeps NWS sample semantics and sends the complete live identity into the same renderer", async () => {
    const { container } = render(<WalletDemoCardFace summary={card("nws")} profile={profile} />);
    await waitFor(() => expect(buildSvg).toHaveBeenCalledWith(expect.objectContaining({ kind: "nws", profile })));
    expect(screen.getByText("Sample NWS score: 900 out of 1000. This is not an evaluated net worth score.")).toHaveClass("sr-only");
    expect(container.querySelector("dl")).toHaveTextContent("ankit.kumar.singh");
    expect(container.querySelector("dl")).toHaveTextContent("2021");
    expect(container.querySelector("dl")).toHaveTextContent("1234ABCD");
  });
});
