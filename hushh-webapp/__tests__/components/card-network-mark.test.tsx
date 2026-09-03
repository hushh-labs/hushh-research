import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  CardNetworkMark,
  cardNetworkLabel,
} from "@/components/wallet/card-network-mark";

describe("CardNetworkMark", () => {
  it("names every detected network for assistive technology", () => {
    // A person who cannot see the tile still hears which card this is.
    expect(cardNetworkLabel("visa")).toBe("Visa");
    expect(cardNetworkLabel("amex")).toBe("American Express");
    expect(cardNetworkLabel("rupay")).toBe("RuPay");
    expect(cardNetworkLabel("MasterCard")).toBe("Mastercard");
  });

  it("falls back to a neutral mark for an unknown or missing brand", () => {
    expect(cardNetworkLabel("not-a-network")).toBe("Card");
    expect(cardNetworkLabel(null)).toBe("Card");
    expect(cardNetworkLabel("")).toBe("Card");
  });

  it("renders an accessible image role carrying the network name", () => {
    render(<CardNetworkMark brand="discover" />);
    const mark = screen.getByRole("img", { name: "Discover" });
    expect(mark).toBeInTheDocument();
    // The tile is Hushh's own mark, so it must not claim to be the network's
    // artwork: no <img> to a vendor asset, just a labelled element.
    expect(mark.tagName.toLowerCase()).toBe("span");
  });
});
