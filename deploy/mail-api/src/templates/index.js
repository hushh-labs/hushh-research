/**
 * Template registry.
 *
 * Adding a template is the whole extension story for this service:
 *
 *   1. create `src/templates/<id>.js` exporting `{ id, description, required,
 *      fields, build(data) -> { subject, html, text } }`
 *   2. import it here and add it to TEMPLATES
 *   3. redeploy
 *
 * `GET /v1/templates` reflects the registry automatically, so a consuming
 * project discovers new templates without anyone updating a second document.
 *
 * Callers that need something the registry does not cover send `html` (and
 * optionally `text`) directly — see `resolveContent` in ../render.js.
 */

import { invitationTemplate } from "./invitation.js";
import { notificationTemplate } from "./notification.js";
import { verificationTemplate } from "./verification.js";

const REGISTERED = [invitationTemplate, notificationTemplate, verificationTemplate];

export const TEMPLATES = new Map(REGISTERED.map((template) => [template.id, template]));

export const getTemplate = (id) => TEMPLATES.get(String(id || "").trim().toLowerCase()) || null;

export const listTemplates = () =>
  REGISTERED.map(({ id, description, required, fields }) => ({
    id,
    description,
    required: required || [],
    fields: fields || {},
  }));
