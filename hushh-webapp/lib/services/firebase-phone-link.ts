/** Confirm an SMS against an existing Firebase user without adopting a phone session. */
export async function linkFirebasePhone({
  apiKey, tenantId, idToken, uid, phoneNumber, sessionInfo, code,
}: {
  apiKey: string | undefined;
  tenantId: string | null;
  idToken: string;
  uid: string;
  phoneNumber: string;
  sessionInfo: string;
  code: string;
}): Promise<void> {
  const fail = (code: string) => Object.assign(new Error("Phone verification did not complete."), { code });
  if (!apiKey || !idToken) throw fail("phone_verification_failed");

  const url = new URL("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber");
  url.searchParams.set("key", apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({ idToken, sessionInfo, code, ...(tenantId ? { tenantId } : {}) }),
    }).catch(() => { throw fail("network-request-failed"); });
    const reply = await response.json().catch(() => null) as {
      localId?: string;
      phoneNumber?: string;
      isNewUser?: boolean;
      temporaryProof?: string;
      error?: { message?: string };
    } | null;

    if (!response.ok) {
      switch (reply?.error?.message?.split(" : ", 1)[0]) {
        case "INVALID_CODE": throw fail("invalid-verification-code");
        case "SESSION_EXPIRED": throw fail("code-expired");
        case "INVALID_SESSION_INFO": throw fail("phone-verification-required");
        case "PHONE_NUMBER_EXISTS": throw fail("credential-already-in-use");
        case "INVALID_ID_TOKEN":
        case "TOKEN_EXPIRED":
        case "CREDENTIAL_TOO_OLD_LOGIN_AGAIN": throw fail("requires-recent-login");
        case "TOO_MANY_ATTEMPTS_TRY_LATER": throw fail("too-many-requests");
        default: throw fail(response.status >= 500 ? "network-request-failed" : "phone_verification_failed");
      }
    }
    if (reply?.temporaryProof) throw fail("credential-already-in-use");
    if (reply?.localId !== uid || reply.phoneNumber !== phoneNumber || reply.isNewUser === true) {
      throw fail("phone_verification_failed");
    }
    // The response's ID and refresh tokens can represent phone sign-in.
    // Keep the caller's original independent session and reload its user.
  } finally {
    clearTimeout(timeout);
  }
}
