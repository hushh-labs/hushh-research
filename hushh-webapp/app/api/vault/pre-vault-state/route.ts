import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { validateFirebaseToken } from "@/lib/auth/validate";
import { isDevelopment } from "@/lib/config";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();

type PreVaultStatePayload = {
  userId?: string;
  setupCompleted?: boolean;
  setupSkipped?: boolean;
  setupCompletedAt?: number | null;
  navSetupCompletedAt?: number | null;
  navSetupSkippedAt?: number | null;
  setupCapabilityIds?: string[];
  onboardingJourneyVersion?: 1;
  onboardingPhase?: string | null;
  onboardingActiveCapability?: string | null;
  onboardingResumeRoute?: "/one/setup";
  onboardingCallbackState?: string | null;
  onboardingCallbackAttemptId?: string;
  expectedOnboardingJourneyUpdatedAt?: number | null;
  expectedOnboardingCallbackAttemptId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as PreVaultStatePayload;
    const authHeader = request.headers.get("Authorization");

    if (!authHeader && !isDevelopment()) {
      return NextResponse.json(
        { error: "Authorization required", code: "AUTH_REQUIRED" },
        { status: 401 }
      );
    }

    if (authHeader) {
      const validation = await validateFirebaseToken(authHeader);
      if (!validation.valid && !isDevelopment()) {
        return NextResponse.json(
          { error: `Authentication failed: ${validation.error}`, code: "AUTH_INVALID" },
          { status: 401 }
        );
      }
    }

    const response = await fetch(`${PYTHON_API_URL}/db/vault/pre-vault-state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Preserve the backend error envelope exactly. Native calls this backend
      // route directly, so wrapping `detail` here made web and native classify
      // the same onboarding conflict differently.
      const errorPayload =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload
          : {
              detail: {
                error: "Backend error",
                code: "UPSTREAM_ERROR",
              },
            };
      return NextResponse.json(errorPayload, { status: response.status });
    }

    return NextResponse.json(payload);
  } catch (error) {
    console.error("[API] Vault pre-vault-state error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
