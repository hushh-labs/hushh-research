/**
 * Request validation.
 *
 * The wallet API's KT lists "zero input validation" as a defect not to port, so
 * every caller-supplied field is checked here and the handler stays thin.
 */

export const LIMITS = {
  // Workspace counts each recipient against the daily cap, so a single request
  // fanning out to hundreds of addresses is almost always a mistake.
  maxRecipients: 50,
  maxSubjectLength: 998, // RFC 5322 line-length ceiling
  maxHtmlBytes: 512 * 1024,
  maxAttachments: 10,
  // Gmail rejects messages over ~25 MB; base64 inflates by ~4/3, so cap the
  // decoded total well under it.
  maxAttachmentBytes: 10 * 1024 * 1024,
};

// Deliberately permissive: RFC 5322 allows far more than the common subset, and
// the SMTP server is the real authority. This only catches obvious junk.
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export const isValidEmail = (value) =>
  typeof value === "string" && EMAIL_PATTERN.test(value.trim());

/**
 * Accepts "a@b.com", "a@b.com, c@d.com", ["a@b.com"], or
 * [{email, name}] and returns a de-duplicated list of RFC addresses.
 */
export const normalizeRecipients = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return { ok: true, recipients: [] };
  }

  const raw = Array.isArray(value) ? value : String(value).split(",");
  const recipients = [];
  const seen = new Set();

  for (const entry of raw) {
    const email =
      typeof entry === "string" ? entry.trim() : String(entry?.email || entry?.address || "").trim();
    const name = typeof entry === "object" && entry?.name ? String(entry.name).trim() : "";

    if (!email) continue;
    if (!isValidEmail(email)) {
      return { ok: false, error: `${field} contains an invalid email address: ${email}` };
    }

    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    recipients.push(name ? `"${name.replace(/"/g, "")}" <${email}>` : email);
  }

  if (recipients.length > LIMITS.maxRecipients) {
    return {
      ok: false,
      error: `${field} exceeds the ${LIMITS.maxRecipients}-recipient limit for a single request`,
    };
  }

  return { ok: true, recipients };
};

export const validateAttachments = (value) => {
  if (value === undefined || value === null) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, error: "attachments must be an array" };
  if (value.length > LIMITS.maxAttachments) {
    return { ok: false, error: `at most ${LIMITS.maxAttachments} attachments are allowed` };
  }

  const attachments = [];
  let totalBytes = 0;

  for (const [index, entry] of value.entries()) {
    const filename = String(entry?.filename || "").trim();
    const content = entry?.content;

    if (!filename) {
      return { ok: false, error: `attachments[${index}].filename is required` };
    }
    // Path separators in a filename are never legitimate and can confuse
    // downstream consumers that save the part to disk.
    if (/[/\\]/.test(filename)) {
      return { ok: false, error: `attachments[${index}].filename must not contain a path` };
    }
    if (typeof content !== "string" || !content) {
      return { ok: false, error: `attachments[${index}].content must be a base64 string` };
    }

    let buffer;
    try {
      buffer = Buffer.from(content, "base64");
    } catch {
      return { ok: false, error: `attachments[${index}].content is not valid base64` };
    }
    if (buffer.length === 0) {
      return { ok: false, error: `attachments[${index}].content decoded to zero bytes` };
    }

    totalBytes += buffer.length;
    if (totalBytes > LIMITS.maxAttachmentBytes) {
      return {
        ok: false,
        error: `attachments exceed the ${Math.round(
          LIMITS.maxAttachmentBytes / (1024 * 1024)
        )} MB total limit`,
      };
    }

    attachments.push({
      filename,
      content: buffer,
      ...(entry?.contentType ? { contentType: String(entry.contentType) } : {}),
      ...(entry?.cid ? { cid: String(entry.cid) } : {}),
    });
  }

  return { ok: true, attachments };
};

export const validateEnvelope = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const to = normalizeRecipients(body.to, "to");
  if (!to.ok) return to;
  if (to.recipients.length === 0) {
    return { ok: false, error: "to is required and must contain at least one recipient" };
  }

  const cc = normalizeRecipients(body.cc, "cc");
  if (!cc.ok) return cc;

  const bcc = normalizeRecipients(body.bcc, "bcc");
  if (!bcc.ok) return bcc;

  if (body.replyTo !== undefined && body.replyTo !== null && body.replyTo !== "") {
    const replyTo = normalizeRecipients(body.replyTo, "replyTo");
    if (!replyTo.ok) return replyTo;
  }

  const attachments = validateAttachments(body.attachments);
  if (!attachments.ok) return attachments;

  return {
    ok: true,
    envelope: {
      to: to.recipients,
      cc: cc.recipients,
      bcc: bcc.recipients,
      attachments: attachments.attachments,
    },
  };
};
