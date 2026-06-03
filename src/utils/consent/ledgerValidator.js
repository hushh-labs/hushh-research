"use strict";

const crypto = require("node:crypto");

/**
 * validateLedgerChain(currentEvent, previousHash)
 *
 * Produces a SHA-256 hex digest that cryptographically links a consent audit
 * event to the preceding entry in the ledger chain, creating a tamper-proof
 * audit log where any mutation of any event immediately breaks all downstream
 * hashes.
 *
 * Hashing strategy:
 *   payload  =  JSON.stringify(currentEvent)  +  previousHash
 *   digest   =  SHA-256(payload, utf8) → lowercase hex (64 chars)
 *
 * The first event in a chain should supply "" as previousHash (genesis link).
 * Every subsequent event supplies the digest returned by the previous call.
 *
 * Safe-fallback rules — all return "" without throwing:
 *   • currentEvent is null / undefined
 *   • currentEvent is not a plain object (array, string, number, boolean …)
 *   • currentEvent cannot be JSON-serialised (e.g. circular reference)
 *   • previousHash is null / undefined / not a string
 *
 * @param  {object} currentEvent   — consent event metadata to be linked
 * @param  {string} previousHash   — hex digest of the preceding ledger entry
 *                                   ("" for the genesis / first event)
 * @returns {string}               — 64-char lowercase hex digest, or "" on error
 */
function validateLedgerChain(currentEvent, previousHash) {
  // ── Validate currentEvent ─────────────────────────────────────────────────
  if (
    currentEvent === null ||
    currentEvent === undefined ||
    typeof currentEvent !== "object" ||
    Array.isArray(currentEvent)
  ) {
    return "";
  }

  // ── Validate previousHash ─────────────────────────────────────────────────
  if (typeof previousHash !== "string") {
    return "";
  }

  // ── Serialise the event ───────────────────────────────────────────────────
  let serialised;
  try {
    serialised = JSON.stringify(currentEvent);
  } catch {
    return ""; // circular reference or other serialisation error
  }

  // ── Produce the chain link digest ─────────────────────────────────────────
  return crypto
    .createHash("sha256")
    .update(serialised + previousHash, "utf8")
    .digest("hex");
}

module.exports = { validateLedgerChain };
