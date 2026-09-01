import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  fetchPythonApi: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/server", () => ({
  connection: mocks.connection,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

vi.mock("@/app/api/_utils/backend", () => ({
  fetchPythonApi: mocks.fetchPythonApi,
}));

vi.mock("@/components/connections/person-profile-page", () => ({
  PersonProfilePage: () => null,
}));

import PublicPersonProfileRoute, {
  generateStaticParams,
} from "@/app/people/[personRef]/page";

describe("public person profile route", () => {
  const originalCapacitorBuild = process.env.CAPACITOR_BUILD;

  beforeEach(() => {
    process.env.CAPACITOR_BUILD = "";
    mocks.connection.mockResolvedValue(undefined);
    mocks.fetchPythonApi.mockResolvedValue(
      new Response(
        JSON.stringify({
          personRef: "public-person-ref",
          displayName: "Public Person",
          photoUrl: null,
          verifiedRole: null,
        }),
        { status: 200 },
      ),
    );
  });

  afterEach(() => {
    process.env.CAPACITOR_BUILD = originalCapacitorBuild;
    vi.clearAllMocks();
  });

  it("binds web requests to the live request before the no-store profile fetch", async () => {
    const element = await PublicPersonProfileRoute({
      params: Promise.resolve({ personRef: "public-person-ref" }),
    });

    expect(mocks.connection).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPythonApi).toHaveBeenCalledWith(
      "/api/public/people/public-person-ref",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(mocks.connection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetchPythonApi.mock.invocationCallOrder[0],
    );
    expect(element.props).toMatchObject({
      personRef: "public-person-ref",
      initialProfile: {
        personRef: "public-person-ref",
        displayName: "Public Person",
      },
    });
  });

  it("keeps the Capacitor static shell free of web-only server fetches", async () => {
    process.env.CAPACITOR_BUILD = "true";

    const element = await PublicPersonProfileRoute({
      params: Promise.resolve({ personRef: "native-placeholder-ref" }),
    });

    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.fetchPythonApi).not.toHaveBeenCalled();
    expect(element.props).toMatchObject({
      personRef: "native-placeholder-ref",
      initialProfile: null,
    });
    expect(generateStaticParams()).toEqual([
      { personRef: "00000000-0000-4000-8000-000000000001" },
    ]);
  });
});
