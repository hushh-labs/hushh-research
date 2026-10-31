// @vitest-environment node
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { decryptData, encryptData } from "@/lib/vault/encrypt";

const enabled = process.env.RUN_PKM_CRYPTO_BENCHMARK === "1";
const vaultKey = "7f".repeat(32); // Synthetic benchmark-only key; never a user's vault key.
const wordCounts = [100, 1_000, 10_000, 50_000, 100_000] as const;
const warmupRuns = 5;
const measuredRuns = 25;

type Measurement = {
  words: number;
  plaintextBytes: number;
  ciphertextBytes: number;
  encryptMedianMs: number;
  encryptP95Ms: number;
  decryptMedianMs: number;
  decryptP95Ms: number;
};

function syntheticText(words: number): string {
  return Array.from({ length: words }, (_, index) => `memory-${index % 1_000}`).join(" ");
}

function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

function milliseconds(value: number): number {
  return Number(value.toFixed(3));
}

async function benchmarkPayload(words: number): Promise<Measurement> {
  const plaintext = syntheticText(words);
  const plaintextBytes = new TextEncoder().encode(plaintext).byteLength;

  for (let index = 0; index < warmupRuns; index += 1) {
    const payload = await encryptData(plaintext, vaultKey);
    await decryptData(payload, vaultKey);
  }

  const encryptSamples: number[] = [];
  const decryptSamples: number[] = [];
  let ciphertextBytes = 0;

  for (let index = 0; index < measuredRuns; index += 1) {
    const encryptStartedAt = performance.now();
    const payload = await encryptData(plaintext, vaultKey);
    encryptSamples.push(performance.now() - encryptStartedAt);

    const decryptStartedAt = performance.now();
    const decrypted = await decryptData(payload, vaultKey);
    decryptSamples.push(performance.now() - decryptStartedAt);

    expect(decrypted).toBe(plaintext);
    ciphertextBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  }

  return {
    words,
    plaintextBytes,
    ciphertextBytes,
    encryptMedianMs: milliseconds(percentile(encryptSamples, 0.5)),
    encryptP95Ms: milliseconds(percentile(encryptSamples, 0.95)),
    decryptMedianMs: milliseconds(percentile(decryptSamples, 0.5)),
    decryptP95Ms: milliseconds(percentile(decryptSamples, 0.95)),
  };
}

(enabled ? describe : describe.skip)("PKM WebCrypto benchmark", () => {
  it("measures the production AES-256-GCM codec over increasing synthetic payload sizes", async () => {
    vi.stubGlobal("crypto", webcrypto);

    const measurements: Measurement[] = [];
    for (const wordCount of wordCounts) {
      measurements.push(await benchmarkPayload(wordCount));
    }

    console.info(
      [
        "PKM crypto benchmark (synthetic text; 5 warm-ups + 25 measured runs per size)",
        "This measures client-side AES-256-GCM, key import, UTF-8, and Base64 conversion only.",
        "It intentionally excludes network, server, database, PKM manifest, and model-response time.",
        "words | plaintext bytes | encrypted payload bytes | encrypt median/p95 ms | decrypt median/p95 ms",
        ...measurements.map(
          (result) =>
            `${result.words} | ${result.plaintextBytes} | ${result.ciphertextBytes} | ` +
            `${result.encryptMedianMs}/${result.encryptP95Ms} | ` +
            `${result.decryptMedianMs}/${result.decryptP95Ms}`,
        ),
      ].join("\n"),
    );
  });
});
