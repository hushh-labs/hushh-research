import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { syncOneLocationContactSignals } from "@/lib/one-location/contact-signals";
import { googlePeopleContactSource } from "@/lib/contacts/google-people-source";
import {
  normalizeInviteEmail,
  type InviteCandidate,
} from "../invitation-candidates";
import type { HushhContactRecord } from "@/lib/capacitor";

const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("@/lib/capacitor", () => ({ HushhContacts: {} }));
vi.mock("@/lib/capacitor/platform", () => ({
  isWeb: () => true,
  isNative: () => false,
}));
vi.mock("@/lib/services/connections-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/connections-service")>()),
  ConnectionsService: { syncContacts: sync },
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "true");
  vi.stubGlobal("crypto", webcrypto);
  sync.mockReset().mockResolvedValue({ matches: [] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function run(
  contacts: HushhContactRecord[],
  callback: (rows: InviteCandidate[]) => void,
) {
  return syncOneLocationContactSignals({
    idToken: "test-token",
    accountPhoneNumber: "+14155550000",
    accountEmail: "owner@example.com",
    onInviteCandidates: callback,
    source: async () => ({
      contacts,
      sourcePlatform: "google",
      defaultRegion: "US",
      limited: false,
      truncated: false,
    }),
  });
}

describe("private invitation candidates", () => {
  it("excludes malformed email-only destinations and normalizes international domains", async () => {
    const invalid = [
      "alice@example..com",
      "alice@exam/ple.com",
      "alice@-example.com",
      "alice@example-.com",
      "a..b@example.com",
      ".alice@example.com",
      "alice@exam:443.ple.com",
      "alice@127.0.0.1",
    ];
    for (const email of invalid) expect(normalizeInviteEmail(email)).toBeNull();
    expect(normalizeInviteEmail("priya@bücher.de")).toBe(
      "priya@xn--bcher-kva.de",
    );
    const receive = vi.fn();
    await run(
      invalid.map((email) => ({ phoneNumbers: [], emailAddresses: [email] })),
      receive,
    );
    expect(receive).toHaveBeenCalledWith([]);
  });
  it("retains only fully unmatched and genuinely phone-free email rows without leaking raw details", async () => {
    sync.mockImplementation(async ({ lookups }) => ({
      matches: [
        {
          lookupId: lookups[0].lookupId,
          userId: "matched",
          outcome: "suppressed",
        },
      ],
      indeterminateLookupIds: [lookups[3].lookupId],
    }));
    const receive = vi.fn();
    const result = await run(
      [
        {
          id: "matched",
          displayName: "Matched private",
          phoneNumbers: ["+14155550101", "+14155550102"],
        },
        {
          id: "eligible",
          displayName: "Invite private",
          phoneNumbers: ["+14155550103"],
          emailAddresses: ["person@EXAMPLE.com"],
        },
        {
          id: "unknown",
          phoneNumbers: ["+14155550104"],
          emailAddresses: ["unknown@example.com"],
        },
        {
          id: "invalid",
          phoneNumbers: ["not-a-number"],
          emailAddresses: ["invalid@example.com"],
        },
        {
          id: "email",
          phoneNumbers: [],
          emailAddresses: ["email@example.com"],
        },
        {
          id: "self",
          phoneNumbers: ["+14155550000"],
          emailAddresses: ["self@example.com"],
        },
      ],
      receive,
    );
    const candidates = receive.mock.calls[0]![0] as InviteCandidate[];
    expect(candidates.map((row) => row.id)).toEqual(["eligible:2", "email:5"]);
    expect(candidates[0]?.destinations).toEqual([
      { kind: "phone", value: "+14155550103" },
      { kind: "email", value: "person@example.com" },
    ]);
    expect(candidates[1]?.classification).toBe("email_only");
    expect(result.inviteCandidateCount).toBe(1);
    const boundary = JSON.stringify({ requests: sync.mock.calls, result });
    expect(boundary).not.toContain("+1415555");
    expect(boundary).not.toContain("@example.com");
    expect(boundary).not.toContain("Invite private");
    expect(result).not.toHaveProperty("inviteCandidates");
  });

  it("disables recipient retention and Google email collection when the flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "false");
    const receive = vi.fn();
    await run([{ phoneNumbers: ["+14155550103"] }], receive);
    expect(receive).not.toHaveBeenCalled();
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connections: [
          {
            phoneNumbers: [],
            emailAddresses: [{ value: "private@example.com" }],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const result = await googlePeopleContactSource("browser-only")({
      limit: 100,
    });
    expect(
      new URL(fetch.mock.calls[0]![0]).searchParams.get("personFields"),
    ).toBe("names,phoneNumbers");
    expect(result.contacts[0]).not.toHaveProperty("emailAddresses");
  });

  it("reads Google emails only in the browser when enabled", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connections: [
          {
            phoneNumbers: [],
            emailAddresses: [{ value: "private@example.com" }],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const result = await googlePeopleContactSource("browser-only")({
      limit: 100,
    });
    expect(new URL(fetch.mock.calls[0]![0]).hostname).toBe(
      "people.googleapis.com",
    );
    expect(
      new URL(fetch.mock.calls[0]![0]).searchParams.get("personFields"),
    ).toBe("names,phoneNumbers,emailAddresses");
    expect(result.contacts[0]?.emailAddresses).toEqual(["private@example.com"]);
  });

  it("does not classify an ambiguous failed batch as inviteable", async () => {
    sync.mockRejectedValue(new TypeError("network failure"));
    const receive = vi.fn();
    const result = await run(
      [
        {
          phoneNumbers: ["+14155550103"],
          emailAddresses: ["private@example.com"],
        },
      ],
      receive,
    );
    expect(result.mutationOutcomeUnknown).toBe(true);
    expect(receive).toHaveBeenCalledWith([]);
  });

  it("excludes the known account email and original malformed Google phone entries", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connections: [
          {
            resourceName: "invalid",
            phoneNumbers: [{ canonicalForm: "malformed" }],
            emailAddresses: [{ value: "invalid@example.com" }],
          },
          {
            resourceName: "self",
            emailAddresses: [{ value: "OWNER@example.com" }],
          },
          {
            resourceName: "eligible",
            emailAddresses: [
              { value: "owner@example.com" },
              { value: "other@example.com" },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const source = await googlePeopleContactSource("browser-only")({
      limit: 100,
    });
    expect(source.contacts[0]?.hasPhoneEntries).toBe(true);
    const receive = vi.fn();
    await run(source.contacts, receive);
    expect(receive.mock.calls[0]![0]).toEqual([
      {
        id: "eligible:3",
        displayName: "Contact",
        classification: "email_only",
        destinations: [{ kind: "email", value: "other@example.com" }],
      },
    ]);
  });
});
