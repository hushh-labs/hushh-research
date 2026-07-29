const IMMUTABLE_PROFILE_ERROR = "CONSTRAINT_VIOLATION_IMMUTABLE_PROFILE_STATE";
const LOCKED_STATUS = "LOCKED";

class ProfileStateManager {
  constructor(profileRecord = {}) {
    this.profileRecord = {
      ...profileRecord,
    };
  }

  requestFieldMutation(fieldName, incomingValue) {
    if (this.profileRecord.syncTrackingStatus === LOCKED_STATUS) {
      return {
        isMutationApplied: false,
        errorLabel: IMMUTABLE_PROFILE_ERROR,
      };
    }

    this.profileRecord[fieldName] = incomingValue;
    return {
      isMutationApplied: true,
      errorLabel: null,
    };
  }
}

module.exports = {
  IMMUTABLE_PROFILE_ERROR,
  LOCKED_STATUS,
  ProfileStateManager,
};
