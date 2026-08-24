/**
 * A browser-held Google access token, scoped to reading contacts and nothing else.
 *
 * Uses Google Identity Services' implicit token flow, which never involves our
 * servers: the token is minted in the browser, lives in this module's memory,
 * and is discarded. That is the whole reason this file exists rather than an
 * endpoint that vends one.
 *
 * WHY NOT ASK OUR BACKEND FOR A TOKEN. `GoogleConnectionService.access_token`
 * exists and works, and it is the wrong tool. It refreshes with no `scope`
 * parameter, and `start()` sets `include_granted_scopes: "true"` — so the
 * single stored refresh token accumulates the union of every scope the person
 * has ever granted. For anyone who connected Calendar with `manage`, that token
 * carries `calendar.events` WRITE. Handing it to JavaScript hands the browser
 * the ability to create, move and cancel that person's real meetings, in order
 * to read their address book. Narrowing on the refresh grant fails open: if
 * Google ignores the narrowed scope you get a broader token, not an error.
 *
 * The scope string below is the one already declared server-side in
 * `google_connection_service.py`. That declaration stays the source of truth
 * for what "contacts" means; this file asks for the same thing.
 */

const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

type TokenResponse = { access_token?: string; error?: string };
type TokenClient = { requestAccessToken: () => void };
type GoogleIdentityServices = {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string }) => void;
      }) => TokenClient;
    };
  };
};

function gis(): GoogleIdentityServices | null {
  const candidate = (globalThis as Record<string, unknown>).google;
  return (candidate as GoogleIdentityServices) ?? null;
}

let scriptPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (gis()?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Google sign-in is only available in a browser."));
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Could not reach Google sign-in.")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Could not reach Google sign-in.")),
      { once: true },
    );
    document.head.appendChild(script);
  }).catch((error) => {
    // A failed load must not poison every later attempt.
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

/**
 * Ask Google for a contacts-scoped access token.
 *
 * MUST be called from a user gesture — the flow can open a consent popup, and
 * browsers block popups that no click asked for.
 *
 * The token is returned rather than stored. The caller uses it for one read and
 * lets it go: there is no refresh token on this path, nothing is written to
 * `localStorage` or `sessionStorage` (the house rule — see
 * `lib/calendar/calendar-oauth-journey.ts`, which stores only the literal "1"),
 * and a 401 mid-read means asking again, which is silent once consent is
 * already granted.
 */
export async function requestGoogleContactsToken(): Promise<string> {
  const clientId = String(
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || "",
  ).trim();
  if (!clientId) {
    throw new Error("Google contacts are not available in this build.");
  }

  await loadGis();
  const oauth2 = gis()?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error("Could not reach Google sign-in.");
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: CONTACTS_SCOPE,
      callback: (response) => {
        if (settled) return;
        settled = true;
        const token = String(response?.access_token || "").trim();
        if (token) {
          resolve(token);
          return;
        }
        reject(new Error("Google contact access was not granted."));
      },
      error_callback: (error) => {
        if (settled) return;
        settled = true;
        // Closing the consent sheet is a choice, not a failure. Reported with a
        // recognisable name so the caller can stay silent about it, the same
        // way an AbortError from the device picker is treated.
        const closed =
          error?.type === "popup_closed" || error?.type === "popup_failed_to_open";
        const failure = new Error(
          closed
            ? "Google contact access was cancelled."
            : "Could not open Google sign-in.",
        );
        failure.name = closed ? "AbortError" : "Error";
        reject(failure);
      },
    });
    client.requestAccessToken();
  });
}
