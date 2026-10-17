"use client";

import { Capacitor } from "@capacitor/core";
import { AuthService } from "@/lib/services/auth-service";
import type { NativeTestConfig } from "@/lib/testing/native-test";

/** Explicit nonproduction web admission; ordinary reviewer minting is independent. */
export async function signInOperatorReviewer(config: Pick<NativeTestConfig, "enabled" | "autoReviewerLogin" | "reviewerAuthMode" | "expectedUserId">) {
  const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL;
  const environment = process.env.NEXT_PUBLIC_APP_ENV;
  if (!config.enabled || !config.autoReviewerLogin || config.reviewerAuthMode !== "operator_issued_token" ||
      !config.expectedUserId || Capacitor.isNativePlatform() ||
      !["uat", "dev", "development"].includes(environment || "") ||
      !expectedOrigin || !expectedOrigin.startsWith("https://") ||
      new URL(expectedOrigin).origin !== expectedOrigin || window.location.origin !== expectedOrigin) {
    throw new Error("Operator reviewer context refused.");
  }
  const issue = window.__HUSHH_NATIVE_TEST__?.requestOperatorReviewerToken;
  if (typeof issue !== "function") throw new Error("Operator reviewer token provider required.");
  let token = await issue(config.expectedUserId);
  try {
    if (typeof token !== "string" || !token) throw new Error("Operator reviewer token unavailable.");
    return await AuthService.signInWithCustomToken(token, { memoryOnly: true });
  } finally {
    token = "";
  }
}
