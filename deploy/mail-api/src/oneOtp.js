/** Narrow One OTP port. No SMTP fallback, raw MIME, caller templates or storage. */
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { isValidEmail } from "./validate.js";
import { loadApiKeys } from "./auth.js";

const ONE = "one@hushh.ai";
const FIELDS = new Set(["transport", "to", "code", "expiresInSeconds", "idempotencyKey"]);

export const oneOtpConfigured = (env) => env.MAIL_ONE_DELEGATED_ENABLED === "true"
  && typeof env.MAIL_API_KEY_ONE === "string" && env.MAIL_API_KEY_ONE.trim().length >= 16
  && loadApiKeys(env).filter((slot) => slot.key === env.MAIL_API_KEY_ONE.trim()).length === 1;

export const createOneOtpHandler = ({ env, rateLimiter, idempotency, now, fetchImpl = fetch }) =>
  async (req, res, consumer) => {
    const token = req.headers["x-one-gmail-access-token"];
    if (!oneOtpConfigured(env)) {
      return res.status(503).json({ error: "One sender is unavailable" });
    }
    if (consumer !== "one" || typeof token !== "string"
        || !/^[A-Za-z0-9._~-]{20,4096}$/.test(token)) {
      return res.status(403).json({ error: "One sender authorization required" });
    }
    const body = req.body;
    if (Object.keys(body).some((key) => !FIELDS.has(key))
        || typeof body.to !== "string" || body.to.length > 254 || !isValidEmail(body.to)
        || /[\s<>()"\[\]\\]/.test(body.to)
        || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)
        || !Number.isInteger(body.expiresInSeconds) || body.expiresInSeconds < 15 || body.expiresInSeconds > 300
        || typeof body.idempotencyKey !== "string"
        || !/^email-otp:[A-Za-z0-9_-]{20,100}$/.test(body.idempotencyKey)) {
      return res.status(400).json({ error: "Invalid One OTP request" });
    }
    const key = "one-delegated:" + body.idempotencyKey;
    const prior = idempotency.get(consumer, key, now());
    if (prior) return res.status(200).json({ ...prior.result, deduplicated: true });
    const limit = rateLimiter.check(consumer, 1, now());
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return res.status(429).json({ error: "Rate limit exceeded" });
    }
    try {
      const message = new MailComposer({
        from: `"One" <${ONE}>`, replyTo: ONE, to: body.to,
        subject: "Your One sign-in code",
        text: `Your One sign-in code is ${body.code}.\n\nIt expires shortly. Do not share it. If you did not request it, ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto"><h1>Sign in to One</h1><p style="font-size:36px;letter-spacing:8px">${body.code}</p><p>It expires shortly. Do not share it.</p><p>If you did not request it, ignore this email.</p></div>`,
        disableFileAccess: true, disableUrlAccess: true,
      }).compile();
      const mime = await new Promise((resolve, reject) => message.build((error, value) =>
        error ? reject(error) : resolve(value)));
      const response = await fetchImpl(
        "https://gmail.googleapis.com/gmail/v1/users/one%40hushh.ai/messages/send", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: mime.toString("base64url") }),
        });
      if (!response.ok) throw new Error("One delivery failed");
      const payload = await response.json();
      if (typeof payload.id !== "string" || !payload.id) throw new Error("One delivery failed");
      const result = { success: true, messageId: payload.id, from: ONE,
        consumer, accepted: [body.to], rejected: [] };
      idempotency.set(consumer, key, result, now());
      console.log("hushh-mail-api: sent template=one-otp consumer=one recipients=1");
      return res.status(200).json(result);
    } catch {
      // Provider errors may include request metadata. Never expose or log them.
      console.error("hushh-mail-api: One OTP delivery failed");
      return res.status(502).json({ error: "One OTP delivery failed" });
    }
  };
