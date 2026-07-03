import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSosIncident,
  loadSosIncident,
  reconcileSosIncident,
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";

beforeEach(() => {
  window.localStorage.clear();
});

describe("sos-incident store", () => {
  const incident: SosIncident = {
    grantIds: ["g1", "g2"],
    startedAt: "2026-07-03T10:57:00.000Z",
  };

  it("save then load round-trips", () => {
    saveSosIncident(incident);
    expect(loadSosIncident()).toEqual(incident);
  });

  it("clear removes it", () => {
    saveSosIncident(incident);
    clearSosIncident();
    expect(loadSosIncident()).toBeNull();
  });

  it("load returns null on absent/corrupt data", () => {
    expect(loadSosIncident()).toBeNull();
    window.localStorage.setItem("one_location_sos_incident_v1", "{not json");
    expect(loadSosIncident()).toBeNull();
  });

  it("reconcile keeps only still-active grant ids", () => {
    expect(reconcileSosIncident(incident, ["g1"])).toEqual({
      grantIds: ["g1"],
      startedAt: incident.startedAt,
    });
  });

  it("reconcile returns null when no grant ids remain active", () => {
    expect(reconcileSosIncident(incident, ["other"])).toBeNull();
    expect(reconcileSosIncident(null, ["g1"])).toBeNull();
  });

  it("reconcile returns the same reference when all ids remain active", () => {
    expect(reconcileSosIncident(incident, ["g1", "g2"])).toBe(incident);
  });
});
