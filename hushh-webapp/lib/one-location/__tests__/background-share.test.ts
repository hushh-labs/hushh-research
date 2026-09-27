import { describe, expect, it } from "vitest";
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import type { OneLocationGrant, OneLocationRecipient } from "@/lib/one-location/types";

const grant = (over: Partial<OneLocationGrant> = {}): OneLocationGrant =>
  ({
    id: "g1",
    status: "active",
    recipientUserId: "u1",
    recipientKeyId: "k1",
    ...over,
  } as OneLocationGrant);

const recipient = (over: Partial<OneLocationRecipient> = {}): OneLocationRecipient =>
  ({
    userId: "u1",
    keyId: "k1",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    ...over,
  } as OneLocationRecipient);

describe("buildBackgroundShareSession", () => {
  it("maps active grants with a resolvable recipient key", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [grant()],
      recipients: [recipient()],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(session).toEqual({
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
      grants: [
        {
          grantId: "g1",
          recipientKeyId: "k1",
          recipientPublicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        },
      ],
    });
  });

  it("drops grants whose recipient is missing key material", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [grant()],
      recipients: [recipient({ publicKeyJwk: undefined })],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(session.grants).toEqual([]);
  });

  it("drops non-active grants", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [grant({ status: "revoked" as OneLocationGrant["status"] })],
      recipients: [recipient()],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
    });
    expect(session.grants).toEqual([]);
  });

  // The native publisher sends raw, untagged points, which the backend rejects
  // for an Approximate owner (409). SOS grants are always precise and exempt, so
  // they are the only ones native may publish under Approximate.
  it("keeps only SOS grants when sharing precision is approximate", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [
        grant({ id: "friend", shareKind: "share" }),
        grant({ id: "sos", shareKind: "sos" }),
      ],
      recipients: [recipient()],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
      precision: "approximate",
    });
    expect(session.grants.map((item) => item.grantId)).toEqual(["sos"]);
  });

  it("keeps every publishable grant when sharing precision is precise", () => {
    const session = buildBackgroundShareSession({
      activeGrants: [
        grant({ id: "friend", shareKind: "share" }),
        grant({ id: "sos", shareKind: "sos" }),
      ],
      recipients: [recipient()],
      vaultOwnerToken: "tok",
      backendBaseUrl: "https://api.example.com",
      minMoveMeters: 25,
      minIntervalMs: 8000,
      precision: "precise",
    });
    expect(session.grants.map((item) => item.grantId)).toEqual(["friend", "sos"]);
  });
});
