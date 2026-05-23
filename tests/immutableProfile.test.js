const assert = require("assert");
const {
  IMMUTABLE_PROFILE_ERROR,
  LOCKED_STATUS,
  ProfileStateManager,
} = require("../scripts/immutable-profile");

function runImmutabilitySuite() {
  console.log("Running test(types): Verifying immutable status configurations for locked profiles...");

  const manager = new ProfileStateManager({
    profileId: "prof_abdul_2026",
    securityClearance: "MAXIMUM",
    syncTrackingStatus: LOCKED_STATUS,
  });

  const mutationAttempt = manager.requestFieldMutation("securityClearance", "STANDARD");

  assert.strictEqual(
    mutationAttempt.isMutationApplied,
    false,
    "System permitted a mutation loop to modify a locked profile configuration."
  );
  assert.strictEqual(
    mutationAttempt.errorLabel,
    IMMUTABLE_PROFILE_ERROR,
    "Wrong error metadata returned on immutability gate bypass."
  );
  assert.strictEqual(
    manager.profileRecord.securityClearance,
    "MAXIMUM",
    "Protected attribute was silently clobbered in memory storage."
  );
  assert.strictEqual(manager.profileRecord.syncTrackingStatus, LOCKED_STATUS);

  console.log("Test passed: profile state modifiers honor immutability lock constraints.");
}

runImmutabilitySuite();
