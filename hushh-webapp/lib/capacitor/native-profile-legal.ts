import { LEGAL_DOCUMENTS, type LegalDocumentType, type LegalInline } from "@/lib/legal/legal-documents";

/** A Legal reader, not an arbitrary UI schema. URLs stay with the authored
 * document in React; native receives only current fenced action handles. */
export type NativeLegalInline = { text: string; actionId?: string };
export type NativeLegalBlock = { kind: "p"; text: NativeLegalInline[] } |
  { kind: "h"; text: string } | { kind: "list"; items: NativeLegalInline[][] };
export type NativeLegalDocument = {
  type: LegalDocumentType; version: string; effectiveDate: string; summary: string;
  sections: { id: string; title: string; blocks: NativeLegalBlock[] }[];
  related: { label: string; actionId: string };
};

export function projectNativeLegalDocument(type: LegalDocumentType) {
  const doc = LEGAL_DOCUMENTS[type];
  const links = new Map<string, string>();
  const inline = (parts: LegalInline[]): NativeLegalInline[] => parts.map(part => {
    if (typeof part === "string") return { text: part };
    const actionId = `legal-${type}-link-${links.size}`;
    links.set(actionId, part.href);
    return { text: part.text, actionId };
  });
  const other = type === "privacy" ? "terms" : "privacy";
  const document: NativeLegalDocument = {
    type, version: doc.version, effectiveDate: doc.lastUpdatedLabel, summary: doc.summary,
    sections: doc.sections.map(section => ({ ...section, blocks: section.blocks.map(block =>
      block.kind === "p" ? { kind: "p", text: inline(block.text) } :
        block.kind === "list" ? { kind: "list", items: block.items.map(inline) } : { ...block }) })),
    related: { label: LEGAL_DOCUMENTS[other].title, actionId: `legal-${type}-related` },
  };
  links.set(document.related.actionId, LEGAL_DOCUMENTS[other].route);
  return { document, links };
}

const shape = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Count, size, closed-shape and action uniqueness are checked before bridge
 * admission. Reject rather than silently truncate a legal document. */
export function validNativeLegalDocument(value: NativeLegalDocument): boolean {
  if (!record(value) || !shape(value, ["type", "version", "effectiveDate", "summary", "sections", "related"]) ||
      !["privacy", "terms"].includes(value.type) || !text(value.version, 32) || !text(value.effectiveDate, 128) ||
      !text(value.summary, 4096) || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > 64 ||
      !record(value.related) || !shape(value.related, ["label", "actionId"]) || !text(value.related.label, 256) ||
      !text(value.related.actionId, 128)) return false;
  const actions = new Set([value.related.actionId]), sections = new Set<string>();
  let length = 0, blocks = 0, runs = 0;
  const validInline = (parts: NativeLegalInline[]): boolean => Array.isArray(parts) && parts.length > 0 && parts.length <= 128 && parts.every(part => {
    if (++runs > 4096 || !record(part) || !shape(part, ["text", "actionId"]) || !text(part.text, 16384)) return false;
    length += part.text.length;
    if (part.actionId === undefined) return true;
    if (!text(part.actionId, 128) || actions.has(part.actionId)) return false;
    actions.add(part.actionId); return true;
  });
  return value.sections.every(section => {
    if (!record(section) || !shape(section, ["id", "title", "blocks"]) || !text(section.id, 128) || sections.has(section.id) ||
        !text(section.title, 256) || !Array.isArray(section.blocks) || !section.blocks.length || section.blocks.length > 128) return false;
    sections.add(section.id);
    return section.blocks.every(block => {
      if (++blocks > 1024 || !record(block)) return false;
      if (block.kind === "h") return shape(block, ["kind", "text"]) && text(block.text, 256);
      if (block.kind === "p") return shape(block, ["kind", "text"]) && validInline(block.text);
      return block.kind === "list" && shape(block, ["kind", "items"]) && Array.isArray(block.items) &&
        block.items.length > 0 && block.items.length <= 128 && block.items.every(validInline);
    });
  }) && length <= 262144;
}

export function nativeLegalActionIds(doc: NativeLegalDocument): string[] {
  return [doc.related.actionId, ...doc.sections.flatMap(section => section.blocks.flatMap(block =>
    block.kind === "h" ? [] : (block.kind === "p" ? block.text : block.items.flat()).flatMap(part => part.actionId ? [part.actionId] : [])))];
}
