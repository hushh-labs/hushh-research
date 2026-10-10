import { afterEach, describe, expect, it } from "vitest";

import { GET as getAasa } from "@/app/.well-known/apple-app-site-association/route";
import { GET as getAssetLinks } from "@/app/.well-known/assetlinks.json/route";
import { GET as getRelatedOrigins } from "@/app/.well-known/webauthn/route";
import { NextRequest } from "next/server";

const ORIGINAL_ENV = { ...process.env };

describe.sequential("native passkey domain association routes", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fails closed when the iOS association configuration is absent", async () => {
    delete process.env.APPLE_TEAM_ID;
    delete process.env.NEXT_PUBLIC_APPLE_TEAM_ID;

    const response = await getAasa();

    expect(response.status).toBe(503);
  });

  it.each([
    ["dev", "dev.one"],
    ["uat", "uat.one"],
    ["production", "one"],
  ])("publishes only the %s related origins over both RP hosts", async (environment, prefix) => {
    process.env.HUSHH_DEPLOY_ENV = environment;
    for (const spelling of ["hushh", "hussh"]) {
      const response = await getRelatedOrigins(new NextRequest(`https://${prefix}.${spelling}.ai/.well-known/webauthn`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({
        origins: [`https://${prefix}.hushh.ai`, `https://${prefix}.hussh.ai`],
      });
    }
  });

  it("refuses unknown, cross-environment and forwarded-host claims", async () => {
    process.env.HUSHH_DEPLOY_ENV = "dev";
    for (const hostname of ["one.hushh.ai", "uat.one.hussh.ai", "evil.dev.one.hussh.ai"]) {
      const response = await getRelatedOrigins(new NextRequest(`https://${hostname}/.well-known/webauthn`, {
        headers: { "x-forwarded-host": "dev.one.hussh.ai" },
      }));
      expect(response.status).toBe(404);
    }
    delete process.env.HUSHH_DEPLOY_ENV;
    expect((await getRelatedOrigins(new NextRequest("https://dev.one.hushh.ai/.well-known/webauthn"))).status).toBe(404);
  });

  it("fails closed when the Android package id is absent, instead of falling back to a stale default", async () => {
    delete process.env.NEXT_PUBLIC_ANDROID_APP_ID;
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = "AA:BB:CC:DD:EE:FF";

    const response = await getAssetLinks();

    expect(response.status).toBe(503);
  });

  it("enables iOS invitation claims only after the native release rollout switch", async () => {
    process.env.APPLE_TEAM_ID = "ABCDEFGHIJ";
    delete process.env.NATIVE_INVITATION_LINKS_ENABLED;
    const webFirst = await (await getAasa()).json();
    expect(webFirst.applinks.details[0].components.map((item: { "/": string }) => item["/"]))
      .not.toContain("/circle/join");
    expect(webFirst.applinks.details[0].components.map((item: { "/": string }) => item["/"]))
      .toContain("/one/kai/plaid/oauth/return");
    process.env.NATIVE_INVITATION_LINKS_ENABLED = "true";
    const appReady = await (await getAasa()).json();
    expect(appReady.applinks.details[0].components.map((item: { "/": string }) => item["/"]))
      .toEqual(expect.arrayContaining(["/", "/circle/join", "/one/location/invite/*"]));
  });

  it("publishes the configured iOS and Android associations", async () => {
    process.env.APPLE_TEAM_ID = "ABCDEFGHIJ";
    process.env.NEXT_PUBLIC_IOS_BUNDLE_ID = "com.hushh.app";
    process.env.NEXT_PUBLIC_ANDROID_APP_ID = "com.hushh.app";
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS =
      "AA:BB:CC:DD:EE:FF, 11:22:33:44:55:66";

    const [aasaResponse, assetLinksResponse] = await Promise.all([
      getAasa(),
      getAssetLinks(),
    ]);

    expect(aasaResponse.status).toBe(200);
    expect(await aasaResponse.json()).toMatchObject({
      applinks: {
        details: [{
          appIDs: ["ABCDEFGHIJ.com.hushh.app"],
          components: expect.arrayContaining([
            expect.objectContaining({ "/": "/one/profile/google/oauth/return" }),
          ]),
        }],
      },
      webcredentials: { apps: ["ABCDEFGHIJ.com.hushh.app"] },
    });
    expect(assetLinksResponse.status).toBe(200);
    expect(await assetLinksResponse.json()).toEqual([
      {
        relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.hushh.app",
          sha256_cert_fingerprints: ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"],
        },
      },
    ]);
  });
});
