/**
 * Turn a request body into { subject, html, text }.
 *
 * Two modes, and the request picks one:
 *   - `template` + `data` — render a registered template
 *   - `html` (+ optional `text`) — the caller brings its own markup
 *
 * `subject` at the top level always wins, so a caller can reuse a template's
 * body with its own subject line.
 */

import { getTemplate, listTemplates } from "./templates/index.js";
import { stripHtml } from "./templates/layout.js";
import { LIMITS } from "./validate.js";

const trim = (value) => (typeof value === "string" ? value.trim() : "");

export const resolveContent = (body = {}) => {
  const requestedTemplate = trim(body.template);
  const inlineHtml = typeof body.html === "string" ? body.html : "";

  if (requestedTemplate && inlineHtml) {
    return {
      ok: false,
      error: "Send either `template` or `html`, not both",
    };
  }

  if (!requestedTemplate && !inlineHtml) {
    return {
      ok: false,
      error:
        "Provide `template` (see GET /v1/templates) or `html`. " +
        `Registered templates: ${listTemplates()
          .map((t) => t.id)
          .join(", ")}.`,
    };
  }

  let rendered;
  let templateId = null;

  if (requestedTemplate) {
    const template = getTemplate(requestedTemplate);
    if (!template) {
      return {
        ok: false,
        error: `Unknown template "${requestedTemplate}". Registered: ${listTemplates()
          .map((t) => t.id)
          .join(", ")}.`,
      };
    }

    const data = body.data && typeof body.data === "object" ? body.data : {};
    const missing = (template.required || []).filter((field) => {
      const value = data[field];
      return value === undefined || value === null || String(value).trim() === "";
    });

    if (missing.length > 0) {
      return {
        ok: false,
        error: `Template "${template.id}" requires: ${missing.join(", ")}`,
      };
    }

    try {
      rendered = template.build(data);
    } catch (error) {
      return {
        ok: false,
        error: `Template "${template.id}" failed to render: ${error?.message || "unknown error"}`,
      };
    }

    templateId = template.id;
  } else {
    rendered = {
      subject: "",
      html: inlineHtml,
      text: trim(body.text) || stripHtml(inlineHtml),
    };
  }

  const subject = trim(body.subject) || trim(rendered.subject);
  if (!subject) {
    return { ok: false, error: "subject is required when the template does not supply one" };
  }
  if (subject.length > LIMITS.maxSubjectLength) {
    return { ok: false, error: `subject exceeds ${LIMITS.maxSubjectLength} characters` };
  }

  const html = rendered.html || "";
  if (!html.trim()) {
    return { ok: false, error: "Rendered email body is empty" };
  }
  if (Buffer.byteLength(html, "utf8") > LIMITS.maxHtmlBytes) {
    return {
      ok: false,
      error: `html exceeds the ${Math.round(LIMITS.maxHtmlBytes / 1024)} KB limit`,
    };
  }

  return {
    ok: true,
    content: {
      subject,
      html,
      // A text/plain alternative measurably improves deliverability and is what
      // screen readers and watch clients fall back to.
      text: trim(body.text) || trim(rendered.text) || stripHtml(html),
      template: templateId,
    },
  };
};
