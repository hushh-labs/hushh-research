export interface NativeGoogleContactsAuthorization {
  accessToken: string;
  googleSubject: string;
  grantedScopes: string[];
  authority: "ios-sdk-grant" | "android-contacts-only";
  expiresAt: number | null;
}

export interface NativeDeletionPhoneProofPlugin {
  /** Isolated, manually entered SMS proof; never links the primary identity. */
  startPhoneVerificationProof(options: { expectedUserId: string; attemptId: string; phoneNumber: string; resendCode?: boolean }): Promise<{ attemptId: string; verificationId: string }>;
  confirmPhoneVerificationProof(options: { expectedUserId: string; attemptId: string; verificationCode: string }): Promise<{ attemptId: string; phoneIdToken: string }>;
  cancelPhoneVerificationProof(options: { attemptId: string }): Promise<void>;
  /** Deletion-only proof; never mutates or publishes the primary identity. */
  startPhoneDeletionVerification(options: {
    expectedUserId: string;
    attemptId: string;
    phoneNumber: string;
    resendCode?: boolean;
  }): Promise<{ attemptId: string; verificationId?: string; phoneIdToken?: string }>;
  confirmPhoneDeletionVerification(options: {
    expectedUserId: string;
    attemptId: string;
    verificationCode: string;
  }): Promise<{ attemptId: string; phoneIdToken: string }>;
  cancelPhoneDeletionVerification(options: { attemptId: string }): Promise<void>;
}
