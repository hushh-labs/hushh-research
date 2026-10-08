import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { WalletAddCollection } from "@/components/wallet/wallet-add-collection";
import { WALLET_DEMO_CARDS, WalletDemoCardDetails, WalletDemoCardFace } from "@/components/wallet/wallet-demo-cards";
import {
  EMPTY_WALLET_CARD_IDENTITY,
  buildWalletArtworkQr,
  type WalletCardIdentity,
} from "@/lib/wallet/wallet-card-identity";

const identity: WalletCardIdentity = {
  ownerId: "ada",
  name: "Ada Lovelace",
  memberSince: "2026",
  validThru: "12/28",
  profileUrl: "https://one.hushh.ai/c/profile-token",
  profileStatus: "ready",
  cardPayload: { full_name: "Ada Lovelace", headline: "Mathematician" },
  referralUrl: "https://one.hushh.ai/r/ada-ref",
};

function mount(cardIndex: number, value: WalletCardIdentity) {
  const view = render(<WalletDemoCardFace summary={WALLET_DEMO_CARDS[cardIndex]!} identity={value} />);
  const frame = view.container.querySelector("iframe")!;
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post }, configurable: true });
  return { view, frame, post };
}

function fromArtwork(frame: HTMLIFrameElement, data: unknown, origin = window.location.origin) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, origin, source: frame.contentWindow as unknown as MessageEventSource }),
    );
  });
}

const OPEN = { type: "agent-one-card:action", action: "open-wallet-profile" };

describe("Profile and Referral artwork", () => {
  beforeEach(() => push.mockClear());

  it("sends the owner's details and the matching QR link, and clears them on logout", () => {
    const profile = mount(0, identity);
    fireEvent.load(profile.frame);
    expect(profile.post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        card: "profile",
        name: "Ada Lovelace",
        memberSince: "2026",
        validThru: "12/28",
        qr: buildWalletArtworkQr(identity.profileUrl),
        gate: null,
      }),
      window.location.origin,
    );

    const referral = mount(1, identity);
    fireEvent.load(referral.frame);
    expect(referral.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ card: "referral", qr: buildWalletArtworkQr(identity.referralUrl) }),
      window.location.origin,
    );

    profile.view.rerender(<WalletDemoCardFace summary={WALLET_DEMO_CARDS[0]!} identity={EMPTY_WALLET_CARD_IDENTITY} />);
    expect(profile.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: null, memberSince: null, validThru: null, qr: null, gate: null }),
      window.location.origin,
    );
  });

  it("answers only its own artwork's ready message", () => {
    const { frame, post } = mount(0, identity);
    post.mockClear();

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "agent-one-card:ready" }, origin: window.location.origin, source: window }));
    });
    expect(post).not.toHaveBeenCalled();

    fromArtwork(frame, { type: "agent-one-card:ready" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("leaves the green NWS artwork alone: no QR or dates sent, only the name line", () => {
    const { view, post } = mount(2, identity);
    expect(post).not.toHaveBeenCalled();
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.getByText("Ada Lovelace")).toBeTruthy();
  });

  describe("setup gate on the black card", () => {
    const setup: WalletCardIdentity = { ...identity, profileUrl: null, profileStatus: "setup" };

    it("shades the QR area when the profile is missing and opens the Wallet Profile page on request", () => {
      const { frame, post } = mount(0, setup);
      fireEvent.load(frame);
      expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ gate: "setup", qr: null }), window.location.origin);

      fromArtwork(frame, OPEN);
      expect(push).toHaveBeenCalledExactlyOnceWith("/one/wallet-card");
    });

    it("never shades the QR area while status is unknown, and ignores a request made without a gate", () => {
      const { frame, post } = mount(0, { ...setup, profileStatus: "unknown" });
      fireEvent.load(frame);
      expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ gate: null }), window.location.origin);
      fromArtwork(frame, OPEN);
      expect(push).not.toHaveBeenCalled();
    });

    it("offers the same page for an existing profile whose link is not on this device", () => {
      const { frame, post } = mount(0, { ...setup, profileStatus: "link-missing" });
      fireEvent.load(frame);
      expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ gate: "link-missing" }), window.location.origin);
    });

    it("ignores unvalidated requests: wrong origin, wrong sender, unknown action", () => {
      const { frame } = mount(0, setup);
      fromArtwork(frame, OPEN, "https://evil.example");
      fromArtwork(frame, { type: "agent-one-card:action", action: "navigate", url: "https://evil.example" });
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: OPEN, origin: window.location.origin, source: window }));
      });
      expect(push).not.toHaveBeenCalled();
    });

    it("never puts a gate on the gold card, even when the profile is missing", () => {
      const { frame, post } = mount(1, setup);
      fireEvent.load(frame);
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({ gate: null, qr: buildWalletArtworkQr(setup.referralUrl) }),
        window.location.origin,
      );
      fromArtwork(frame, OPEN);
      expect(push).not.toHaveBeenCalled();
    });
  });
});

describe("View details and swipe controls", () => {
  it.each(WALLET_DEMO_CARDS.map((card) => card.cardId))("%s prints the owner's real name and valid-through, no sample", (cardId) => {
    const { container } = render(<WalletDemoCardDetails cardId={cardId} identity={identity} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("2026");
    expect(text).toContain("12/28");
    expect(text).toContain("Mathematician"); // the saved Wallet Profile fields stay
    expect(text).not.toMatch(/Alex Morgan|2030/);
  });

  it("shows no sample values before the owner's details are known", () => {
    const { container } = render(<WalletDemoCardDetails cardId="demo-0" identity={EMPTY_WALLET_CARD_IDENTITY} />);
    expect(container.textContent).not.toMatch(/Alex Morgan|2030|12\/30|2026|12\/28/);
    expect(container.textContent).toContain("No saved Wallet Profile information is available.");
  });

  it("uses the same real valid-through on the card controls revealed by swiping", () => {
    const { container } = render(
      <WalletAddCollection cards={WALLET_DEMO_CARDS} selectedCardId={null} onSelect={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} busyCardId={null} preview identity={identity} />,
    );
    const controls = Array.from(container.querySelectorAll("[data-card-controls]")).map((node) => node.textContent ?? "");
    expect(controls.length).toBe(WALLET_DEMO_CARDS.length);
    for (const text of controls) {
      expect(text).toContain("Valid through 12/28");
      expect(text).not.toMatch(/Expires|12\/30|4242|4444|1234/);
    }
  });
});
