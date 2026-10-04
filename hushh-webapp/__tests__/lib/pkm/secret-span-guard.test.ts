// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contract from "@/contracts/pkm/secret-patterns.v1.json";
import { findSecretSpans } from "@/lib/pkm/secret-patterns";
import {
  assertNoUnguardedSecrets,
  planSecretCaptures,
  secretOfferFor,
  splitSecretPlaceholders,
  UnguardedSecretError,
} from "@/lib/pkm/secret-span-guard";

/**
 * `contracts/pkm/secret-patterns.v1.json` decides what a secret is, for the
 * device guard here and the server's second net. Every synthetic value below is
 * assembled from parts so no credential-shaped literal sits in the repository.
 */

const WEB_ROOT = process.cwd();
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const CONTRACT_FILE = path.join("contracts", "pkm", "secret-patterns.v1.json");
const join = (...parts: string[]) => parts.join("");

const GITHUB = join("gh", "p_", "fakefake0000fakefake0000fakefake4f2a");
const OPENAI = join("s", "k-proj-", "fakefake0000fakefake9f2a");

let counter = 0;
const ids = () => `sec_${(counter += 1).toString(16).padStart(16, "0")}`;

describe("secret-pattern contract", () => {
  it("keeps all three copies byte-for-byte identical", () => {
    const canonical = fs.readFileSync(path.join(REPO_ROOT, CONTRACT_FILE));
    for (const mirror of [path.join(WEB_ROOT, CONTRACT_FILE), path.join(REPO_ROOT, "consent-protocol", CONTRACT_FILE)]) {
      expect(fs.readFileSync(mirror).equals(canonical), mirror).toBe(true);
    }
  });

  it("matches every shared case exactly as the server does", () => {
    expect(contract.cases.some((testCase) => testCase.expect.length === 0)).toBe(true);
    for (const testCase of contract.cases) {
      const text = testCase.parts.join("");
      const found = findSecretSpans(text).map((span) => [span.pattern.id, text.slice(span.start, span.end)]);
      expect(found, testCase.why).toEqual(testCase.expect.map((item) => [item.id, item.value.join("")]));
    }
  });

  it("never flags an env var name, a reference or a plain URL", () => {
    for (const text of [
      "Set STRIPE_SECRET_KEY and GITHUB_TOKEN in Secret Manager",
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
      "https://console.cloud.google.com/run?project=hushh-pda-dev",
      "redirect to https://app.example.test/oauth/callback?state=abc",
    ]) {
      expect(findSecretSpans(text), text).toEqual([]);
    }
  });
});

describe("device guard", () => {
  it("replaces each secret with a placeholder whose label is masked", () => {
    const typed = `my openai key ${OPENAI} and Netflix password: hunter2fake`;
    const paste = `card 4111 1111 1111 1111\npassport number X1234567\ngithub token ${GITHUB}`;
    const plan = planSecretCaptures([typed, paste], { idFactory: ids });
    const [sentTyped, sentPaste] = plan.render();

    expect(plan.captures.map((capture) => [capture.patternId, capture.label])).toEqual([
      ["model_provider_key", "openai API key ending 9f2a"],
      ["password_assignment", "Netflix password"],
      ["card_number", "Visa card ending 1111"],
      ["passport_number", "Passport ending 4567"],
      ["github_token", "GitHub token ending 4f2a"],
    ]);
    for (const value of [OPENAI, "hunter2fake", "4111 1111 1111 1111", "X1234567", GITHUB]) {
      expect(sentTyped).not.toContain(value);
      expect(sentPaste).not.toContain(value);
    }
    expect(sentTyped).toMatch(/^my openai key ⟦secret:sec_[0-9a-f]{16} openai API key ending 9f2a⟧ and Netflix password: ⟦secret:/);
    expect(() => assertNoUnguardedSecrets([sentTyped, sentPaste])).not.toThrow();
  });

  it("keeps one capture for a value repeated across the typed text and a paste", () => {
    const plan = planSecretCaptures([`use ${GITHUB}`, `token ${GITHUB}`], { idFactory: ids });
    expect(plan.captures).toHaveLength(1);
    const rendered = plan.render(() => ({ id: "sec_00000000000000aa", label: "Saved earlier" }));
    expect(rendered).toEqual([
      "use ⟦secret:sec_00000000000000aa Saved earlier⟧",
      "token ⟦secret:sec_00000000000000aa Saved earlier⟧",
    ]);
  });

  it("offers Wallet for a card and Identity documents for a passport, nothing for a key", () => {
    const plan = planSecretCaptures([`card 4111 1111 1111 1111 passport X1234567 key ${GITHUB}`], { idFactory: ids });
    expect(plan.captures.map(secretOfferFor)).toEqual([
      { fileTo: "wallet", actionLabel: "Add this card to Wallet" },
      { fileTo: "kyc_identity_documents", actionLabel: "Add passport to Identity documents" },
      null,
    ]);
  });

  it("refuses a raw secret at the transport line (negative control)", () => {
    expect(() => assertNoUnguardedSecrets(["plain words", `token ${GITHUB}`])).toThrow(UnguardedSecretError);
  });

  it("splits a transcript into text and secret chips", () => {
    expect(splitSecretPlaceholders("a ⟦secret:sec_00000000000000ab Password⟧ b")).toEqual([
      { kind: "text", text: "a " },
      { kind: "secret", id: "sec_00000000000000ab", label: "Password" },
      { kind: "text", text: " b" },
    ]);
  });
});
