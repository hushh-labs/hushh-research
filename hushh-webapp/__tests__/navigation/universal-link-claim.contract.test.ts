import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  remove: vi.fn(),
  router: { replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => native.router }));
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@capacitor/core")>(),
  Capacitor: { isNativePlatform: native.isNativePlatform },
}));
vi.mock("@capacitor/app", () => ({ App: native }));

import { UNIVERSAL_LINK_PATHS } from "@/app/.well-known/apple-app-site-association/route";
import {
  resolveDeepLinkPath,
  resolveNativeConnectorReturn,
  resolveNativeDrivePickerReturn,
  useDeepLinkReturn,
} from "@/lib/navigation/use-deep-link-return";

/**
 * A Universal Link only works when four independent things agree. Any one of
 * them missing sends the person to a browser instead of back into the app, and
 * nothing errors: the OS simply declines to hand over the URL.
 *
 * That is exactly how the Plaid return broke. The app shipped with
 * `webcredentials:` entitlements and an `applinks` block of `{"apps":[],
 * "details":[]}`, so a person who finished connecting a bank account landed in
 * Safari. No test failed, because no test knew the four halves existed.
 */

const REPO = path.resolve(__dirname, "../..");
const ORIGINS = ["one.hushh.ai", "uat.one.hushh.ai", "dev.one.hushh.ai"];

function read(relative: string): string {
  return readFileSync(path.join(REPO, relative), "utf8");
}

describe("Universal Link / App Link claim", () => {
  it("claims at least every OAuth return path", () => {
    // If a new provider flow is added, its return path belongs here. A return
    // path that is not claimed is a person stranded in a browser.
    expect(UNIVERSAL_LINK_PATHS.length).toBeGreaterThan(0);
    for (const claimed of UNIVERSAL_LINK_PATHS.filter((path) => path.includes("/oauth/return"))) {
      expect(claimed.startsWith("/")).toBe(true);
      expect(claimed).toContain("/oauth/return");
    }
  });

  it("declares applinks in every iOS entitlements file, not just webcredentials", () => {
    // webcredentials is password autofill. It does nothing for link routing,
    // and having it present is what made the gap look handled.
    for (const file of [
      "ios/App/App/App.entitlements",
      "ios/App/App/AppRelease.entitlements",
    ]) {
      const contents = read(file);
      for (const origin of ORIGINS) {
        expect(contents, `${file} must claim applinks:${origin}`).toContain(
          `applinks:${origin}`,
        );
      }
    }
  });

  it("declares an autoVerify https intent filter on Android for the same origins", () => {
    // Android 11 and below verify every autoVerify host together, so the
    // release manifest claims only hosts whose assetlinks vouch for the release
    // signature; dev is claimed by the debug build alone.
    const manifests = {
      release: read("android/app/src/main/AndroidManifest.xml"),
      debug: read("android/app/src/debug/AndroidManifest.xml"),
    };
    const DEBUG_ONLY_ORIGINS = ["dev.one.hushh.ai"];
    for (const [variant, manifest] of Object.entries(manifests)) {
      expect(manifest).toContain('android:autoVerify="true"');
      for (const claimed of UNIVERSAL_LINK_PATHS) {
        const prefix = claimed.endsWith("*") ? claimed.slice(0, -1) : claimed;
        const matcher = claimed.includes("/oauth/return") || claimed.endsWith("*") ? "pathPrefix" : "path";
        expect(manifest, `${variant} manifest must claim ${claimed}`).toContain(
          `android:${matcher}="${prefix}"`,
        );
      }
    }
    for (const origin of ORIGINS) {
      const debugOnly = DEBUG_ONLY_ORIGINS.includes(origin);
      const claim = `android:host="${origin}"`;
      expect(manifests.debug.includes(claim) || manifests.release.includes(claim)).toBe(true);
      expect(manifests.release.includes(claim), `release claim for ${origin}`).toBe(!debugOnly);
    }
  });

  it("claims shared invitations without claiming every page on the domain", () => {
    expect(UNIVERSAL_LINK_PATHS).toEqual(expect.arrayContaining([
      "/", "/circle/join", "/circle/join/", "/one/location/invite/*",
    ]));
    expect(UNIVERSAL_LINK_PATHS).not.toContain("*");
    expect(UNIVERSAL_LINK_PATHS).not.toContain("/*");
  });

  it("keeps a real invitation token on a bundled, query-backed native page", () => {
    for (const origin of ORIGINS) {
      expect(resolveDeepLinkPath(`https://${origin}/`)).toBe("/");
      expect(resolveDeepLinkPath(`https://${origin}/circle/join?code=ABCD-EFGH`)).toBe("/circle/join?code=ABCD-EFGH");
      expect(resolveDeepLinkPath(`https://${origin}/one/location/invite/real_token-123/`)).toBe("/circle/join?invite=real_token-123");
    }
    for (const invalid of [
      "https://one.hushh.ai/one/location/invite/bad/nested",
      "https://one.hushh.ai/one/location/invite/%2Fredirect",
      "https://user@one.hushh.ai/circle/join?code=ABCD",
      "https://one.hushh.ai.evil.example/circle/join?code=ABCD",
      "https://one.hushh.ai:444/circle/join?code=ABCD",
    ]) expect(resolveDeepLinkPath(invalid)).toBeNull();
  });

  it("routes a claimed return URL back into the app, and refuses a foreign one", () => {
    // The OS handing the URL over is only half of it. Without this resolution
    // the app receives the return and sits on whatever screen was already open.
    expect(
      resolveDeepLinkPath(
        "https://one.hushh.ai/one/kai/plaid/oauth/return?state=abc",
      ),
    ).toBe("/one/kai/plaid/oauth/return?state=abc");

    // The query carries the OAuth state; dropping it strands the flow.
    expect(
      resolveDeepLinkPath(
        "https://uat.one.hushh.ai/one/kai/plaid/oauth/return?code=1#x",
      ),
    ).toBe("/one/kai/plaid/oauth/return?code=1#x");

    // An incoming link is attacker-influenced: anyone can send one.
    expect(
      resolveDeepLinkPath(
        "https://evil.example.com/one/kai/plaid/oauth/return",
      ),
    ).toBeNull();
    expect(
      resolveDeepLinkPath("http://one.hushh.ai/one/kai/plaid/oauth/return"),
    ).toBeNull();
    expect(resolveDeepLinkPath("not a url")).toBeNull();
    expect(resolveDeepLinkPath("")).toBeNull();
  });

  it("consumes an opaque native Drive handoff without treating it as navigation", () => {
    const attemptId = "attempt_123456789012";
    expect(
      resolveNativeConnectorReturn(
        `hushh://connectors/return?attemptId=${attemptId}&outcome=ready`,
      ),
    ).toEqual({ attemptId, outcome: "ready" });
    for (const malformed of [
      `hushh://connectors/return?attemptId=${attemptId}&outcome=ready&code=secret`,
      `hushh://connectors/return?attemptId=${attemptId}&outcome=ready&outcome=ready`,
      `hushh://connectors/other?attemptId=${attemptId}&outcome=ready`,
      `https://connectors/return?attemptId=${attemptId}&outcome=ready`,
      `hushh://user@connectors/return?attemptId=${attemptId}&outcome=ready`,
      `hushh://connectors:444/return?attemptId=${attemptId}&outcome=ready`,
      `hushh://connectors/return?attemptId=short&outcome=ready`,
      `hushh://connectors/return?attemptId=${attemptId}&outcome=unknown`,
    ]) {
      expect(resolveNativeConnectorReturn(malformed)).toBeNull();
    }

    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:scheme="hushh"');
    expect(manifest).toContain('android:host="connectors"');
    expect(manifest).toContain('android:path="/return"');

    // The native parsers must enforce the same canonical opaque handoff as
    // the web parser; accepting credentials/ports creates distinct URLs that
    // Android and iOS can route differently.
    const androidAuth = read(
      "android/app/src/main/java/com/hussh/app/plugins/HushhAuth/HushhAuthPlugin.kt",
    );
    const androidDriveFence = read(
      "android/app/src/main/java/com/hussh/app/plugins/HushhAuth/NativeDriveAuthorizationFence.kt",
    );
    const iosAuth = read("ios/App/App/Plugins/HushhAuthPlugin.swift");
    expect(androidAuth).toContain("uri.userInfo != null || uri.port != -1");
    expect(androidAuth).toContain("scheduleDriveFallbackCancellation(operation)");
    expect(androidAuth).toContain(
      "NativeDriveOAuthPolicy.FALLBACK_RETURN_GRACE_MS",
    );
    expect(androidDriveFence).toContain(
      "const val FALLBACK_RETURN_GRACE_MS = 5_000L",
    );
    expect(iosAuth).toContain(
      "url.user == nil, url.password == nil, url.port == nil",
    );
  });

  it("keeps native Drive Picker returns separate, opaque, and narrowly claimed", () => {
    const attemptId = "picker_1234567890123";
    expect(
      resolveNativeDrivePickerReturn(
        `hushh://connectors/picker-return?attemptId=${attemptId}&outcome=ready`,
      ),
    ).toEqual({ attemptId, outcome: "ready" });
    for (const malformed of [
      `hushh://connectors/picker-return?attemptId=${attemptId}&outcome=ready&fileId=private`,
      `hushh://connectors/return?attemptId=${attemptId}&outcome=ready`,
      `hushh://connectors/picker-return?attemptId=${attemptId}&outcome=ready&outcome=ready`,
      `hushh://user@connectors/picker-return?attemptId=${attemptId}&outcome=ready`,
      `hushh://connectors:444/picker-return?attemptId=${attemptId}&outcome=ready`,
      `hushh://connectors/picker-return?attemptId=short&outcome=ready`,
    ]) {
      expect(resolveNativeDrivePickerReturn(malformed)).toBeNull();
    }

    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:path="/picker-return"');
    const androidAuth = read(
      "android/app/src/main/java/com/hussh/app/plugins/HushhAuth/HushhAuthPlugin.kt",
    );
    const iosAuth = read("ios/App/App/Plugins/HushhAuthPlugin.swift");
    expect(androidAuth).toContain('PICKER("/picker-return")');
    expect(androidAuth).toContain("pickDriveFiles(call: PluginCall)");
    expect(iosAuth).toContain('url.path == "/picker-return"');
    expect(iosAuth).toContain("pickDriveFiles(_ call: CAPPluginCall)");
  });

  it("delegates handle_all_urls, not only login credentials", () => {
    // Android's domain verifier refuses an autoVerify filter unless the site
    // delegates handle_all_urls. With only get_login_creds the filter shipped
    // and could never verify, and an unverified domain fails silently: the link
    // just goes to the browser.
    const assetlinks = read("app/.well-known/assetlinks.json/route.ts");
    expect(assetlinks).toContain("delegate_permission/common.handle_all_urls");
    expect(assetlinks).toContain("delegate_permission/common.get_login_creds");
  });

  it("sends Plaid the minted https redirect, never the native app scheme", () => {
    // window.location.href is app://localhost/... once the Universal Link claim
    // works, and Plaid matches receivedRedirectUri against what the token was
    // minted with, so the native return would fail a second time.
    // The return is finished in vault-sync from the https URI remembered
    // when the link token was minted.
    const page = read("app/one/kai/plaid/oauth/return/page.tsx");
    const vaultSync = read("lib/kai/plaid-vault/vault-sync.ts");
    expect(page).toContain("completeVaultOAuthReturn");
    expect(vaultSync).toContain("mergePlaidCallbackQuery(session.redirectUri, params.currentUrl)");
    expect(page).not.toContain("receivedRedirectUri: window.location.href");
    expect(vaultSync).not.toContain("receivedRedirectUri: window.location.href");
  });
});

describe("native invitation arrivals", () => {
  let open: (event: { url: string }) => void;
  beforeEach(() => {
    vi.clearAllMocks();
    native.isNativePlatform.mockReturnValue(true);
    native.getLaunchUrl.mockResolvedValue(undefined);
    native.addListener.mockImplementation(async (_event, listener) => {
      open = listener;
      return { remove: native.remove };
    });
  });
  afterEach(cleanup);

  it("subscribes before reading the cold URL and routes a real token to the static landing", async () => {
    native.getLaunchUrl.mockImplementation(async () => {
      expect(native.addListener).toHaveBeenCalledWith("appUrlOpen", expect.any(Function));
      return { url: "https://one.hushh.ai/one/location/invite/cold_token" };
    });
    renderHook(useDeepLinkReturn);
    await waitFor(() => expect(native.router.replace).toHaveBeenCalledWith("/circle/join?invite=cold_token"));
  });

  it("keeps the newest warm invitation when the cold URL resolves late", async () => {
    let settle!: (value: { url: string }) => void;
    native.getLaunchUrl.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    renderHook(useDeepLinkReturn);
    await waitFor(() => expect(native.getLaunchUrl).toHaveBeenCalled());
    act(() => open({ url: "https://one.hushh.ai/circle/join?code=NEW-CODE" }));
    await act(async () => settle({ url: "https://one.hushh.ai/one/location/invite/old_token" }));
    expect(native.router.replace.mock.calls).toEqual([["/circle/join?code=NEW-CODE"]]);
    act(() => open({ url: "https://one.hushh.ai/one/location/invite/another_token" }));
    expect(native.router.replace).toHaveBeenLastCalledWith("/circle/join?invite=another_token");
  });

  it("does not replay a link after its owner unmounts", async () => {
    let settle!: (value: { url: string }) => void;
    native.getLaunchUrl.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const view = renderHook(useDeepLinkReturn);
    await waitFor(() => expect(native.getLaunchUrl).toHaveBeenCalled());
    view.unmount();
    await act(async () => settle({ url: "https://one.hushh.ai/circle/join?code=OLD" }));
    expect(native.remove).toHaveBeenCalledOnce();
    expect(native.router.replace).not.toHaveBeenCalled();
  });

  it("leaves browser navigation to the web app", async () => {
    native.isNativePlatform.mockReturnValue(false);
    renderHook(useDeepLinkReturn);
    await act(async () => {});
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.getLaunchUrl).not.toHaveBeenCalled();
  });
});
