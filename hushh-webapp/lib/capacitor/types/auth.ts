export interface NativeGoogleContactsAuthorization {
  accessToken: string;
  googleSubject: string;
  grantedScopes: string[];
  authority: "ios-sdk-grant" | "android-contacts-only";
  expiresAt: number | null;
}

export interface NativeDeletionPhoneProofPlugin {
  /** Deletion-only proof; never mutates or publishes the primary identity. */
  startPhoneDeletionVerification(options: {
    expectedUserId: string;
    attemptId: string;
    phoneNumber: string;
  }): Promise<{ attemptId: string; verificationId?: string; phoneIdToken?: string }>;
  confirmPhoneDeletionVerification(options: {
    expectedUserId: string;
    attemptId: string;
    verificationCode: string;
  }): Promise<{ attemptId: string; phoneIdToken: string }>;
  cancelPhoneDeletionVerification(options: { attemptId: string }): Promise<void>;
}
