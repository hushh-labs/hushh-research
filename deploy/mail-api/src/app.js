/**
 * hushh-mail-api — the standalone mail-sending service.
 *
 * Contract (mirrors hushh-wallet-api):
 *
 *   GET  /                health + configuration status (no auth)
 *   GET  /v1/templates    registered templates and their fields (auth)
 *   POST /v1/send         render a template (or take raw html) and send (auth)
 *
 * Auth is a 256-bit API key in `x-api-key` or `Authorization: Bearer`. CORS is
 * open and there is no origin allowlist — the key is the control, not the
 * origin — so a new Hushh project integrates by receiving a key, with no
 * change to this service.
 */

import express from "express";
import cors from "cors";

import { authenticate, loadApiKeys } from "./auth.js";
import {
  formatAddress,
  getTransporter,
  isConfigured,
  resolveFrom,
  workspaceConfig,
} from "./mailer.js";
import { resolveContent } from "./render.js";
import { createIdempotencyStore, createRateLimiter } from "./rateLimit.js";
import { listTemplates } from "./templates/index.js";
import { normalizeRecipients, validateEnvelope } from "./validate.js";
import { createOneOtpHandler, oneOtpConfigured } from "./oneOtp.js";

const SERVICE_NAME = "hushh-mail-api";
const SERVICE_VERSION = "1.1.0";

export const createApp = ({
  env = process.env,
  transporterFactory = undefined,
  now = () => Date.now(),
  fetchImpl = fetch,
} = {}) => {
  const app = express();

  const rateLimiter = createRateLimiter({
    limit: Number.parseInt(env.MAIL_RATE_LIMIT_PER_MINUTE ?? "60", 10),
  });
  const idempotency = createIdempotencyStore();
  const oneOtp = createOneOtpHandler({ env, rateLimiter, idempotency, now, fetchImpl });

  app.disable("x-powered-by");
  app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], maxAge: 3600 }));
  // Attachments arrive base64-encoded in JSON, so the body ceiling has to clear
  // the 10 MB decoded attachment limit plus encoding overhead.
  app.use(express.json({ limit: "20mb" }));

  const requireAuth = (req, res) => {
    const result = authenticate(req.headers, env);
    if (!result.ok) {
      if (result.status === 503) {
        console.error(`${SERVICE_NAME}: no MAIL_API_KEY* is configured; refusing all requests`);
      }
      res.status(result.status).json({ error: result.error });
      return null;
    }
    return result.consumer;
  };

  // ---------------------------------------------------------------- health

  app.get("/", (_req, res) => {
    const config = workspaceConfig(env);
    res.json({
      status: "healthy",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      transport: "google-workspace-gmail-smtp",
      // Booleans and counts only — never the sender address or key material.
      configured: {
        workspaceSender: isConfigured(config),
        apiKeys: loadApiKeys(env).length,
        oneDelegatedOtp: oneOtpConfigured(env),
      },
      templates: listTemplates().map((template) => template.id),
      endpoints: ["GET /v1/templates", "POST /v1/send"],
    });
  });

  // ------------------------------------------------------------- templates

  app.get("/v1/templates", (req, res) => {
    const consumer = requireAuth(req, res);
    if (!consumer) return;

    res.json({ templates: listTemplates() });
  });

  // ------------------------------------------------------------------ send

  app.post("/v1/send", async (req, res) => {
    const consumer = requireAuth(req, res);
    if (!consumer) return;

    if (req.body?.transport === "one-delegated") return oneOtp(req, res, consumer);
    if (req.headers["x-one-gmail-access-token"]) {
      return res.status(400).json({ error: "One authorization requires the One transport" });
    }

    const config = workspaceConfig(env);
    if (!isConfigured(config)) {
      console.error(`${SERVICE_NAME}: GMAIL_USER/GMAIL_APP_PASSWORD are not bound`);
      return res.status(503).json({ error: "Mail transport is not configured" });
    }

    const body = req.body;

    const envelope = validateEnvelope(body);
    if (!envelope.ok) return res.status(400).json({ error: envelope.error });

    const content = resolveContent(body);
    if (!content.ok) return res.status(400).json({ error: content.error });

    const recipientCount =
      envelope.envelope.to.length + envelope.envelope.cc.length + envelope.envelope.bcc.length;

    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    const dryRun = body.dryRun === true || body.preview === true;

    if (!dryRun && idempotencyKey) {
      const prior = idempotency.get(consumer, idempotencyKey, now());
      if (prior) {
        return res.status(200).json({ ...prior.result, deduplicated: true });
      }
    }

    // Dry run short-circuits before the rate limiter: previewing markup costs
    // no quota and integrating projects lean on it heavily.
    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        consumer,
        template: content.content.template,
        subject: content.content.subject,
        html: content.content.html,
        text: content.content.text,
        to: envelope.envelope.to,
      });
    }

    const limit = rateLimiter.check(consumer, recipientCount, now());
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({
        error: "Rate limit exceeded",
        detail: `${limit.limit} recipients per minute per API key`,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const { from, warning } = resolveFrom(body.from, config);
    const replyToResult = normalizeRecipients(
      body.replyTo || config.defaultReplyTo,
      "replyTo"
    );

    try {
      const transporter = getTransporter(config, transporterFactory);
      const info = await transporter.sendMail({
        from: formatAddress(from),
        to: envelope.envelope.to,
        ...(envelope.envelope.cc.length > 0 ? { cc: envelope.envelope.cc } : {}),
        ...(envelope.envelope.bcc.length > 0 ? { bcc: envelope.envelope.bcc } : {}),
        ...(replyToResult.ok && replyToResult.recipients.length > 0
          ? { replyTo: replyToResult.recipients.join(", ") }
          : {}),
        subject: content.content.subject,
        html: content.content.html,
        text: content.content.text,
        ...(envelope.envelope.attachments.length > 0
          ? { attachments: envelope.envelope.attachments }
          : {}),
      });

      const result = {
        success: true,
        messageId: info?.messageId ?? null,
        template: content.content.template,
        subject: content.content.subject,
        consumer,
        accepted: info?.accepted ?? [],
        rejected: info?.rejected ?? [],
        ...(warning ? { warnings: [warning] } : {}),
      };

      if (idempotencyKey) idempotency.set(consumer, idempotencyKey, result, now());

      // Recipients are deliberately absent from the log line; consumer and
      // template are enough to trace abuse without logging who was mailed.
      console.log(
        `${SERVICE_NAME}: sent template=${content.content.template ?? "custom"} ` +
          `consumer=${consumer} recipients=${recipientCount}`
      );

      return res.status(200).json(result);
    } catch (error) {
      console.error(`${SERVICE_NAME}: send failed for consumer=${consumer}:`, error?.message);

      // 502: the request was well-formed, the upstream SMTP hop failed.
      return res.status(502).json({
        error: "Failed to send email",
        detail: error?.message || "Unknown SMTP error",
      });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // Express needs the 4-arity signature to recognise this as an error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large" });
    }
    if (error instanceof SyntaxError) {
      return res.status(400).json({ error: "Request body is not valid JSON" });
    }
    console.error(`${SERVICE_NAME}: unhandled error:`, error?.message);
    return res.status(500).json({ error: "Internal error" });
  });

  return app;
};
