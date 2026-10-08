/** Public build pins; they never authorize a session, payment or information access. */
export const SANDBOX_IOS_APP_ID = "com.hushh.app.scopecommerce.sandbox";
export const SANDBOX_ANDROID_APP_ID = "com.hussh.app.scopecommerce.sandbox";

export function exactSandboxFrontendOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("An exact default Cloud Run HTTPS frontend origin is required."); }
  if (typeof raw !== "string" || !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+run\.app\/?$/.test(raw) ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
      ![url.origin, `${url.origin}/`].includes(raw)) {
    throw new Error("An exact default Cloud Run HTTPS frontend origin is required.");
  }
  return url.origin;
}

/** Both identities and the bundled application origin must agree with the explicit pin. */
export function sandboxNativeFrontendOrigin({ sandboxOrigin, frontendOrigin, iosAppId, androidAppId }) {
  if (!sandboxOrigin || iosAppId !== SANDBOX_IOS_APP_ID || androidAppId !== SANDBOX_ANDROID_APP_ID) return null;
  try {
    const pin = exactSandboxFrontendOrigin(sandboxOrigin);
    return pin === frontendOrigin && pin === sandboxOrigin ? pin : null;
  } catch { return null; }
}
