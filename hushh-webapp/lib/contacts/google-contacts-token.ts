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
const GIS_LOAD_TIMEOUT_MS = 15_000;
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

type TokenResponse = {
  access_token?: string;
  error?: string;
  scope?: string;
};
type TokenClient = { requestAccessToken: () => void };
type GoogleIdentityServices = {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
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

const GIS_LOADER_ATTRIBUTE = "data-hushh-google-contacts-loader";

function loadGis(): Promise<void> {
  if (gis()?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Google sign-in is only available in a browser."));
      return;
    }
    let script = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SCRIPT_SRC}"]`,
    );

    // A tag left by a previous module instance may already have emitted its
    // load/error event. Only wait on a tag explicitly marked as still loading;
    // otherwise replace it so a stale/failed tag cannot poison every retry.
    if (script?.getAttribute(GIS_LOADER_ATTRIBUTE) !== "loading") {
      script?.remove();
      script = null;
    }

    const created = !script;
    if (!script) {
      script = document.createElement("script");
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.setAttribute(GIS_LOADER_ATTRIBUTE, "loading");
    }
    const activeScript = script;

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    function cleanup(): void {
      if (timeout !== null) clearTimeout(timeout);
      activeScript.removeEventListener("load", handleLoad);
      activeScript.removeEventListener("error", handleError);
    }
    function fail(): void {
      if (settled) return;
      settled = true;
      cleanup();
      activeScript.remove();
      reject(new Error("Could not reach Google sign-in."));
    }
    function handleLoad(): void {
      if (settled) return;
      if (!gis()?.accounts?.oauth2) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      activeScript.setAttribute(GIS_LOADER_ATTRIBUTE, "loaded");
      resolve();
    }
    function handleError(): void {
      fail();
    }

    activeScript.addEventListener("load", handleLoad, { once: true });
    activeScript.addEventListener("error", handleError, { once: true });
    timeout = setTimeout(fail, GIS_LOAD_TIMEOUT_MS);
    if (created) document.head.appendChild(activeScript);
  }).catch((error) => {
    // A failed load must not poison every later attempt.
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

function googleContactsClientId(): string {
  return String(
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || "",
  ).trim();
}

/**
 * Load GIS before the person taps the contact action.
 *
 * `requestAccessToken()` must execute in the tap's synchronous call stack on
 * Safari. Loading the script from inside that tap introduces an async boundary
 * and lets the browser discard transient user activation before the popup is
 * requested. This preload does no account or contact work and opens nothing.
 */
export async function preloadGoogleContactsAuth(): Promise<void> {
  if (!googleContactsClientId()) return;
  await loadGis();
  if (!gis()?.accounts?.oauth2) {
    throw new Error("Could not reach Google sign-in.");
  }
}

function hasOnlyContactsScope(response: TokenResponse): boolean {
  const granted = new Set(
    String(response.scope || "")
      .split(/\s+/u)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  return granted.size === 1 && granted.has(CONTACTS_SCOPE);
}

/**
 * Did the person close the consent sheet rather than fail to open it?
 *
 * Lives here because this file is what decides it: `error_callback` stamps
 * `name = "AbortError"` on a dismissal specifically so a caller can tell the
 * two apart. Callers that re-derive the rule by string-matching the message
 * break the first time the wording changes.
 *
 * Cancelling is a choice, not a failure. The device picker has read it that
 * way since it shipped (`contacts-web.ts` returns an empty read on
 * `AbortError`); without this the Google path reported a shrug as a red error
 * toast and an analytics row saying the sync failed.
 */
export function isGoogleContactsConsentCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
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
export function requestGoogleContactsToken(): Promise<string> {
  const clientId = googleContactsClientId();
  if (!clientId) {
    return Promise.reject(
      new Error("Google contacts are not available in this build."),
    );
  }

  const oauth2 = gis()?.accounts?.oauth2;
  if (!oauth2) {
    // Recover a failed/slow preload without trying to open a popup after an
    // async boundary. The next explicit tap can request access synchronously.
    void preloadGoogleContactsAuth().catch(() => undefined);
    return Promise.reject(
      new Error("Google Contacts is still getting ready. Try again."),
    );
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: CONTACTS_SCOPE,
      // Never fold grants from another Google capability into this token.
      // The exact returned scope is validated again below before the token is
      // allowed to reach the People API source.
      include_granted_scopes: false,
      callback: (response) => {
        if (settled) return;
        settled = true;
        if (response?.error) {
          reject(new Error("Google contact access was not granted."));
          return;
        }
        const token = String(response?.access_token || "").trim();
        if (token && hasOnlyContactsScope(response)) {
          resolve(token);
          return;
        }
        if (token) {
          reject(
            new Error(
              "Google did not confirm the exact contacts-only scope. Nothing was read.",
            ),
          );
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
        const closed = error?.type === "popup_closed";
        const popupBlocked = error?.type === "popup_failed_to_open";
        const failure = new Error(
          closed
            ? "Google contact access was cancelled."
            : popupBlocked
              ? "Google sign-in was blocked. Allow pop-ups and try again."
              : "Could not open Google sign-in.",
        );
        failure.name = closed ? "AbortError" : "Error";
        reject(failure);
      },
    });
    client.requestAccessToken();
  });
}
