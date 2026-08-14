// @vitest-environment node
import { describe, expect, it } from "vitest";

import { renderSosEmail } from "@/app/api/one/location/sos-email/route";

const base = {
  recipientDisplayName: "Parth Kumar",
  ownerDisplayName: "Ankit",
  note: "I'm not safe",
  latitude: 12.9352,
  longitude: 77.6245,
  accuracyM: 14,
  openInOneUrl: "https://uat.one.hushh.ai/one/location?section=shared",
  emergencyNumber: "112",
  expiresAtLabel: "Fri, 14 Aug 2026 23:42:00 GMT",
};

describe("Save my Soul email", () => {
  it("names who needs help in the subject", () => {
    // A contact scanning a notification shade sees the subject and nothing
    // else. It has to carry the name and the urgency on its own.
    expect(renderSosEmail(base).subject).toBe(
      "Ankit needs help — Save my Soul",
    );
  });

  it("carries the coordinates, a map link, and the local emergency number", () => {
    const { text, html } = renderSosEmail(base);
    for (const body of [text, html]) {
      expect(body).toContain("12.935200, 77.624500");
      expect(body).toContain("google.com/maps");
      expect(body).toContain("112");
    }
    expect(text).toContain("accurate to about 14 m");
  });

  it("survives a contact whose client shows text only", () => {
    // The plain-text part is not a courtesy: it is what a watch, a screen
    // reader, and a locked-down mail client render.
    const { text } = renderSosEmail(base);
    expect(text).toContain("Ankit triggered a Save my Soul alert");
    expect(text).toContain('"I\'m not safe"');
    expect(text).toContain(base.openInOneUrl);
  });

  it("escapes the sender's note instead of trusting it", () => {
    // The note is free text typed under stress and lands in an HTML mail.
    const { html } = renderSosEmail({
      ...base,
      note: '<img src=x onerror="alert(1)">',
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes a display name too", () => {
    const { html } = renderSosEmail({
      ...base,
      ownerDisplayName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("reads correctly with no note", () => {
    const { text, html } = renderSosEmail({ ...base, note: null });
    expect(text).toContain("Ankit triggered a Save my Soul alert");
    expect(text).not.toContain('""');
    expect(html).not.toContain("border-left:3px solid");
  });

  it("does not invent an accuracy it was not given", () => {
    const { text } = renderSosEmail({ ...base, accuracyM: null });
    expect(text).not.toContain("accurate to about");
    expect(text).toContain("12.935200, 77.624500");
  });

  it("does not invent an emergency number it was not given", () => {
    // Naming the wrong number in an emergency is worse than naming none.
    const { text } = renderSosEmail({ ...base, emergencyNumber: null });
    expect(text).toContain("call your local emergency number");
    expect(text).not.toMatch(/call \d/);
  });

  it("falls back to a neutral name rather than an empty sentence", () => {
    const { subject } = renderSosEmail({ ...base, ownerDisplayName: "" });
    expect(subject).toBe("Someone needs help — Save my Soul");
  });

  it("greets by first name only, and omits the greeting when unknown", () => {
    expect(renderSosEmail(base).text).toContain("Parth, Ankit triggered");
    expect(
      renderSosEmail({ ...base, recipientDisplayName: "" }).text,
    ).toContain("Ankit triggered");
  });

  it("says when the live share ends, and stays honest when it does not know", () => {
    expect(renderSosEmail(base).text).toContain("stays shared until");
    expect(
      renderSosEmail({ ...base, expiresAtLabel: null }).text,
    ).toContain("is shared with you now");
  });
});
