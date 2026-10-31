import { afterEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("next/server", () => ({ connection }));
vi.mock("@/app/one/location/view/[token]/page-client", () => ({ default: () => null }));
vi.mock("@/app/one/location/invite/[token]/page-client", () => ({ default: () => null }));

import PublicLocationViewPage, { generateStaticParams } from "@/app/one/location/view/[token]/page";
import OneLocationCircleInvitePage, {
  generateStaticParams as generateInviteStaticParams,
} from "@/app/one/location/invite/[token]/page";

afterEach(() => vi.unstubAllEnvs());

describe.each([
  {
    name: "public location",
    Page: PublicLocationViewPage,
    generateParams: generateStaticParams,
    probe: "public-location-render-probe",
  },
  {
    name: "Invite to One",
    Page: OneLocationCircleInvitePage,
    generateParams: generateInviteStaticParams,
    probe: "one-invite-render-probe",
  },
])("$name rendering in web and native builds", ({ Page, generateParams, probe }) => {
  it("renders an inert web build probe through the dynamic request boundary", async () => {
    vi.stubEnv("CAPACITOR_BUILD", "false");
    const params = await generateParams();
    // [] silently classifies unseen links as SSG and causes the runtime 500.
    expect(params).toEqual([{ token: probe }]);
    await Page({ params: Promise.resolve(params[0]) });
    expect(connection).toHaveBeenCalledOnce();
  });

  it("retains a static fixture for Capacitor without requiring a server connection", async () => {
    vi.stubEnv("CAPACITOR_BUILD", "true");
    const params = await generateParams();
    expect(params).toHaveLength(1);
    expect(params[0].token).toBeTruthy();
    await Page({ params: Promise.resolve(params[0]) });
    expect(connection).not.toHaveBeenCalled();
  });
});
