const assert = require("assert");
const {
  HEX_HASH_ERROR,
  HEX_HASH_PATTERN,
  validateHexHashEncoding,
} = require("../scripts/hex-hash-encoding");

function runHexEncodingSuite() {
  console.log("Running test(types): Verifying standard hexadecimal encoding rules for output hashes...");

  const compliantHash = "8f94a2c301e574d3b0f2e1a5d6c8b90a";
  assert.match(compliantHash, HEX_HASH_PATTERN);

  const stableResult = validateHexHashEncoding(compliantHash);
  assert.strictEqual(stableResult.isFormatCompliant, true, "Standard lowercase hexadecimal format was incorrectly rejected.");
  assert.strictEqual(stableResult.errorLabel, null, "Valid hexadecimal hash returned an unexpected error label.");

  const compliantLongHash =
    "8f94a2c301e574d3b0f2e1a5d6c8b90a8f94a2c301e574d3b0f2e1a5d6c8b90a";
  assert.match(compliantLongHash, HEX_HASH_PATTERN);
  assert.strictEqual(validateHexHashEncoding(compliantLongHash).isFormatCompliant, true);

  const corruptedEncodingHash = "8F94A2C301E574D3B0F2E1A5D6C8B90Z";
  const constrainedResult = validateHexHashEncoding(corruptedEncodingHash);
  assert.strictEqual(constrainedResult.isFormatCompliant, false, "Encoding boundary gate permitted an invalid string format to pass.");
  assert.strictEqual(constrainedResult.errorLabel, HEX_HASH_ERROR, "Wrong error label attached to encoding format exception mapping.");

  const tooShortResult = validateHexHashEncoding("8f94a2c301e574d3");
  assert.strictEqual(tooShortResult.isFormatCompliant, false, "Encoding boundary gate permitted a too-short hash string.");
  assert.strictEqual(tooShortResult.errorLabel, HEX_HASH_ERROR);

  console.log("Test passed: hash validators conform to strict lowercase hexadecimal strings.");
}

runHexEncodingSuite();
