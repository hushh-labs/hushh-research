import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSosIncident,
  isSosStateFreshEnough,
  loadSosIncident,
  mergeSosGrantIds,
  reconcileSosIncident,
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";

const STORAGE_KEY = "one_location_sos_incident_v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("sos-incident store", () => {
  const incident: SosIncident = {
    grantIds: ["g1", "g2"],
    startedAt: "2026-07-03T10:57:00.000Z",
  };
  const owned: SosIncident = { ...incident, ownerUserId: "owner-1" };

  it("save then load round-trips (legacy, unscoped read)", () => {
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
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadSosIncident()).toBeNull();
  });

  it("stores the owner and returns the record only to that owner", () => {
    saveSosIncident(owned);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      ownerUserId: "owner-1",
    });
    expect(loadSosIncident("owner-1")).toEqual(owned);
    expect(loadSosIncident("owner-2")).toBeNull();
  });

  it("an owner-scoped record is never handed to an unscoped (legacy) read", () => {
    saveSosIncident(owned);
    expect(loadSosIncident()).toBeNull();
    expect(loadSosIncident(null)).toBeNull();
    expect(loadSosIncident("")).toBeNull();
  });

  it("a legacy record without an owner is a mismatch for any owner-scoped read", () => {
    saveSosIncident(incident);
    expect(loadSosIncident("owner-1")).toBeNull();
    // The legacy read still sees it.
    expect(loadSosIncident()).toEqual(incident);
  });

  it("never persists coordinates or anything beyond ids, time and owner", () => {
    saveSosIncident({
      ...owned,
      ...({ latitude: 12.9, note: "help" } as Record<string, unknown>),
    } as SosIncident);
    const raw = window.localStorage.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain("latitude");
    expect(raw).not.toContain("help");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "grantIds",
      "ownerUserId",
      "startedAt",
    ]);
  });

  it("reconcile keeps only still-active grant ids", () => {
    expect(reconcileSosIncident(incident, ["g1"])).toEqual({
      grantIds: ["g1"],
      startedAt: incident.startedAt,
    });
  });

  it("reconcile keeps the owner on a narrowed record", () => {
    expect(reconcileSosIncident(owned, ["g2"])).toEqual({
      grantIds: ["g2"],
      startedAt: owned.startedAt,
      ownerUserId: "owner-1",
    });
  });

  it("reconcile returns null when no grant ids remain active", () => {
    expect(reconcileSosIncident(incident, ["other"])).toBeNull();
    expect(reconcileSosIncident(null, ["g1"])).toBeNull();
  });

  it("reconcile returns the same reference when all ids remain active", () => {
    expect(reconcileSosIncident(incident, ["g1", "g2"])).toBe(incident);
  });

  describe("reconcile against a snapshot that predates the alert", () => {
    const startedAtMs = Date.parse(incident.startedAt);

    it("never prunes against a snapshot loaded before the incident was recorded", () => {
      // Location was visited earlier (state cached), then the alert was armed
      // by voice from Home: that snapshot cannot list the new grants.
      expect(reconcileSosIncident(incident, [], startedAtMs - 1)).toBe(incident);
      expect(reconcileSosIncident(incident, ["other"], startedAtMs - 60_000)).toBe(
        incident,
      );
    });

    it("never prunes against a memory-only presentation that outlived an invalidate (null)", () => {
      expect(reconcileSosIncident(incident, [], null)).toBe(incident);
      expect(reconcileSosIncident(incident, ["g1"], null)).toBe(incident);
      expect(reconcileSosIncident(incident, [], Number.NaN)).toBe(incident);
    });

    it("prunes normally against a snapshot loaded at or after the incident", () => {
      expect(reconcileSosIncident(incident, [], startedAtMs)).toBeNull();
      expect(reconcileSosIncident(incident, ["g2"], startedAtMs + 1)).toEqual({
        grantIds: ["g2"],
        startedAt: incident.startedAt,
      });
      expect(reconcileSosIncident(incident, ["g1", "g2"], startedAtMs + 5_000)).toBe(
        incident,
      );
    });

    it("takes the snapshot at face value when no freshness is given (legacy callers)", () => {
      expect(reconcileSosIncident(incident, [], undefined)).toBeNull();
    });

    it("exposes the pure freshness decision", () => {
      expect(isSosStateFreshEnough(incident, undefined)).toBe(true);
      expect(isSosStateFreshEnough(incident, null)).toBe(false);
      expect(isSosStateFreshEnough(incident, startedAtMs - 1)).toBe(false);
      expect(isSosStateFreshEnough(incident, startedAtMs)).toBe(true);
      // An unparseable startedAt cannot veto a real load.
      expect(
        isSosStateFreshEnough({ startedAt: "not a date" }, startedAtMs),
      ).toBe(true);
    });
  });
});

describe("mergeSosGrantIds", () => {
  it("unions the incident's ids with the live SOS grants, incident first, without duplicates", () => {
    expect(
      mergeSosGrantIds({ grantIds: ["g1", "g2"] }, ["g2", "g3"]),
    ).toEqual(["g1", "g2", "g3"]);
  });

  it("works without an incident and drops blank ids", () => {
    expect(mergeSosGrantIds(null, ["g3", "", " g4 "])).toEqual(["g3", "g4"]);
    expect(mergeSosGrantIds(undefined, [])).toEqual([]);
    expect(mergeSosGrantIds({ grantIds: [] }, [])).toEqual([]);
  });

  it("keeps a grant only this device recorded even when the server no longer lists it", () => {
    // A stop must still try to revoke it; the server, not the client, decides
    // whether it is already ended.
    expect(mergeSosGrantIds({ grantIds: ["local-only"] }, ["g1"])).toEqual([
      "local-only",
      "g1",
    ]);
  });
});
