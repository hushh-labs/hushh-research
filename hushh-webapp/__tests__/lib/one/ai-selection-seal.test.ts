/**
 * The "Bring your own AI" seal (contract C1) is the only thing standing between
 * a person's provider key and everyone who is not their private agent. These
 * pin the byte format the agent opens (shared golden vector with the backend),
 * that only the addressed agent can open it, and that any change to the bound
 * metadata or ciphertext is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AI_SELECTION_SEAL_ALG,
  base64AnyDecode,
  base64UrlEncode,
  sealAiSelection,
  sealAiSelectionWithFixedInputs,
  type AiSelectionEnvelope,
  type AiSelectionPlaintext,
} from "@/lib/one/ai-selection-seal";
import { canonical, importPrivate, openAsAgent } from "./open-ai-selection";

const hex = (value: string) => Uint8Array.from(value.match(/../g)!.map((byte) => parseInt(byte, 16)));
// RFC 7748 section 6.1 key pairs, so the deterministic path is checked against a published answer.
const ALICE_PRIVATE = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const ALICE_PUBLIC = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const BOB_PRIVATE = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
const BOB_PUBLIC = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");

const SELECTION: AiSelectionPlaintext = {
  provider: "openai", model: null, apiKey: "sk-fixture-not-a-real-key", transport: null, vertexProject: null, vertexLocation: null,
};
const RECIPIENT = { hushhId: "ha1_owner", podKeyId: "podk_1", publicKey: base64UrlEncode(BOB_PUBLIC) };

describe("ai-selection seal (C1)", () => {
  it("binds the envelope to the addressed agent and opens only there", async () => {
    const envelope = await sealAiSelection(SELECTION, RECIPIENT, 1_757_500_000_000);
    expect(envelope).toMatchObject({ v: 1, alg: AI_SELECTION_SEAL_ALG, aad: { purpose: "ai_selection", hushhId: "ha1_owner", podKeyId: "podk_1", issuedAtMs: 1_757_500_000_000 } });
    expect(envelope.aad.selectionId).toMatch(/^[0-9a-f-]{36}$/);
    for (const field of [envelope.epk, envelope.iv, envelope.ct]) expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64AnyDecode(envelope.iv)).toHaveLength(12);
    const opened = await openAsAgent(envelope, await importPrivate(BOB_PRIVATE), BOB_PUBLIC);
    expect(opened).toBe(canonical(SELECTION));
    expect(JSON.stringify(envelope)).not.toContain(SELECTION.apiKey);
  });

  it("refuses a changed binding, ciphertext or recipient (negative controls)", async () => {
    const envelope = await sealAiSelection(SELECTION, RECIPIENT);
    const agent = await importPrivate(BOB_PRIVATE);
    const reKeyed = { ...envelope, aad: { ...envelope.aad, podKeyId: "podk_2" } };
    await expect(openAsAgent(reKeyed, agent, BOB_PUBLIC)).rejects.toThrow();
    const ct = base64AnyDecode(envelope.ct);
    ct[0] ^= 0x01;
    await expect(openAsAgent({ ...envelope, ct: base64UrlEncode(ct) }, agent, BOB_PUBLIC)).rejects.toThrow();
    await expect(openAsAgent(envelope, await importPrivate(ALICE_PRIVATE), ALICE_PUBLIC)).rejects.toThrow();
  });

  it("refuses a malformed recipient key or selection before sealing", async () => {
    await expect(sealAiSelection(SELECTION, { ...RECIPIENT, publicKey: base64UrlEncode(BOB_PUBLIC.slice(1)) })).rejects.toMatchObject({ code: "RECIPIENT_INVALID" });
    await expect(sealAiSelection({ ...SELECTION, transport: "developer_api" }, RECIPIENT)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
    await expect(sealAiSelection({ ...SELECTION, apiKey: "  " }, RECIPIENT)).rejects.toMatchObject({ code: "SELECTION_INVALID" });
  });

  it("is deterministic for fixed inputs and derives the ephemeral key correctly", async () => {
    const fixed = { ephemeralPrivateKey: ALICE_PRIVATE, iv: hex("000102030405060708090a0b"), issuedAtMs: 1_757_500_000_000, selectionId: "4f7d3c9a-2b1e-4c6f-8a0d-5e9b7c3a1f20" };
    const first = await sealAiSelectionWithFixedInputs(SELECTION, RECIPIENT, fixed);
    expect(await sealAiSelectionWithFixedInputs(SELECTION, RECIPIENT, fixed)).toEqual(first);
    expect(first.epk).toBe(base64UrlEncode(ALICE_PUBLIC));
    expect(await openAsAgent(first, await importPrivate(BOB_PRIVATE), BOB_PUBLIC)).toBe(canonical(SELECTION));
  });
});

/* ---------- shared golden vector with the agent (consent-protocol) ---------- */

const VECTOR_FILE = path.resolve(process.cwd(), "..", "consent-protocol", "tests", "fixtures", "ai_selection_seal_vector_v1.json");
const vectorPresent = fs.existsSync(VECTOR_FILE);

type SealVector = {
  podPrivateKey: string;
  podPublicKey: string;
  ephemeralPrivateKey: string;
  iv: string;
  aad: AiSelectionEnvelope["aad"];
  aadCanonical: string;
  plaintext: AiSelectionPlaintext;
  plaintextCanonical: string;
  expectedEnvelope: AiSelectionEnvelope;
  expectedEnvelopeCanonical: string;
};

describe.skipIf(!vectorPresent)("ai-selection seal golden vector (skipped until consent-protocol/tests/fixtures/ai_selection_seal_vector_v1.json exists)", () => {
  it("produces the agent's expected envelope byte for byte", async () => {
    const vector = JSON.parse(fs.readFileSync(VECTOR_FILE, "utf8")) as SealVector;
    expect(canonical(vector.aad)).toBe(vector.aadCanonical);
    expect(canonical(vector.plaintext)).toBe(vector.plaintextCanonical);
    const envelope = await sealAiSelectionWithFixedInputs(
      vector.plaintext,
      { hushhId: vector.aad.hushhId, podKeyId: vector.aad.podKeyId, publicKey: vector.podPublicKey },
      {
        ephemeralPrivateKey: base64AnyDecode(vector.ephemeralPrivateKey),
        iv: base64AnyDecode(vector.iv),
        issuedAtMs: vector.aad.issuedAtMs,
        selectionId: vector.aad.selectionId,
      },
    );
    expect(canonical(envelope)).toBe(vector.expectedEnvelopeCanonical);
    expect(envelope).toEqual(vector.expectedEnvelope);
    const podPrivate = await importPrivate(base64AnyDecode(vector.podPrivateKey));
    expect(await openAsAgent(envelope, podPrivate, base64AnyDecode(vector.podPublicKey))).toBe(vector.plaintextCanonical);
  });
});
