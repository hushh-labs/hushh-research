import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WALLET_DEMO_CARDS, WalletDemoCardFace } from "@/components/wallet/wallet-demo-cards";
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
  referralUrl: "https://one.hushh.ai/r/ada-ref",
};

function mount(cardIndex: number, value: WalletCardIdentity) {
  const view = render(<WalletDemoCardFace summary={WALLET_DEMO_CARDS[cardIndex]!} identity={value} />);
  const frame = view.container.querySelector("iframe")!;
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post }, configurable: true });
  return { view, frame, post };
}

describe("Profile and Referral artwork", () => {
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
      expect.objectContaining({ name: null, memberSince: null, validThru: null, qr: null }),
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

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "agent-one-card:ready" },
          origin: window.location.origin,
          source: frame.contentWindow as unknown as MessageEventSource,
        }),
      );
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("leaves the green NWS artwork alone: no QR or dates sent, only the name line", () => {
    const { view, post } = mount(2, identity);
    expect(post).not.toHaveBeenCalled();
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.getByText("Ada Lovelace")).toBeTruthy();
  });
});
