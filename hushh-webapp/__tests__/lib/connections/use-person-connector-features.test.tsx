import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ data: { driveAgentPackagesEnabled: false,
  features: { drive_period_packets: false, drive_document_sharing: false } } }));
vi.mock("@/lib/cache/use-stale-resource", () => ({ useStaleResource: () => ({ data: state.data, error: null, refresh: vi.fn() }) }));
vi.mock("@/lib/services/external-connector-service", () => ({ ExternalConnectorService: { featureReadiness: vi.fn() } }));
import { usePersonConnectorFeatures } from "@/lib/connections/use-person-connector-features";

afterEach(cleanup);
describe("person profile packet feature admission", () => {
  it("admits period packets independently of retired body collection, and requires either admitted flag", () => {
    state.data = { driveAgentPackagesEnabled: false,
      features: { drive_period_packets: true, drive_document_sharing: false } };
    const { result, rerender } = renderHook(({ unlocked }) => usePersonConnectorFeatures("owner", "token", unlocked),
      { initialProps: { unlocked: true } });
    expect(result.current.availability).toEqual({ status: "ready", documentSharing: false, agentPackages: true });
    state.data.features.drive_period_packets = false;
    rerender({ unlocked: true });
    expect(result.current.availability).toMatchObject({ agentPackages: false });
    state.data.driveAgentPackagesEnabled = true;
    rerender({ unlocked: true });
    expect(result.current.availability).toMatchObject({ agentPackages: true });
    rerender({ unlocked: false });
    expect(result.current.availability).toEqual({ status: "locked" });
  });
});
