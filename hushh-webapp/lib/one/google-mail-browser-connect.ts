import { getGoogleIdentityServices, preloadGoogleIdentityServices } from "@/lib/contacts/google-contacts-token";

export const UAT_MAIL_ORIGIN = "https://uat.one.hussh.ai";

type CodeClientOptions = {
  client_id: string;
  scope: string;
  ux_mode: "popup";
  select_account: true;
  include_granted_scopes: false;
  callback: (response: { code?: string; error?: string }) => void;
  error_callback: () => void;
};

/** Open GIS directly from a click after the async owner/transition checks. */
export async function requestMailBrowserCode(clientId: string, scopes: string[], current: () => boolean): Promise<string> {
  await preloadGoogleIdentityServices();
  const oauth = getGoogleIdentityServices()?.accounts?.oauth2 as
    | { initCodeClient?: (options: CodeClientOptions) => { requestCode(): void } }
    | undefined;
  if (location.origin !== UAT_MAIL_ORIGIN || !oauth?.initCodeClient || !current()) throw new Error("SIGN_IN_INCOMPLETE");
  const init = oauth.initCodeClient.bind(oauth);
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    const heading = document.createElement("h2");
    heading.textContent = "Connect Gmail";
    dialog.setAttribute("aria-label", heading.textContent);
    dialog.className = "m-auto rounded-2xl bg-background p-6 text-foreground shadow-xl backdrop:bg-black/40";
    const allow = document.createElement("button");
    allow.textContent = "Continue with Google";
    allow.className = "mt-4 rounded-full bg-primary px-4 py-2 text-primary-foreground";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.className = "ml-3 px-3 py-2";
    let settled = false;
    function finish(code?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(sessionCheck);
      dialog.remove();
      if (code && current()) resolve(code);
      else reject(new Error("SIGN_IN_CANCELLED"));
    }
    const timeout = setTimeout(() => finish(), 5 * 60_000);
    const sessionCheck = setInterval(() => { if (!current()) finish(); }, 500);
    cancel.onclick = () => finish();
    dialog.oncancel = () => finish();
    allow.onclick = () => {
      if (!current()) return finish();
      allow.disabled = true;
      try {
        init({ client_id: clientId, scope: scopes.join(" "), ux_mode: "popup", select_account: true,
          include_granted_scopes: false, callback: result => finish(result.error ? undefined : result.code),
          error_callback: () => finish() }).requestCode();
      } catch { finish(); }
    };
    dialog.append(heading, allow, cancel);
    document.body.append(dialog);
    try { dialog.showModal(); } catch { finish(); }
  });
}
