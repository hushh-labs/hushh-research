import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * A nameless "connect with someone" has nothing for connect.send_request to
 * search for -- its `person` slot is required. That phrasing belongs to
 * route.one_connect (open Connect so the person can look someone up), not the
 * action that sends a real request the moment a name is spoken.
 */
describe("connect.send_request does not carry nameless aliases (#6084)", () => {
  const OPEN = "route.one_connect";
  const SEND = "connect.send_request";

  it("removed the aliases route.one_connect already owns", () => {
    // Regression: both actions carried the identical aliases
    // "connect with someone" and "add a connection" -- a low-risk navigate
    // and a high-risk send-a-real-request, tied at the exact-alias-match
    // score with no way to tell them apart.
    const sendAliases = (getKaiActionById(SEND)?.aliases ?? []).map((a) => a.toLowerCase());
    const openAliases = (getKaiActionById(OPEN)?.aliases ?? []).map((a) => a.toLowerCase());
    expect(sendAliases).not.toContain("connect with someone");
    expect(sendAliases).not.toContain("add a connection");
    expect(openAliases).toContain("connect with someone");
    expect(openAliases).toContain("add a connection");
  });

  it("keeps send_request's own name-bearing aliases and its required person slot", () => {
    const action = getKaiActionById(SEND);
    const aliases = (action?.aliases ?? []).map((a) => a.toLowerCase());
    expect(aliases).toContain("send a connection request");
    expect(aliases).toContain("invite someone");
    const personInput = action?.goal?.required_inputs?.find((spec) => spec.slot === "person");
    expect(personInput?.required).toBe(true);
  });

  it("explains the nameless case in its own meaning, pointing back to route.one_connect", () => {
    expect(getKaiActionById(SEND)?.meaning ?? "").toMatch(/route\.one_connect/);
  });
});
