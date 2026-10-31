/**
 * Contract tests for hushh-mail-api.
 *
 * Run with `npm test`. Uses the Node built-in test runner and a fake
 * transporter, so nothing here can send real mail.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createApp } from "../src/app.js";
import { resolveFrom, workspaceConfig } from "../src/mailer.js";
import { authenticate } from "../src/auth.js";
import { invitationTemplate } from "../src/templates/invitation.js";
import { safeUrl } from "../src/templates/layout.js";
import { oneOtpConfigured } from "../src/oneOtp.js";

const API_KEY = "k".repeat(43);
const OTHER_KEY = "z".repeat(43);

const BASE_ENV = {
  GMAIL_USER: "notifications@hushh.ai",
  GMAIL_APP_PASSWORD: "app-password-value",
  MAIL_API_KEY: API_KEY,
  MAIL_API_KEY_PLAYGROUND: OTHER_KEY,
  MAIL_RATE_LIMIT_PER_MINUTE: "100",
};

/** Captures every message instead of talking to SMTP. */
const createFakeTransport = () => {
  const sent = [];
  const factory = () => ({
    sendMail: async (message) => {
      sent.push(message);
      return {
        messageId: `<test-${sent.length}@hushh.ai>`,
        accepted: [].concat(message.to),
        rejected: [],
      };
    },
    verify: async () => true,
  });
  return { sent, factory };
};

let server;
let baseUrl;
let fake;

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
};

before(async () => {
  fake = createFakeTransport();
  const app = createApp({ env: BASE_ENV, transporterFactory: fake.factory });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("One delegated OTP authority", () => {
  const ONE_KEY = "o".repeat(43);
  const TOKEN = "synthetic-send-token-" + "t".repeat(30);
  it("refuses a One key duplicated into another consumer slot", () => {
    assert.equal(oneOtpConfigured({ ...BASE_ENV, MAIL_ONE_DELEGATED_ENABLED: "true",
      MAIL_API_KEY_ONE: API_KEY }), false);
  });
  const body = { transport: "one-delegated", to: "person@example.com", code: "000001",
    expiresInSeconds: 240, idempotencyKey: "email-otp:" + "c".repeat(32) };
  let oneServer, oneUrl, calls, fail;
  const post = async (payload, key = ONE_KEY, token = TOKEN) => {
    const response = await fetch(oneUrl + "/v1/send", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key,
        ...(token ? { "x-one-gmail-access-token": token } : {}) }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  before(async () => {
    calls = []; fail = false;
    const app = createApp({ env: { ...BASE_ENV, GMAIL_USER: "", GMAIL_APP_PASSWORD: "",
      MAIL_API_KEY_ONE: ONE_KEY, MAIL_ONE_DELEGATED_ENABLED: "true" },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (fail) throw new Error("provider error with " + TOKEN);
        return new Response(JSON.stringify({ id: "one-message-id" }));
      } });
    await new Promise((resolve) => { oneServer = app.listen(0, resolve); });
    oneUrl = `http://127.0.0.1:${oneServer.address().port}`;
  });
  after(async () => { await new Promise((resolve) => oneServer.close(resolve)); });

  it("requires One consumer and delegated token; never falls back to SMTP", async () => {
    assert.equal((await post(body, API_KEY)).status, 403);
    assert.equal((await post(body, ONE_KEY, null)).status, 403);
    assert.equal((await post({ ...body, cc: "other@example.com" })).status, 400);
    assert.equal((await post({ ...body, from: "other@example.com" })).status, 400);
    assert.equal((await post({ ...body, expiresInSeconds: 0 })).status, 400);
    assert.equal(calls.length, 0);
  });

  it("sends whitelisted MIME through the fixed One mailbox and deduplicates", async () => {
    const result = await post(body);
    assert.equal(result.status, 200);
    assert.equal(result.body.from, "one@hushh.ai");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/one%40hushh.ai/messages/send");
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + TOKEN);
    const mime = Buffer.from(JSON.parse(calls[0].options.body).raw, "base64url").toString();
    assert.match(mime, /From: One <one@hushh.ai>/);
    assert.match(mime, /Reply-To: one@hushh.ai/);
    assert.match(mime, /Subject: Your One sign-in code/);
    assert.doesNotMatch(mime, /Bcc:|Cc:/);
    assert.equal((await post(body)).body.deduplicated, true);
    assert.equal(calls.length, 1);
  });

  it("sanitizes delegated failure and does not invoke the SMTP route", async () => {
    fail = true;
    const result = await post({ ...body, idempotencyKey: "email-otp:" + "d".repeat(32) });
    assert.equal(result.status, 502);
    assert.equal(JSON.stringify(result.body).includes(TOKEN), false);
    assert.equal(result.body.error, "One OTP delivery failed");
  });
});

describe("auth", () => {
  it("fails closed with 503 when no key is configured", () => {
    const result = authenticate({ "x-api-key": API_KEY }, { GMAIL_USER: "a@b.com" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  });

  it("rejects a missing key with 401", async () => {
    const res = await request("/v1/send", { method: "POST", body: { to: "a@b.com" } });
    assert.equal(res.status, 401);
  });

  it("rejects a wrong key with 401", async () => {
    const res = await request("/v1/templates", { headers: { "x-api-key": "nope" } });
    assert.equal(res.status, 401);
  });

  it("accepts x-api-key and Authorization: Bearer alike", async () => {
    const viaHeader = await request("/v1/templates", { headers: { "x-api-key": API_KEY } });
    const viaBearer = await request("/v1/templates", {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(viaHeader.status, 200);
    assert.equal(viaBearer.status, 200);
  });

  it("accepts every MAIL_API_KEY* variable as an independent consumer key", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": OTHER_KEY },
      body: { to: "invitee@example.com", template: "notification", data: { heading: "Hi" } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.consumer, "playground");
  });
});

describe("health", () => {
  it("reports status without auth and without leaking configuration values", async () => {
    const res = await request("/");
    assert.equal(res.status, 200);
    assert.equal(res.body.service, "hushh-mail-api");
    assert.equal(res.body.configured.workspaceSender, true);
    assert.equal(res.body.configured.apiKeys, 2);
    assert.ok(res.body.templates.includes("invitation"));

    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(API_KEY));
    assert.ok(!serialized.includes("notifications@hushh.ai"));
    assert.ok(!serialized.includes("app-password-value"));
  });
});

describe("templates", () => {
  it("lists registered templates with their required fields", async () => {
    const res = await request("/v1/templates", { headers: { "x-api-key": API_KEY } });
    const invitation = res.body.templates.find((t) => t.id === "invitation");
    assert.deepEqual(invitation.required, ["actionUrl"]);
  });

  it("rejects an unknown template with 400", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: { to: "a@b.com", template: "does-not-exist" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unknown template/);
  });

  it("rejects a template that is missing a required field", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: { to: "a@b.com", template: "invitation", data: { inviteeName: "Ada" } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /requires: actionUrl/);
  });

  it("rejects sending both template and html", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: { to: "a@b.com", template: "notification", html: "<p>hi</p>" },
    });
    assert.equal(res.status, 400);
  });
});

describe("invitation template", () => {
  it("renders subject, CTA and details from data", () => {
    const result = invitationTemplate.build({
      inviteeName: "Ada Lovelace",
      inviterName: "Ankit Kumar Singh",
      organizationName: "Hushh Fund A",
      role: "Limited Partner",
      actionUrl: "https://hushhtech.com/invite/abc123",
      actionLabel: "View invitation",
      expiresAt: "August 20, 2026",
    });

    assert.equal(result.subject, "Ankit Kumar Singh invited you to Hushh Fund A");
    assert.match(result.html, /Ada Lovelace, you&#39;re invited/);
    assert.match(result.html, /https:\/\/hushhtech\.com\/invite\/abc123/);
    assert.match(result.html, /View invitation/);
    assert.match(result.html, /Limited Partner/);
    assert.match(result.html, /expires on August 20, 2026/);
    // Plain-text alternative is always present.
    assert.match(result.text, /Hushh Fund A/);
  });

  it("escapes HTML in caller-supplied data", () => {
    const result = invitationTemplate.build({
      inviteeName: '<script>alert("xss")</script>',
      actionUrl: "https://hushhtech.com/invite/x",
    });
    assert.ok(!result.html.includes("<script>"));
    assert.match(result.html, /&lt;script&gt;/);
  });

  it("refuses a javascript: CTA rather than sending a link-less invitation", async () => {
    assert.equal(safeUrl("javascript:alert(1)"), "#");
    assert.equal(safeUrl("https://hushhtech.com/x"), "https://hushhtech.com/x");

    assert.throws(
      () => invitationTemplate.build({ actionUrl: "javascript:alert(1)" }),
      /actionUrl must be an http\(s\) URL/
    );

    // and the API surfaces it as a 400, never a partially rendered send
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: {
        to: "a@example.com",
        template: "invitation",
        data: { actionUrl: "javascript:alert(1)" },
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /failed to render/);
  });
});

describe("send", () => {
  it("sends a rendered invitation through the Workspace transport", async () => {
    const before = fake.sent.length;
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: {
        to: [{ email: "invitee@example.com", name: "Ada" }],
        template: "invitation",
        data: {
          inviterName: "Ankit",
          organizationName: "Hushh",
          actionUrl: "https://hushhtech.com/invite/abc",
        },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.template, "invitation");

    const message = fake.sent[before];
    assert.deepEqual(message.to, ['"Ada" <invitee@example.com>']);
    assert.equal(message.from, '"Hushh" <notifications@hushh.ai>');
    assert.ok(message.html.includes("Hushh"));
    assert.ok(message.text.length > 0);
  });

  it("rewrites a from address that Gmail would not honour, and says so", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: {
        to: "a@example.com",
        from: { name: "Spoof", email: "ceo@othercompany.com" },
        template: "notification",
        data: { heading: "Hello" },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(fake.sent.at(-1).from, '"Hushh" <notifications@hushh.ai>');
    assert.match(res.body.warnings[0], /not the Workspace sender/);
  });

  it("honours a configured alias", () => {
    const config = workspaceConfig({
      ...BASE_ENV,
      MAIL_ALLOWED_FROM: "invites@hushh.ai,team@hushh.ai",
    });
    const { from, warning } = resolveFrom({ name: "Hushh Invites", email: "invites@hushh.ai" }, config);
    assert.equal(warning, null);
    assert.deepEqual(from, { name: "Hushh Invites", email: "invites@hushh.ai" });
  });

  it("accepts raw html for callers that bring their own markup", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: {
        to: "a@example.com",
        subject: "Custom",
        html: "<p>Bring your own markup</p>",
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.template, null);
    assert.equal(fake.sent.at(-1).html, "<p>Bring your own markup</p>");
    // Text alternative is derived when the caller does not supply one.
    assert.equal(fake.sent.at(-1).text, "Bring your own markup");
  });

  it("previews without sending when dryRun is set", async () => {
    const before = fake.sent.length;
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: {
        to: "a@example.com",
        template: "invitation",
        data: { actionUrl: "https://hushhtech.com/i/1" },
        dryRun: true,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.ok(res.body.html.includes("invited"));
    assert.equal(fake.sent.length, before, "dryRun must not send");
  });

  it("de-duplicates retries that reuse an idempotency key", async () => {
    const body = {
      to: "dedupe@example.com",
      template: "notification",
      data: { heading: "Once only" },
      idempotencyKey: "invite-42",
    };

    const first = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body,
    });
    const sentAfterFirst = fake.sent.length;
    const second = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.deduplicated, true);
    assert.equal(second.body.messageId, first.body.messageId);
    assert.equal(fake.sent.length, sentAfterFirst, "retry must not send twice");
  });

  it("validates recipients", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: { to: "not-an-email", template: "notification", data: { heading: "x" } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid email/);
  });

  it("requires at least one recipient", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: { template: "notification", data: { heading: "x" } },
    });
    assert.equal(res.status, 400);
  });

  it("rejects an attachment whose filename contains a path", async () => {
    const res = await request("/v1/send", {
      method: "POST",
      headers: { "x-api-key": API_KEY },
      body: {
        to: "a@example.com",
        template: "notification",
        data: { heading: "x" },
        attachments: [{ filename: "../../etc/passwd", content: "aGk=" }],
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must not contain a path/);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the per-key limit is spent", async () => {
    const limited = createApp({
      env: { ...BASE_ENV, MAIL_RATE_LIMIT_PER_MINUTE: "2" },
      transporterFactory: createFakeTransport().factory,
    });
    const local = limited.listen(0);
    const url = `http://127.0.0.1:${local.address().port}/v1/send`;

    const send = () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          to: "a@example.com",
          template: "notification",
          data: { heading: "x" },
        }),
      });

    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);

    const third = await send();
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after")) > 0);

    await new Promise((resolve) => local.close(resolve));
  });
});
