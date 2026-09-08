import { afterEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("next/server", () => ({ connection }));
vi.mock("@/app/one/location/view/[token]/page-client", () => ({ default: () => null }));

import PublicLocationViewPage, { generateStaticParams } from "@/app/one/location/view/[token]/page";

afterEach(() => vi.unstubAllEnvs());

describe("public location rendering in web and native builds", () => {
  it("renders an inert web build probe through the dynamic request boundary", async () => {
    vi.stubEnv("CAPACITOR_BUILD", "false");
    const params = await generateStaticParams();
    // [] silently classifies unseen links as SSG and causes the runtime 500.
    expect(params).toEqual([{ token: "public-location-render-probe" }]);
    await PublicLocationViewPage({ params: Promise.resolve(params[0]) });
    expect(connection).toHaveBeenCalledOnce();
  });

  it("retains a static fixture for Capacitor without requiring a server connection", async () => {
    vi.stubEnv("CAPACITOR_BUILD", "true");
    const params = await generateStaticParams();
    expect(params).toHaveLength(1);
    expect(params[0].token).toBeTruthy();
    await PublicLocationViewPage({ params: Promise.resolve(params[0]) });
    expect(connection).not.toHaveBeenCalled();
  });
});
