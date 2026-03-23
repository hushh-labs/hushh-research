import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadHelper() {
  vi.resetModules();
  return import("@/app/api/_utils/backend");
}

describe("backend runtime resolution", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
    };
    delete process.env.K_SERVICE;
    delete process.env.K_REVISION;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.PYTHON_API_URL;
    delete process.env.BACKEND_URL;
    delete process.env.DEVELOPER_API_URL;
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_API_URL;
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.ENVIRONMENT;
    delete process.env.APP_RUNTIME_PROFILE;
  });

  it("defaults to the local backend only in local development", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    const helper = await loadHelper();
    expect(helper.getPythonApiUrl()).toBe("http://127.0.0.1:8000");
  });

  it("canonicalizes localhost local hints to loopback for server-side routes", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:8000";
    process.env.NEXT_PUBLIC_DEVELOPER_API_URL = "http://localhost:8000";
    const helper = await loadHelper();
    expect(helper.getPythonApiUrl()).toBe("http://127.0.0.1:8000");
    expect(helper.getDeveloperApiUrl()).toBe("http://127.0.0.1:8000");
  });

  it("prefers explicit runtime BACKEND_URL in hosted runtimes", async () => {
    process.env.K_SERVICE = "hushh-webapp";
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    process.env.BACKEND_URL = "https://consent-protocol-uat.example.com";
    const helper = await loadHelper();
    expect(helper.getPythonApiUrl()).toBe("https://consent-protocol-uat.example.com");
  });

  it("throws when a hosted runtime is missing an explicit backend origin", async () => {
    process.env.K_SERVICE = "hushh-webapp";
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    const helper = await loadHelper();
    expect(() => helper.getPythonApiUrl()).toThrow(/Missing backend origin/);
  });

  it("throws when a hosted runtime resolves to localhost", async () => {
    process.env.K_SERVICE = "hushh-webapp";
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    process.env.BACKEND_URL = "http://localhost:8000";
    const helper = await loadHelper();
    expect(() => helper.getPythonApiUrl()).toThrow(/resolved backend origin to localhost/i);
  });

  it("uses developer runtime env before local hints", async () => {
    process.env.DEVELOPER_API_URL = "https://consent-protocol-uat.example.com";
    process.env.NEXT_PUBLIC_DEVELOPER_API_URL = "https://wrong.example.com";
    const helper = await loadHelper();
    expect(helper.getDeveloperApiUrl()).toBe("https://consent-protocol-uat.example.com");
  });
});
