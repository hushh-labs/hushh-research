/**
 * While a Mail reply is open it renews its reference before it runs out, so the
 * person is not surprised at Send. The renewal reads the original again and
 * nothing else; it stops when the recipient would change, and it dies with the
 * reply.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailOverviewError, type prepareMailReply } from "@/lib/mail/mail-overview-client";
import {
  createMailReplyBindings,
  REPLY_RENEW_LEAD_MS,
} from "@/lib/mail/mail-reply-binding";
import { REPLY_RENEW_RETRY_MS, useMailReplyRenewal } from "@/lib/mail/use-mail-reply-renewal";

const SOURCE = `ms1.${"S".repeat(43)}`;
const REF_1 = `rs1.${"1".repeat(40)}`;
const REF_2 = `rs1.${"2".repeat(40)}`;
const REF_3 = `rs1.${"3".repeat(40)}`;
const reply = (ref: string, over: Record<string, unknown> = {}) => ({
  sourceMailRef: ref,
  to: "alice@example.com",
  recipientLabel: "Alice",
  subject: "Re: Invoice",
  expiresInSeconds: 900,
  ...over,
});
const DUE_MS = 900_000 - REPLY_RENEW_LEAD_MS;

function setup(over: { reference?: string | null; vaultOwnerToken?: string | null } = {}) {
  const fetchReply = vi.fn<typeof prepareMailReply>();
  const bindings = createMailReplyBindings(() => Date.now(), fetchReply);
  bindings.register({
    ownerId: "owner-1",
    sourceId: SOURCE,
    expectedAccount: "google-sub-1",
    reply: reply(REF_1),
    issuedAtMs: Date.now(),
  });
  const onRenewed = vi.fn();
  const hook = renderHook(
    (props: { reference: string | null; vaultOwnerToken: string | null }) =>
      useMailReplyRenewal({
        bindings,
        ownerId: "owner-1",
        onRenewed,
        ...props,
      }),
    {
      initialProps: {
        reference: over.reference === undefined ? REF_1 : over.reference,
        vaultOwnerToken: over.vaultOwnerToken === undefined ? "HCT:vault" : over.vaultOwnerToken,
      },
    },
  );
  return { fetchReply, bindings, onRenewed, ...hook };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("renewing an open reply", () => {
  it("renews once, shortly before the reference expires, and not before", async () => {
    const { fetchReply, onRenewed, bindings } = setup();
    fetchReply.mockResolvedValue({ account: "google-sub-1", reply: reply(REF_2) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS - 1_000);
    });
    expect(fetchReply).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchReply).toHaveBeenCalledOnce();
    expect(fetchReply.mock.calls[0][0]).toMatchObject({ sourceId: SOURCE, expectedAccount: "google-sub-1" });
    expect(onRenewed).toHaveBeenCalledOnce();
    // The same message, a newer reference, reachable from the one the card holds.
    expect(bindings.resolve(REF_1)?.envelope.sourceMailRef).toBe(REF_2);
  });

  it("keeps renewing for as long as the reply stays open", async () => {
    const { fetchReply, onRenewed } = setup();
    fetchReply
      .mockResolvedValueOnce({ account: "google-sub-1", reply: reply(REF_2) })
      .mockResolvedValueOnce({ account: "google-sub-1", reply: reply(REF_3) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS);
    });

    expect(fetchReply).toHaveBeenCalledTimes(2);
    expect(onRenewed).toHaveBeenCalledTimes(2);
  });

  it("renews as soon as the tab is visible again after being away past the deadline", async () => {
    const { fetchReply, onRenewed } = setup();
    fetchReply.mockResolvedValue({ account: "google-sub-1", reply: reply(REF_2) });
    // The laptop slept: the clock moved on without any timer firing.
    vi.setSystemTime(Date.now() + 20 * 60_000);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchReply).toHaveBeenCalledOnce();
    expect(onRenewed).toHaveBeenCalledOnce();
  });

  it("does not renew on becoming visible while the reference is still fresh", async () => {
    const { fetchReply } = setup();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchReply).not.toHaveBeenCalled();
  });
});

describe("what renewal will not do", () => {
  it("does not swap in a different recipient: it stops and says nothing changed on screen", async () => {
    const { fetchReply, onRenewed, bindings } = setup();
    fetchReply.mockResolvedValue({
      account: "google-sub-1",
      reply: reply(REF_2, { to: "mallory@example.com" }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS * 3);
    });

    expect(onRenewed).not.toHaveBeenCalled();
    expect(fetchReply).toHaveBeenCalledOnce(); // and it did not keep asking
    expect(bindings.resolve(REF_1)?.envelope.to).toBe("alice@example.com");
  });

  it("retries a transient failure, but stops on one that will not clear by itself", async () => {
    const { fetchReply, onRenewed } = setup();
    fetchReply
      .mockRejectedValueOnce(new MailOverviewError("network"))
      .mockRejectedValueOnce(new MailOverviewError("source_unavailable"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS);
    });
    expect(fetchReply).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPLY_RENEW_RETRY_MS);
    });
    expect(fetchReply).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPLY_RENEW_RETRY_MS * 5);
    });

    expect(fetchReply).toHaveBeenCalledTimes(2); // the refusal ended it
    expect(onRenewed).not.toHaveBeenCalled();
  });

  it("does nothing for a reply that did not come from Mail, or while the vault is locked", async () => {
    const other = setup({ reference: REF_3 });
    const locked = setup({ vaultOwnerToken: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS * 2);
    });

    expect(other.fetchReply).not.toHaveBeenCalled();
    expect(locked.fetchReply).not.toHaveBeenCalled();
  });

  it("stops when the reply closes, and when the component goes away", async () => {
    const { fetchReply, rerender, unmount } = setup();
    fetchReply.mockResolvedValue({ account: "google-sub-1", reply: reply(REF_2) });

    rerender({ reference: null, vaultOwnerToken: "HCT:vault" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS * 2);
    });
    expect(fetchReply).not.toHaveBeenCalled();

    rerender({ reference: REF_1, vaultOwnerToken: "HCT:vault" });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUE_MS * 2);
    });
    expect(fetchReply).not.toHaveBeenCalled();
  });
});
