"use client";

import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import type { PluginListenerHandle } from "@capacitor/core";
import type { User } from "firebase/auth";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { ApiService } from "@/lib/services/api-service";
import { resolveRuntimeFrontendUrl } from "@/lib/runtime/settings";
import { ROUTES } from "@/lib/navigation/routes";

const CALLBACK_PATH = ROUTES.PROFILE_GOOGLE_OAUTH_RETURN;
type Return = { code: string | null; state: string; denied: boolean };
type Attempt = {
  ownerUid: string; state: string; expiresAt: number;
  resolve: () => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; processing: boolean;
};
// OAuth material lives only in this process, never in storage, route history or telemetry.
let attempt: Attempt | null = null;
let pendingReturn: Return | null = null;
let auth: { user: User | null; loading: boolean } = { user: null, loading: true };
let navigate: (destination: string) => void = () => {};
let installed: Promise<void> | null = null;
const consumedReturns = new Map<string, number>();
let authGeneration = 0;
let closingBrowser = false;
let byocInFlight = false;
let browserCancelTimer: ReturnType<typeof setTimeout> | null = null;

function callbackUrl(raw: string): URL | null {
  try {
    const expected = new URL(resolveRuntimeFrontendUrl());
    const value = new URL(raw);
    return expected.protocol === "https:" && value.origin === expected.origin &&
      value.pathname.replace(/\/$/, "") === CALLBACK_PATH && !value.username && !value.password && !value.hash
      ? value : null;
  } catch { return null; }
}

async function closeBrowser(): Promise<void> {
  closingBrowser = true;
  try { await Browser.close(); } catch { /* already closed */ }
  finally { closingBrowser = false; }
}

function settle(error?: string, expected = attempt) {
  if (expected !== attempt) return;
  const current = attempt;
  attempt = null;
  pendingReturn = null;
  if (browserCancelTimer) clearTimeout(browserCancelTimer);
  browserCancelTimer = null;
  if (current) clearTimeout(current.timer);
  void closeBrowser().then(() => {
    if (current) {
      if (error) current.reject(new Error(error)); else current.resolve();
    }
  });
}

async function drainReturn() {
  const returned = pendingReturn;
  if (!returned || auth.loading) return;
  pendingReturn = null;
  const user = auth.user;
  const generation = authGeneration;
  if (returned.state.startsWith("byoc.")) {
    // The existing shared callback also carries cloud setup. Preserve its own
    // backend-validated state/owner contract and its distinct destinations.
    if (!user || !returned.code || returned.denied) {
      await closeBrowser();
      navigate(ROUTES.ONE_SETUP_CLOUD); return;
    }
    byocInFlight = true;
    try {
      await ApiService.completeByocAuthorize({ code: returned.code, state: returned.state });
      if (authGeneration === generation && auth.user?.uid === user.uid) navigate(ROUTES.ONE_SETUP);
    } catch {
      if (authGeneration === generation) navigate(`${ROUTES.ONE_SETUP_CLOUD}?authorize_error=Please%20restart%20cloud%20authorization.`);
    } finally { await closeBrowser(); byocInFlight = false; }
    return;
  }
  const current = attempt;
  if (!current) {
    // Process death loses the locally initiated attempt. Do not silently adopt
    // a code from a browser account; explicitly restart under native identity.
    navigate(`${ROUTES.CALENDAR}?calendar=restart`);
    await closeBrowser();
    return;
  }
  if (!user || user.uid !== current.ownerUid || Date.now() >= current.expiresAt) {
    settle("Your session changed. Start the Calendar connection again."); return;
  }
  if (returned.denied || !returned.code) {
    settle("Google Calendar authorization was not completed."); return;
  }
  current.processing = true;
  try {
    const idToken = await user.getIdToken();
    if (attempt !== current || auth.loading || auth.user?.uid !== current.ownerUid) {
      if (attempt === current) settle("Your session changed. Start the Calendar connection again.");
      return;
    }
    await GoogleCalendarService.completeConnect({ idToken, userId: user.uid, code: returned.code, state: returned.state });
    if (attempt === current) settle(auth.user?.uid === current.ownerUid ? undefined : "Your session changed. Reopen Calendar.");
  } catch {
    if (attempt === current) settle("Google Calendar connection could not be completed. Please try again.");
  }
}

export function receiveNativeGoogleOAuthReturn(raw: string): void {
  if (closingBrowser || byocInFlight) return;
  const url = callbackUrl(raw);
  if (!url || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1) return;
  const state = url.searchParams.get("state");
  for (const [key, time] of consumedReturns) if (Date.now() - time > 15 * 60 * 1000) consumedReturns.delete(key);
  if (!state || consumedReturns.has(state) || pendingReturn) return;
  if (attempt && state !== attempt.state) return;
  consumedReturns.set(state, Date.now());
  if (consumedReturns.size > 32) consumedReturns.delete(consumedReturns.keys().next().value!);
  if (browserCancelTimer) clearTimeout(browserCancelTimer);
  browserCancelTimer = null;
  pendingReturn = { state, code: url.searchParams.get("code"), denied: url.searchParams.has("error") };
  void drainReturn();
}

export function updateNativeGoogleOAuthAuth(user: User | null, loading: boolean): void {
  if (auth.user?.uid !== user?.uid) authGeneration++;
  auth = { user, loading };
  if (!loading && attempt && user?.uid !== attempt.ownerUid) settle("Your session changed. Start the Calendar connection again.");
  void drainReturn();
}

export function installNativeGoogleOAuthReturn(onNavigate: (destination: string) => void): Promise<void> {
  navigate = onNavigate;
  installed ??= (async () => {
    const handles: PluginListenerHandle[] = [];
    try {
    handles.push(await App.addListener("appUrlOpen", ({ url }) => receiveNativeGoogleOAuthReturn(url)));
    handles.push(await Browser.addListener("browserFinished", () => {
      if (!attempt || attempt.processing || pendingReturn) return;
      const current = attempt;
      // App link and browser-dismiss callbacks can arrive in either order.
      browserCancelTimer = setTimeout(() => {
        if (attempt === current && !current.processing && !pendingReturn) settle("Google Calendar connection was cancelled.", current);
      }, 500);
    }));
    const launch = await App.getLaunchUrl();
    if (launch?.url) receiveNativeGoogleOAuthReturn(launch.url);
    } catch (error) {
      await Promise.allSettled(handles.map((handle) => handle.remove()));
      installed = null;
      throw error;
    }
  })();
  return installed;
}

export async function connectNativeGoogleCalendar(params: {
  ownerUid: string; authorizeUrl: string; redirectUri: string; expiresAt: string;
}): Promise<void> {
  try { await installNativeGoogleOAuthReturn(navigate); }
  catch { throw new Error("The native browser connection is unavailable. Please try again."); }
  const authorization = new URL(params.authorizeUrl);
  const state = authorization.searchParams.get("state");
  const expiresAt = Date.parse(params.expiresAt);
  if (!callbackUrl(params.redirectUri) || authorization.origin !== "https://accounts.google.com" ||
      authorization.searchParams.get("redirect_uri") !== params.redirectUri || !state || state.startsWith("byoc.") ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() || auth.loading || auth.user?.uid !== params.ownerUid) {
    throw new Error("Calendar connection could not be started for this session.");
  }
  if (attempt || closingBrowser || byocInFlight) throw new Error("Finish the current Google connection first.");
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => settle("Calendar authorization expired. Please try again.", current), Math.min(expiresAt - Date.now(), 10 * 60 * 1000));
    const current: Attempt = { ownerUid: params.ownerUid, state, expiresAt, resolve, reject, timer, processing: false };
    attempt = current;
    void Browser.open({ url: params.authorizeUrl }).catch(() => settle("The system browser could not open. Please try again.", current));
  });
}
