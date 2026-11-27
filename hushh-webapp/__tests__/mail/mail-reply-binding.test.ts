/**
 * A Mail reply stays on the exact original email it was opened from, however
 * long the person takes to write it. Renewal asks for the same message again,
 * never changes where the reply goes without telling them, and carries no text.
 */

import { describe, expect, it, vi } from "vitest";

import { MailOverviewError, type prepareMailReply } from "@/lib/mail/mail-overview-client";
import {
  createMailReplyBindings,
  isMailSourceId,
  REPLY_RENEW_LEAD_MS,
} from "@/lib/mail/mail-reply-binding";

const SOURCE = `ms1.${"S".repeat(43)}`;
const OTHER_SOURCE = `ms1.${"T".repeat(43)}`;
const REF_1 = `rs1.${"1".repeat(40)}`;
const REF_2 = `rs1.${"2".repeat(40)}`;
const REF_3 = `rs1.${"3".repeat(40)}`;
const TOKEN = "HCT:vault";

const reply = (ref: string, over: Record<string, unknown> = {}) => ({
  sourceMailRef: ref,
  to: "alice@example.com",
  recipientLabel: "Alice",
  subject: "Re: Invoice",
  expiresInSeconds: 900,
  ...over,
});

function setup(options: { clock?: { t: number } } = {}) {
  const clock = options.clock ?? { t: 1_000_000 };
  const fetchReply = vi.fn<typeof prepareMailReply>();
  const bindings = createMailReplyBindings(() => clock.t, fetchReply);
  const register = (over: Record<string, unknown> = {}) =>
    bindings.register({
      ownerId: "owner-1",
      sourceId: SOURCE,
      expectedAccount: "google-sub-1",
      reply: reply(REF_1),
      issuedAtMs: clock.t,
      ...over,
    } as Parameters<typeof bindings.register>[0]);
  return { bindings, fetchReply, clock, register };
}

describe("source ids", () => {
  it("accepts only the stable account-bound shape, never a reply reference or a Gmail id", () => {
    expect(isMailSourceId(SOURCE)).toBe(true);
    expect(isMailSourceId(REF_1)).toBe(false);
    expect(isMailSourceId("18c2f0a9b3d4e5f6")).toBe(false);
    expect(isMailSourceId(null)).toBe(false);
  });

  it("refuses to bind anything else, so a malformed handoff opens nothing it can renew", () => {
    const { register, bindings } = setup();
    expect(register({ sourceId: REF_1 })).toBe(false);
    expect(register({ ownerId: "" })).toBe(false);
    expect(bindings.resolve(REF_1)).toBeNull();
  });
});

describe("renewal timing", () => {
  it("is due shortly before the reference expires, by the device clock", () => {
    const { bindings, register, clock } = setup();
    register();

    expect(bindings.dueInMs(REF_1)).toBe(900_000 - REPLY_RENEW_LEAD_MS);
    expect(bindings.isDue(REF_1)).toBe(false);
    clock.t += 900_000 - REPLY_RENEW_LEAD_MS;
    expect(bindings.isDue(REF_1)).toBe(true);
  });

  it("knows nothing about a reference that did not come from Mail", () => {
    const { bindings } = setup();
    expect(bindings.dueInMs(REF_1)).toBeNull();
    expect(bindings.isDue(REF_1)).toBe(false);
    expect(bindings.resolve(REF_1)).toBeNull();
  });
});

describe("renewal keeps the exact original", () => {
  it("asks for the same stable source and account, with the vault token, and nothing else", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    fetchReply.mockResolvedValue({ account: "google-sub-1", reply: reply(REF_2) });

    const renewed = await bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });

    expect(fetchReply).toHaveBeenCalledOnce();
    expect(fetchReply).toHaveBeenCalledWith({
      vaultOwnerToken: TOKEN,
      expectedAccount: "google-sub-1",
      sourceId: SOURCE,
      signal: undefined,
    });
    expect(renewed).toMatchObject({ changed: false, adopted: true });
    expect(renewed?.envelope).toEqual({
      sourceMailRef: REF_2,
      to: "alice@example.com",
      subject: "Re: Invoice",
    });
  });

  it("resolves every reference the message was ever given to the newest one", async () => {
    const { bindings, fetchReply, register, clock } = setup();
    register();
    fetchReply.mockResolvedValueOnce({ account: "google-sub-1", reply: reply(REF_2) });
    await bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });
    clock.t += 600_000;
    fetchReply.mockResolvedValueOnce({ account: "google-sub-1", reply: reply(REF_3) });
    await bindings.renew(REF_2, { ownerId: "owner-1", vaultOwnerToken: TOKEN });

    // A draft restored from history still holds the first reference.
    for (const ref of [REF_1, REF_2, REF_3]) {
      expect(bindings.resolve(ref)?.envelope.sourceMailRef).toBe(REF_3);
    }
    // And the clock restarts from the newest reference, not the first.
    expect(bindings.dueInMs(REF_1)).toBe(900_000 - REPLY_RENEW_LEAD_MS);
  });

  it("shares one request between callers that ask at the same time", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    let release!: (value: Awaited<ReturnType<typeof prepareMailReply>>) => void;
    fetchReply.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const first = bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });
    const second = bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });
    release({ account: "google-sub-1", reply: reply(REF_2) });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchReply).toHaveBeenCalledOnce();
  });
});

describe("renewal never changes where a reply goes without telling the person", () => {
  it("holds a different recipient or subject instead of swapping it in", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    fetchReply.mockResolvedValue({
      account: "google-sub-1",
      reply: reply(REF_2, { to: "mallory@example.com" }),
    });

    const renewed = await bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });

    expect(renewed).toMatchObject({ changed: true, adopted: false });
    // What the person reviewed is still what is bound, and the change is flagged.
    expect(bindings.resolve(REF_1)).toEqual({
      envelope: { sourceMailRef: REF_1, to: "alice@example.com", subject: "Re: Invoice" },
      heldChange: true,
    });
  });

  it("adopts the change only when the caller has told the person", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    fetchReply.mockResolvedValue({
      account: "google-sub-1",
      reply: reply(REF_2, { subject: "Re: Invoice (corrected)" }),
    });

    const renewed = await bindings.renew(REF_1, {
      ownerId: "owner-1",
      vaultOwnerToken: TOKEN,
      adoptChanged: true,
    });

    expect(renewed).toMatchObject({ changed: true, adopted: true });
    expect(bindings.resolve(REF_1)).toEqual({
      envelope: {
        sourceMailRef: REF_2,
        to: "alice@example.com",
        subject: "Re: Invoice (corrected)",
      },
      heldChange: false,
    });
  });
});

describe("renewal failures and isolation", () => {
  it("passes the server's typed refusal through and leaves the binding usable", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    fetchReply.mockRejectedValueOnce(new MailOverviewError("source_unavailable"));

    await expect(
      bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN }),
    ).rejects.toMatchObject({ reason: "source_unavailable" });
    expect(bindings.resolve(REF_1)?.envelope.sourceMailRef).toBe(REF_1);

    fetchReply.mockResolvedValueOnce({ account: "google-sub-1", reply: reply(REF_2) });
    await expect(
      bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN }),
    ).resolves.toMatchObject({ adopted: true });
  });

  it("refuses a different owner without calling the server", async () => {
    const { bindings, fetchReply, register } = setup();
    register();

    await expect(
      bindings.renew(REF_1, { ownerId: "owner-2", vaultOwnerToken: TOKEN }),
    ).rejects.toMatchObject({ reason: "account_changed" });
    expect(fetchReply).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after the binding was cleared", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    let release!: (value: Awaited<ReturnType<typeof prepareMailReply>>) => void;
    fetchReply.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const pending = bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });
    bindings.clear(); // sign-out or a different owner
    release({ account: "google-sub-1", reply: reply(REF_2) });

    await expect(pending).rejects.toMatchObject({ reason: "account_changed" });
    expect(bindings.resolve(REF_2)).toBeNull();
    expect(bindings.resolve(REF_1)).toBeNull();
  });

  it("returns nothing for a reference it does not own", async () => {
    const { bindings, fetchReply } = setup();
    await expect(
      bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN }),
    ).resolves.toBeNull();
    expect(fetchReply).not.toHaveBeenCalled();
  });

  it("keeps two messages' replies apart", async () => {
    const { bindings, fetchReply, register } = setup();
    register();
    register({ sourceId: OTHER_SOURCE, reply: reply(REF_3, { to: "bob@example.com" }) });
    fetchReply.mockResolvedValue({ account: "google-sub-1", reply: reply(REF_2) });

    await bindings.renew(REF_1, { ownerId: "owner-1", vaultOwnerToken: TOKEN });

    expect(fetchReply.mock.calls[0][0].sourceId).toBe(SOURCE);
    expect(bindings.resolve(REF_3)?.envelope.to).toBe("bob@example.com");
  });
});
