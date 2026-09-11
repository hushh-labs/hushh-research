import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  UNIVERSAL_LINK_PATHS,
} from "@/app/.well-known/apple-app-site-association/route";
import { resolveDeepLinkPath } from "@/lib/navigation/use-deep-link-return";

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
    for (const claimed of UNIVERSAL_LINK_PATHS) {
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
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:autoVerify="true"');
    for (const origin of ORIGINS) {
      expect(manifest, `manifest must claim ${origin}`).toContain(
        `android:host="${origin}"`,
      );
    }
    for (const claimed of UNIVERSAL_LINK_PATHS) {
      expect(manifest, `manifest must claim ${claimed}`).toContain(
        `android:pathPrefix="${claimed}"`,
      );
    }
  });

  it("routes a claimed return URL back into the app, and refuses a foreign one", () => {
    // The OS handing the URL over is only half of it. Without this resolution
    // the app receives the return and sits on whatever screen was already open.
    expect(
      resolveDeepLinkPath("https://one.hushh.ai/one/kai/plaid/oauth/return?state=abc"),
    ).toBe("/one/kai/plaid/oauth/return?state=abc");

    // The query carries the OAuth state; dropping it strands the flow.
    expect(
      resolveDeepLinkPath("https://uat.one.hushh.ai/one/kai/alpaca/oauth/return?code=1#x"),
    ).toBe("/one/kai/alpaca/oauth/return?code=1#x");

    // An incoming link is attacker-influenced: anyone can send one.
    expect(resolveDeepLinkPath("https://evil.example.com/one/kai/plaid/oauth/return")).toBeNull();
    expect(resolveDeepLinkPath("http://one.hushh.ai/one/kai/plaid/oauth/return")).toBeNull();
    expect(resolveDeepLinkPath("not a url")).toBeNull();
    expect(resolveDeepLinkPath("")).toBeNull();
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
    const page = read("app/one/kai/plaid/oauth/return/page.tsx");
    expect(page).toContain("resume.redirect_uri");
    expect(page).not.toContain("receivedRedirectUri: window.location.href");
  });
});
