import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  fetchPythonApi: vi.fn(),
}));

vi.mock("next/server", () => ({
  connection: mocks.connection,
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
  });

  afterEach(() => {
    process.env.CAPACITOR_BUILD = originalCapacitorBuild;
    vi.clearAllMocks();
  });

  it("renders a static hosted web shell and leaves profile loading to the client service", async () => {
    const element = await PublicPersonProfileRoute({
      params: Promise.resolve({ personRef: "public-person-ref" }),
    });

    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.fetchPythonApi).not.toHaveBeenCalled();
    expect(element.props).toMatchObject({
      personRef: "public-person-ref",
      initialProfile: null,
    });
  });

  it("keeps the Capacitor static shell on the placeholder export path", async () => {
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
