// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectorVectorGlyph } from "@/components/agent/connector-brand-mark";
import {
  CONNECTOR_ARTWORK,
  connectorArtworkId,
  resolveConnectorArtwork,
} from "@/lib/profile/connector-artwork";

describe("connector pure-vector SVG artwork", () => {
  const iconsDir = path.join(process.cwd(), "public/icons/connectors");

  it("keeps every connector mark as a pure local SVG with zero raster jpg/png fallbacks", () => {
    const entries = fs.readdirSync(iconsDir).filter((name) => name !== "README.md");
    expect(entries.length).toBeGreaterThanOrEqual(14);
    for (const file of entries) {
      expect(file).toMatch(/\.svg$/);
      const raw = fs.readFileSync(path.join(iconsDir, file), "utf8");
      expect(raw).toContain("<svg");
      expect(raw).not.toContain("<image");
    }

    for (const entry of Object.values(CONNECTOR_ARTWORK)) {
      expect(entry.file).toMatch(/\.svg$/);
      expect(fs.existsSync(path.join(iconsDir, entry.file))).toBe(true);
    }
  });

  it("normalizes connector aliases and renders vector SVG images across profile and tile variants", () => {
    expect(connectorArtworkId("google_calendar")).toBe("calendar");
    expect(connectorArtworkId("google_contacts")).toBe("contacts");
    expect(connectorArtworkId("mail")).toBe("gmail");
    expect(connectorArtworkId("drive")).toBe("google_drive");
    expect(resolveConnectorArtwork("Stripe Billing")).toBe("stripe");
    expect(resolveConnectorArtwork("GitHub Repos")).toBe("github");
    expect(resolveConnectorArtwork("Linear Issues")).toBe("linear");
    expect(resolveConnectorArtwork("Slack Workspace")).toBe("slack");

    const { container } = render(
      <div>
        <ConnectorVectorGlyph id="stripe" variant="profile" />
        <ConnectorVectorGlyph id="slack" variant="tile" />
        <ConnectorVectorGlyph id="contacts" variant="profile" />
      </div>,
    );

    const stripeImg = container.querySelector('img[data-connector-brand="stripe"]');
    const slackImg = container.querySelector('img[data-connector-brand="slack"]');
    const contactsImg = container.querySelector('img[data-connector-brand="contacts"]');
    expect(stripeImg).toHaveAttribute("src", "/icons/connectors/stripe.svg");
    expect(slackImg).toHaveAttribute("src", "/icons/connectors/slack.svg");
    expect(contactsImg).toHaveAttribute("src", "/icons/connectors/contacts.svg");
  });
});
