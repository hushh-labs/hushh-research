/**
 * Appends a new note entity to a domain's decrypted data under a `notes`
 * scope, without touching anything else already there. Shared by Sage's
 * miscategorization-fix action and its "save this research" action -- both
 * write a plain note into an existing PKM domain via PkmWriteCoordinator.
 */
export function addNoteEntity(
  currentDomainData: Record<string, unknown>,
  noteText: string,
  source: string,
): Record<string, unknown> {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const notesScope =
    cloned.notes && typeof cloned.notes === "object" && !Array.isArray(cloned.notes)
      ? (cloned.notes as Record<string, unknown>)
      : ((cloned.notes = {}) as Record<string, unknown>);
  const entities =
    notesScope.entities && typeof notesScope.entities === "object" && !Array.isArray(notesScope.entities)
      ? (notesScope.entities as Record<string, unknown>)
      : ((notesScope.entities = {}) as Record<string, unknown>);
  const entityId = `sage_${source}_${Date.now()}`;
  const nowIso = new Date().toISOString();
  entities[entityId] = {
    entity_id: entityId,
    observations: [noteText],
    status: "active",
    created_at: nowIso,
    updated_at: nowIso,
    source,
  };
  return cloned;
}

/**
 * The domain summary fields (readable_highlights etc.) are what the Notes
 * Archive, the per-domain Sage card text, and the PKM natural-language
 * panel actually read -- NOT the raw entity written by addNoteEntity above.
 * Every write that calls addNoteEntity must also merge this in, or the note
 * is really saved but invisible everywhere in the app.
 */
export function buildSageNoteSummaryPatch(params: {
  displayName: string;
  existingHighlights: string[];
  noteText: string;
}): Record<string, unknown> {
  const highlightLine = `Saved from your note: ${params.noteText}`;
  const highlights = [...params.existingHighlights, highlightLine].slice(-30);
  return {
    readable_summary: `Sage added a note to your ${params.displayName} memory.`,
    readable_highlights: highlights,
    readable_updated_at: new Date().toISOString(),
    readable_source_label: "Sage",
  };
}

/**
 * LLM-echoed text (e.g. Gemini's "note_text", meant to be copied verbatim)
 * is not guaranteed to come back byte-identical to the real stored string --
 * different dash/quote characters, trailing punctuation, or whitespace are
 * common even when a model is explicitly told not to alter the text. Exact
 * equality silently fails in practice, so matching normalizes both sides
 * and accepts containment either way rather than requiring a perfect match.
 */
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isCloseMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Matching is by (fuzzy-normalized) text, not entity id -- there's no id to
 * match by from the UI side, since notes are surfaced via readable_highlights
 * strings, not the raw entities. Two notes with identical/near-identical
 * text are genuinely ambiguous without an id, so this stops at the FIRST
 * match found (`state.matched`) rather than archiving every matching node in
 * the tree -- previously, removing one note could silently archive every
 * other note that happened to share its wording.
 */
function archiveMatchingObservationNode(
  node: unknown,
  noteText: string,
  archivedReason: string,
  nowIso: string,
  state: { matched: boolean },
): void {
  if (state.matched) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (state.matched) return;
      archiveMatchingObservationNode(item, noteText, archivedReason, nowIso, state);
    }
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.observations)) {
      const hasMatch = obj.observations.some(
        (entry) => typeof entry === "string" && isCloseMatch(entry, noteText),
      );
      if (hasMatch && obj.status !== "archived") {
        obj.status = "archived";
        obj.archived_at = nowIso;
        obj.archived_reason = archivedReason;
        state.matched = true;
        return;
      }
    }
    for (const key of Object.keys(obj)) {
      if (state.matched) return;
      if (key === "observations") continue;
      archiveMatchingObservationNode(obj[key], noteText, archivedReason, nowIso, state);
    }
  }
}

/**
 * Finds the exact entity a misfiled note came from (anywhere in the
 * domain's arbitrarily-nested JSON, matched by its observation text) and
 * marks it archived rather than deleting it -- this is a real cross-domain
 * edit, the one exception to the additive-only rule the rest of Sage's
 * writes follow, and deliberately non-destructive: the record stays, just
 * no longer "active", with a note on where it moved to.
 */
export function archiveMatchingNoteEntity(
  currentDomainData: Record<string, unknown>,
  noteText: string,
  archivedReason: string,
): { domainData: Record<string, unknown>; matched: boolean } {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const state = { matched: false };
  archiveMatchingObservationNode(cloned, noteText, archivedReason, nowIso, state);
  return { domainData: cloned, matched: state.matched };
}

function hasMatchingObservationNode(node: unknown, noteText: string): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasMatchingObservationNode(item, noteText));
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.observations)) {
      const hasMatch = obj.observations.some(
        (entry) => typeof entry === "string" && isCloseMatch(entry, noteText),
      );
      if (hasMatch) return true;
    }
    return Object.keys(obj).some((key) => key !== "observations" && hasMatchingObservationNode(obj[key], noteText));
  }
  return false;
}

/**
 * Read-only check for whether a note with this exact text already exists
 * anywhere in the domain -- used to avoid adding a second duplicate entity
 * if a fix gets applied more than once (e.g. re-clicking after a prior
 * partial success).
 */
export function hasMatchingNote(currentDomainData: Record<string, unknown>, noteText: string): boolean {
  return hasMatchingObservationNode(currentDomainData, noteText);
}

const SAVED_FROM_NOTE_PREFIX = /^saved from your note:\s*/i;

/**
 * Archiving the raw entity (archiveMatchingNoteEntity above) doesn't touch
 * readable_highlights -- a separate summary-projection field that the
 * per-domain Sage card, Notes Archive, and PKM natural-language panel
 * actually read from. Without also stripping the matching line here, a
 * "moved" note keeps getting described by its old domain forever, even
 * though the underlying entity is correctly archived.
 */
export function buildArchivedNoteSummaryPatch(params: {
  existingHighlights: string[];
  noteText: string;
}): Record<string, unknown> {
  // Strips only the first matching line, mirroring archiveMatchingNoteEntity
  // above stopping at the first matching entity -- same "no id to match by"
  // ambiguity, same "at most one" bound on the blast radius.
  let removed = false;
  const remaining = params.existingHighlights.filter((line) => {
    if (removed) return true;
    const stripped = line.replace(SAVED_FROM_NOTE_PREFIX, "").trim();
    const isMatch = isCloseMatch(stripped, params.noteText) || isCloseMatch(line, params.noteText);
    if (isMatch) {
      removed = true;
      return false;
    }
    return true;
  });
  return {
    readable_highlights: remaining,
    readable_updated_at: new Date().toISOString(),
  };
}
