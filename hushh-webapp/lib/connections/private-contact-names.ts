"use client";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PersonProfileService } from "@/lib/services/person-profile-service";
import { containsSecretSpan } from "@/lib/pkm/secret-patterns";

export const PRIVATE_NAMES_CHANGED = "one:private-contact-names-changed";
export type ContactNames = { version: 1; items: { personRef: string; alias: string }[] };
export const nameWords = (value: string) => value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const refValid = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
export function contactNames(value: unknown): ContactNames {
  if (value === undefined || value === null) return { version: 1, items: [] };
  const v = value as ContactNames;
  if (!v || Object.keys(v).sort().join() !== "items,version" || v.version !== 1 || !Array.isArray(v.items) || v.items.length > 200) throw new Error("Private names unavailable");
  const refs = new Set<string>();
  for (const item of v.items) {
    if (!item || Object.keys(item).sort().join() !== "alias,personRef" || typeof item.personRef !== "string" || !refValid(item.personRef) || refs.has(item.personRef) ||
      typeof item.alias !== "string" || item.alias !== item.alias.trim() || !item.alias || item.alias.length > 64 || /[\p{C}]/u.test(item.alias) || !nameWords(item.alias).length || containsSecretSpan(item.alias)) throw new Error("Private names unavailable");
    refs.add(item.personRef);
  }
  return v;
}
export type NameAccess = { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent: () => boolean };
export async function loadContactNames(access: NameAccess): Promise<ContactNames> {
  if (!access.isCurrent()) throw new Error("Private name access changed");
  const snapshot = await PkmDomainResourceService.getStaleFirst({ ...access, domain: "identity", backgroundRefresh: false });
  if (!access.isCurrent()) throw new Error("Private name access changed");
  return contactNames(snapshot?.data?.contact_aliases);
}
export function matchContactName(query: string, names: ContactNames): { personRef: string; query: string } | null {
  const words = nameWords(query);
  const matches = names.items.flatMap(item => {
    const alias = nameWords(item.alias);
    const index = words.findIndex((_, index) => alias.every((word, offset) => words[index + offset] === word));
    return index < 0 ? [] : [{ personRef: item.personRef, query: [...words.slice(0, index), ...words.slice(index + alias.length)].join(" ") }];
  });
  return matches.length === 1 ? matches[0]! : null;
}
export async function saveContactName(access: NameAccess & { personRef: string; alias: string; getIdToken: () => Promise<string> }): Promise<boolean> {
  if (!refValid(access.personRef)) return false;
  const alias = access.alias.trim();
  if (alias) contactNames({ version: 1, items: [{ personRef: access.personRef, alias }] });
  const beforeEffect = async () => {
    if (!access.isCurrent()) throw new Error("Private name access changed");
    const token = await access.getIdToken();
    if (!access.isCurrent()) throw new Error("Private name access changed");
    const relationship = await PersonProfileService.getRelationship(access.personRef, token);
    if (!access.isCurrent() || relationship.status !== "connected") throw new Error("Connection changed");
  };
  const result = await PkmWriteCoordinator.saveMergedDomain({ userId: access.userId, vaultKey: access.vaultKey, vaultOwnerToken: access.vaultOwnerToken,
    domain: "identity", beforeEffect, mayPublish: access.isCurrent,
    confirmation: { confirmedByUser: true, surface: "web", source: "one_connections_private_name" },
    build: ({ currentDomainData }) => {
      const current = contactNames(currentDomainData.contact_aliases);
      const items = current.items.filter(item => item.personRef !== access.personRef);
      if (alias) items.push({ personRef: access.personRef, alias });
      return { domainData: { ...currentDomainData, contact_aliases: contactNames({ version: 1, items }) }, summary: { private_contact_names_updated: true } };
    },
  });
  if (result.success && access.isCurrent()) window.dispatchEvent(new Event(PRIVATE_NAMES_CHANGED));
  return result.success && access.isCurrent();
}
