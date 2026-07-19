import { afterEach, describe, expect, it } from "vitest";

import { GET as getAasa } from "@/app/.well-known/apple-app-site-association/route";
import { GET as getAssetLinks } from "@/app/.well-known/assetlinks.json/route";

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
      webcredentials: { apps: ["ABCDEFGHIJ.com.hushh.app"] },
    });
    expect(assetLinksResponse.status).toBe(200);
    expect(await assetLinksResponse.json()).toEqual([
      {
        relation: ["delegate_permission/common.get_login_creds"],
        target: {
          namespace: "android_app",
          package_name: "com.hushh.app",
          sha256_cert_fingerprints: ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"],
        },
      },
    ]);
  });
});
