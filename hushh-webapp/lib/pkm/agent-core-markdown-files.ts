"use client";

import {
  OWNER_STYLE_BRANCH,
  OWNER_STYLE_DOMAIN,
  OWNER_STYLE_LANGUAGE_LABEL,
  OWNER_STYLE_LENGTH_LABEL,
  OWNER_STYLE_TONE_LABEL,
  PREFERRED_NAME_MAX,
  STYLE_NOTE_MAX,
  ownerStyleFromBranch,
  sanitizeStyleText,
  type OwnerStyleLanguage,
  type OwnerStyleLength,
  type OwnerStyleSettings,
  type OwnerStyleTone,
} from "@/lib/agent/owner-style-settings";
import { saveOwnerStyleSettings } from "@/lib/agent/owner-style-settings-writer";
import { containsSecretSpan } from "@/lib/pkm/secret-patterns";
import { clearAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import {
  MARKDOWN_MEMORY_DOMAIN,
  MARKDOWN_MEMORY_SCHEMA,
  MAX_MARKDOWN_MEMORY_CHARS,
  clearMarkdownMemory,
  loadMarkdownMemory,
  peekMarkdownMemory,
  replaceMarkdownMemoryDocument,
} from "@/lib/pkm/markdown-memory";
import { omitCredentialsFromMemory } from "@/lib/pkm/secret-span-guard";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { readLabelledSoulFacts } from "@/lib/pkm/soul-labelled-facts";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export const CORE_AGENT_MARKDOWN_IDS = ["memory.md", "identity.md", "soul.md"] as const;
export type CoreAgentMarkdownId = (typeof CORE_AGENT_MARKDOWN_IDS)[number];

export function isCoreAgentMarkdownId(value: string | null | undefined): value is CoreAgentMarkdownId {
  return value === "memory.md" || value === "identity.md" || value === "soul.md";
}

export const CORE_AGENT_MARKDOWN_META: Record<
  CoreAgentMarkdownId,
  { id: CoreAgentMarkdownId; title: string; subtitle: string }
> = {
  "memory.md": {
    id: "memory.md",
    title: "memory.md",
    subtitle: "Facts, preferences, and durable commitments.",
  },
  "identity.md": {
    id: "identity.md",
    title: "identity.md",
    subtitle: "Your profile, preferences, and ongoing context.",
  },
  "soul.md": {
    id: "soul.md",
    title: "soul.md",
    subtitle: "Agent persona, tone, and operating principles.",
  },
};

export type CoreAgentMarkdownDocument = {
  id: CoreAgentMarkdownId;
  markdown: string;
  storedMarkdown: string;
  persisted: boolean;
  isDefaultTemplate: boolean;
  updatedAt: string | null;
};

type CachedEntry = {
  ownerId: string;
  vaultEpoch: number;
  docs: Partial<Record<CoreAgentMarkdownId, CoreAgentMarkdownDocument>>;
};

const cache = new Map<string, CachedEntry>();
const listeners = new Map<string, Set<() => void>>();

function notify(userId: string): void {
  listeners.get(userId)?.forEach((listener) => listener());
}

export function subscribeCoreAgentMarkdownFiles(userId: string, listener: () => void): () => void {
  const entries = listeners.get(userId) ?? new Set<() => void>();
  entries.add(listener);
  listeners.set(userId, entries);
  return () => {
    entries.delete(listener);
    if (!entries.size) listeners.delete(userId);
  };
}

function readCachedEntry(userId: string): CachedEntry | null {
  const entry = cache.get(userId);
  if (!entry || entry.ownerId !== userId || !isVaultSessionEpochCurrent(entry.vaultEpoch)) {
    cache.delete(userId);
    return null;
  }
  return entry;
}

function writeCachedDoc(userId: string, vaultEpoch: number, doc: CoreAgentMarkdownDocument): CoreAgentMarkdownDocument {
  if (!isVaultSessionEpochCurrent(vaultEpoch)) return doc;
  const existing = readCachedEntry(userId);
  const next: CachedEntry = {
    ownerId: userId,
    vaultEpoch,
    docs: { ...(existing?.docs ?? {}), [doc.id]: doc },
  };
  cache.set(userId, next);
  notify(userId);
  return doc;
}

export function clearCoreAgentMarkdownCache(userId?: string): void {
  if (userId) {
    cache.delete(userId);
    notify(userId);
    return;
  }
  const ownerIds = [...cache.keys()];
  cache.clear();
  for (const ownerId of ownerIds) notify(ownerId);
}

/**
 * Hermes-aligned default agent markdown documents (`memory.md`, `identity.md`, `soul.md`).
 * Keeps defaults readable and clean without inventing factual claims about the user.
 */
export function defaultCoreAgentMarkdown(
  id: CoreAgentMarkdownId,
  options?: {
    memoryMarkdown?: string;
    styleSettings?: OwnerStyleSettings;
    timezone?: string;
  },
): string {
  if (id === "memory.md") {
    return `# Memory

## Facts
- Keep durable facts and background context you want One to remember across sessions.

## Preferences
- Note lasting personal or workflow preferences.

## Commitments
- Track ongoing goals, schedules, or standing instructions.
`;
  }

  if (id === "identity.md") {
    const facts = readLabelledSoulFacts(options?.memoryMarkdown ?? "");
    const factEntries = Array.from(facts.values());
    const findFact = (label: string) =>
      factEntries.find((entry) => entry.label.toLowerCase() === label.toLowerCase())?.value ?? "";
    const preferredName =
      options?.styleSettings?.preferred_name?.trim() || findFact("Preferred name") || "Not set";
    const legalName = findFact("Legal name") || "Not set";
    const timezone =
      options?.timezone?.trim() ||
      (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "") ||
      "UTC";
    return `# Identity

## Owner Profile
- Preferred name: ${preferredName}
- Legal name: ${legalName}
- Timezone: ${timezone}

## Context & Work
- Role / focus: 

## Current Goals
- 
`;
  }

  const style = options?.styleSettings;
  const tone = style?.tone ? OWNER_STYLE_TONE_LABEL[style.tone] : "Warm";
  const length = style?.length ? OWNER_STYLE_LENGTH_LABEL[style.length] : "Balanced";
  const language = style?.language ? OWNER_STYLE_LANGUAGE_LABEL[style.language] : "Automatic";
  const extraStyle = style?.owner_style_note?.trim() ? `\n- Standing note: ${style.owner_style_note.trim()}` : "";

  return `# Soul

## Persona
You are One — a discreet, loyal personal agent working exclusively for the person whose life you touch.

## Voice & Style
- Tone: ${tone}
- Response length: ${length}
- Language: ${language}${extraStyle}

## Operating Principles
- Protect owner privacy, explicit consent, and client-side zero-knowledge boundaries.
- Lead with clear, verified answers and thoughtful restraint.
- Ask concisely before making external writes or irreversible commitments.
`;
}

function parseBulletFields(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+([^:]{1,64}):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase();
    const val = match[2]!.trim();
    if (key && val) fields[key] = val;
  }
  return fields;
}

function lookupEnumByLabel<T extends string>(
  labels: Record<T, string>,
  raw: string | undefined,
): T | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  for (const [code, label] of Object.entries(labels) as Array<[T, string]>) {
    if (code.toLowerCase() === normalized || label.toLowerCase() === normalized) {
      return code;
    }
  }
  return undefined;
}

async function syncClosedStyleChannelFromMarkdown(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  docId: "identity.md" | "soul.md";
  markdown: string;
}): Promise<void> {
  const fields = parseBulletFields(params.markdown);
  const existingSnapshot = await PkmDomainResourceService.getStaleFirst({
    userId: params.userId,
    domain: OWNER_STYLE_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    forceRefresh: false,
    backgroundRefresh: false,
  }).catch(() => null);
  const base = existingSnapshot
    ? ownerStyleFromBranch(existingSnapshot.data?.[OWNER_STYLE_BRANCH])
    : {};
  const next: OwnerStyleSettings = { ...base };
  let changed = false;

  const rawName = fields["preferred name"];
  if (rawName && rawName.toLowerCase() !== "not set") {
    const cleanName = sanitizeStyleText(rawName).slice(0, PREFERRED_NAME_MAX);
    if (cleanName && !containsSecretSpan(cleanName) && cleanName !== base.preferred_name) {
      next.preferred_name = cleanName;
      changed = true;
    }
  }

  if (params.docId === "soul.md") {
    const tone = lookupEnumByLabel<OwnerStyleTone>(OWNER_STYLE_TONE_LABEL, fields["tone"]);
    if (tone && tone !== base.tone) {
      next.tone = tone;
      changed = true;
    }
    const length = lookupEnumByLabel<OwnerStyleLength>(OWNER_STYLE_LENGTH_LABEL, fields["response length"] ?? fields["length"]);
    if (length && length !== base.length) {
      next.length = length;
      changed = true;
    }
    const language = lookupEnumByLabel<OwnerStyleLanguage>(OWNER_STYLE_LANGUAGE_LABEL, fields["language"]);
    if (language && language !== base.language) {
      next.language = language;
      changed = true;
    }
    const rawNote = fields["standing note"];
    if (rawNote) {
      const cleanNote = sanitizeStyleText(rawNote).slice(0, STYLE_NOTE_MAX);
      if (cleanNote && !containsSecretSpan(cleanNote) && cleanNote !== base.owner_style_note) {
        next.owner_style_note = cleanNote;
        changed = true;
      }
    }
  }

  if (!changed) return;
  await saveOwnerStyleSettings({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    settings: next,
  }).catch(() => false);
}

export function peekCoreAgentMarkdownFile(
  userId: string | null | undefined,
  docId: CoreAgentMarkdownId,
): CoreAgentMarkdownDocument | null {
  if (!userId) return null;
  const cached = readCachedEntry(userId)?.docs[docId];
  if (cached) return cached;
  const memory = peekMarkdownMemory(userId);
  if (!memory) return null;
  const stored =
    docId === "memory.md"
      ? memory.markdown
      : docId === "identity.md"
        ? (memory.identityMarkdown ?? "")
        : (memory.soulMarkdown ?? "");
  if (!stored.trim()) return null;
  return {
    id: docId,
    markdown: stored,
    storedMarkdown: stored,
    persisted: docId === "memory.md" ? memory.persisted : Boolean(stored.trim()),
    isDefaultTemplate: false,
    updatedAt: memory.updatedAt,
  };
}

export async function loadCoreAgentMarkdownFile(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  docId: CoreAgentMarkdownId;
  forceRefresh?: boolean;
}): Promise<CoreAgentMarkdownDocument> {
  const epoch = snapshotVaultSessionEpoch();
  if (!params.forceRefresh) {
    const warm = peekCoreAgentMarkdownFile(params.userId, params.docId);
    if (warm && !warm.isDefaultTemplate) return warm;
  }

  const [memory, styleSnapshot] = await Promise.all([
    loadMarkdownMemory({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      forceRefresh: params.forceRefresh,
    }),
    params.docId === "memory.md"
      ? Promise.resolve(null)
      : PkmDomainResourceService.getStaleFirst({
          userId: params.userId,
          domain: OWNER_STYLE_DOMAIN,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          forceRefresh: false,
          backgroundRefresh: false,
        }).catch(() => null),
  ]);

  if (!isVaultSessionEpochCurrent(epoch)) {
    throw new DOMException("Vault locked while loading agent markdown file", "AbortError");
  }

  const stored =
    params.docId === "memory.md"
      ? (memory?.markdown ?? "")
      : params.docId === "identity.md"
        ? (memory?.identityMarkdown ?? "")
        : (memory?.soulMarkdown ?? "");

  const styleSettings = styleSnapshot
    ? ownerStyleFromBranch(styleSnapshot.data?.[OWNER_STYLE_BRANCH])
    : undefined;

  const isDefaultTemplate = !stored.trim();
  const markdown = isDefaultTemplate
    ? defaultCoreAgentMarkdown(params.docId, {
        memoryMarkdown: memory?.markdown ?? "",
        styleSettings,
      })
    : stored;

  const doc: CoreAgentMarkdownDocument = {
    id: params.docId,
    markdown,
    storedMarkdown: stored,
    persisted: params.docId === "memory.md" ? Boolean(memory?.persisted) : Boolean(stored.trim()),
    isDefaultTemplate,
    updatedAt: memory?.updatedAt ?? null,
  };
  return writeCachedDoc(params.userId, epoch, doc);
}

export async function saveCoreAgentMarkdownFile(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  docId: CoreAgentMarkdownId;
  markdown: string;
  expectedStoredMarkdown: string;
  expectedPersisted: boolean;
  beforeEffect: () => Promise<void>;
}): Promise<{ success: boolean; conflict?: boolean; document?: CoreAgentMarkdownDocument; message?: string }> {
  const epoch = snapshotVaultSessionEpoch();
  const sanitized = omitCredentialsFromMemory(params.markdown).trimEnd();
  const nextMarkdown = sanitized.trim() ? `${sanitized}\n` : "";

  if (nextMarkdown.length > MAX_MARKDOWN_MEMORY_CHARS) {
    return {
      success: false,
      message: `${params.docId} is too long. Shorten it before saving.`,
    };
  }

  if (params.docId === "memory.md") {
    const result = await replaceMarkdownMemoryDocument({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      markdown: nextMarkdown,
      expectedMarkdown: params.expectedStoredMarkdown,
      expectedPersisted: params.expectedPersisted,
      beforeEffect: params.beforeEffect,
    });
    if (!result.success) {
      return {
        success: false,
        conflict: result.conflict,
        message: result.message,
      };
    }
    const savedText = result.markdown ?? nextMarkdown;
    const isDefaultTemplate = !savedText.trim();
    const doc: CoreAgentMarkdownDocument = {
      id: "memory.md",
      markdown: isDefaultTemplate ? defaultCoreAgentMarkdown("memory.md") : savedText,
      storedMarkdown: savedText,
      persisted: true,
      isDefaultTemplate,
      updatedAt: peekMarkdownMemory(params.userId)?.updatedAt ?? new Date().toISOString(),
    };
    writeCachedDoc(params.userId, epoch, doc);
    clearAgentPkmContext(params.userId, { preserveMarkdown: true });
    return { success: true, document: doc };
  }

  const fieldName = params.docId === "identity.md" ? "identity_markdown" : "soul_markdown";
  let conflict = false;
  const result = await PkmWriteCoordinator.savePreparedDomain({
    userId: params.userId,
    domain: MARKDOWN_MEMORY_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: "pkm_memory_edited_button",
    },
    beforeEffect: params.beforeEffect,
    mayPublish: () => isVaultSessionEpochCurrent(epoch),
    build: (context) => {
      const current =
        context.currentDomainData && typeof context.currentDomainData === "object"
          ? context.currentDomainData
          : {};
      const currentValue = typeof current[fieldName] === "string" ? String(current[fieldName]) : "";
      if (currentValue !== params.expectedStoredMarkdown) {
        conflict = true;
        throw new Error(`${params.docId} changed while you were editing.`);
      }
      const existingMemory = typeof current.markdown === "string" ? current.markdown : "";
      const updatedAt = new Date().toISOString();
      return {
        domainData: {
          ...current,
          schema_version: MARKDOWN_MEMORY_SCHEMA,
          markdown: existingMemory,
          [fieldName]: nextMarkdown,
          updated_at: updatedAt,
        },
        summary: {
          schema_version: MARKDOWN_MEMORY_SCHEMA,
          storage_mode: "encrypted_markdown",
          character_count: existingMemory.length + nextMarkdown.length,
          updated_at: updatedAt,
        },
      };
    },
  });

  if (conflict) {
    return {
      success: false,
      conflict: true,
      message: `${params.docId} changed while you were editing. Reload the latest version before saving.`,
    };
  }
  if (!result.success) {
    return { success: false, message: result.message ?? `Could not save ${params.docId}.` };
  }
  await params.beforeEffect();
  if (!isVaultSessionEpochCurrent(epoch)) {
    return { success: false, message: "Unlock your vault to save agent markdown files." };
  }

  clearMarkdownMemory(params.userId);
  await syncClosedStyleChannelFromMarkdown({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    docId: params.docId,
    markdown: nextMarkdown,
  });
  await loadMarkdownMemory({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    forceRefresh: true,
  }).catch(() => null);
  clearAgentPkmContext(params.userId, { preserveMarkdown: true });

  const isDefaultTemplate = !nextMarkdown.trim();
  const doc: CoreAgentMarkdownDocument = {
    id: params.docId,
    markdown: isDefaultTemplate ? defaultCoreAgentMarkdown(params.docId) : nextMarkdown,
    storedMarkdown: nextMarkdown,
    persisted: true,
    isDefaultTemplate,
    updatedAt: result.updatedAt ?? new Date().toISOString(),
  };
  writeCachedDoc(params.userId, epoch, doc);
  return { success: true, document: doc };
}
