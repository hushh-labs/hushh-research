import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "@/lib/mail/mail-client";
const ENDPOINT = "https://hushh-mail-api.example.run.app";

describe("hushh-mail-api client", () => {
  const originalEndpoint = process.env.MAIL_API_ENDPOINT;
  const originalKey = process.env.MAIL_API_KEY;

  beforeEach(() => {
    process.env.MAIL_API_ENDPOINT = ENDPOINT;
    process.env.MAIL_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    if (originalEndpoint === undefined) delete process.env.MAIL_API_ENDPOINT;
    else process.env.MAIL_API_ENDPOINT = originalEndpoint;
    if (originalKey === undefined) delete process.env.MAIL_API_KEY;
    else process.env.MAIL_API_KEY = originalKey;
  });

  it("posts to /v1/send with the key in the header, never the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, messageId: "<a@hushh.ai>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendMail } = await import(MODULE_PATH);
    const result = await sendMail({
      to: "ankit@hushh.ai",
      subject: "Welcome to One",
      html: "<p>hi</p>",
      text: "hi",
      idempotencyKey: "one-welcome:uid-1",
    });

    expect(result).toEqual({ status: "sent", messageId: "<a@hushh.ai>", deduplicated: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/v1/send`);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(init.body).not.toContain("test-key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: "ankit@hushh.ai",
      subject: "Welcome to One",
      idempotencyKey: "one-welcome:uid-1",
    });
  });

  it("reports a de-duplicated send rather than claiming a fresh one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, messageId: "<a@hushh.ai>", deduplicated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { sendMail } = await import(MODULE_PATH);
    const result = await sendMail({ to: "a@b.com", subject: "s", html: "<p>x</p>" });

    expect(result).toEqual({ status: "sent", messageId: "<a@hushh.ai>", deduplicated: true });
  });

  it("does not send when the binding is missing", async () => {
    delete process.env.MAIL_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { sendMail, isMailConfigured } = await import(MODULE_PATH);

    expect(isMailConfigured()).toBe(false);
    expect(await sendMail({ to: "a@b.com", subject: "s", html: "<p>x</p>" })).toEqual({
      status: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the service's own error text on a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Unknown template" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { sendMail } = await import(MODULE_PATH);
    expect(await sendMail({ to: "a@b.com", subject: "s", html: "<p>x</p>" })).toEqual({
      status: "failed",
      reason: "Unknown template",
    });
  });

  it("turns a transport failure into a result instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    const { sendMail } = await import(MODULE_PATH);
    expect(await sendMail({ to: "a@b.com", subject: "s", html: "<p>x</p>" })).toEqual({
      status: "failed",
      reason: "fetch failed",
    });
  });
});
