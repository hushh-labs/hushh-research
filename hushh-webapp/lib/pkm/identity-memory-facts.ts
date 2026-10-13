/**
 * The identity facts this product writes into Soul.md, projected one scope at
 * a time.
 *
 * The identity intake stores what the person states as labelled Soul bullets
 * (`kyc-identity-profile-pkm-service.ts`, `suppliedIdentityFacts`), not as
 * structured leaves. So an approved identity scope has no leaf to project and
 * an answer came back empty even though the fact was sitting in Profile
 * Memory. This maps each approved scope to exactly one labelled bullet.
 *
 * Narrow by construction: a scope the owner did not approve is never looked
 * up, and the whole document is never handed over. Only the mapped labels
 * below can ever leave this way; the person's free prose cannot.
 *
 * Age is DERIVED, never stored and never guessed. Approving age publishes the
 * number of years and nothing else -- the birth date it came from stays
 * withheld unless the birth date's own scope was separately approved.
 */

import {
  ageFromDateOfBirth,
  readLabelledSoulFacts,
  soulFactKey,
} from "@/lib/pkm/soul-labelled-facts";

/** `attr.<domain>.<path>` suffix → the Soul label the writer uses. */
export const SCOPE_PATH_TO_LABEL: ReadonlyArray<[string, string]> = [
  ["identity_profile.full_name", "legal name"],
  ["identity_profile.date_of_birth", "date of birth"],
  ["identity_profile.sex", "sex"],
  ["identity_profile.citizenship", "citizenship"],
  ["profile.employment_status", "employment status"],
];

/** Approving this publishes whole years worked out from the birth date. */
const DERIVED_AGE_PATH = "identity_profile.declared_age";

/** Known own-name addresses only; a nested name may name somebody else. */
export function isOwnProfileNameScope(scope: string): boolean {
  return ["attr.identity.identity_profile.full_name", "attr.identity.full_name", "attr.identity.legal_name", "attr.identity.name",
    "attr.identity.profile.name", "attr.identity.profile.full_name", "attr.identity.profile.legal_name"].includes(scope);
}

export interface ApprovedSoulFact {
  scope: string;
  /** The leaf name the answer document shows, e.g. `declared_age`. */
  path: string;
  /** The scope-relative path, so the value nests where the domain expects it. */
  relativePath: string;
  value: string;
  /** The Soul bullet this came from, for a source reference. */
  sourceLabel: string;
  derived?: "age_from_date_of_birth";
}

function matchedPath(scope: string, suffix: string): boolean {
  const domain = suffix.startsWith("profile.") ? "professional" : "identity";
  if (!scope.startsWith(`attr.${domain}.`)) return false;
  // Exact scope, or the wildcard that covers it.
  return (
    scope === `attr.${domain}.${suffix}` ||
    scope === `attr.${domain}.${suffix.split(".").slice(0, -1).join(".")}.*`
  );
}

/**
 * The approved identity facts available from Soul.md, and only those.
 *
 * Returns nothing for a scope with no recorded fact, so a missing value stays
 * missing rather than being filled in from somewhere adjacent.
 */
export function approvedScopesBackedBySoul(
  approvedScopes: readonly string[],
): string[] {
  return approvedScopes.filter(
    (scope) =>
      matchedPath(scope, DERIVED_AGE_PATH) ||
      SCOPE_PATH_TO_LABEL.some(([suffix]) => matchedPath(scope, suffix)),
  );
}

export function projectApprovedSoulFacts(params: {
  approvedScopes: readonly string[];
  markdown: string | null | undefined;
  now?: Date;
}): ApprovedSoulFact[] {
  const facts = readLabelledSoulFacts(params.markdown);
  if (facts.size === 0) return [];
  const projected: ApprovedSoulFact[] = [];

  for (const scope of params.approvedScopes) {
    for (const [suffix, label] of SCOPE_PATH_TO_LABEL) {
      if (!matchedPath(scope, suffix)) continue;
      const fact = facts.get(soulFactKey(label));
      if (!fact) continue;
      projected.push({
        scope,
        path: suffix.split(".").pop()!,
        relativePath: suffix,
        value: fact.value,
        sourceLabel: fact.label,
      });
    }

    if (!matchedPath(scope, DERIVED_AGE_PATH)) continue;
    const birth = facts.get(soulFactKey("date of birth"));
    const age = ageFromDateOfBirth(birth?.value, params.now);
    // No recorded birth date, or one that is not a real past date: there is no
    // age to give, and inventing one would be worse than saying so.
    if (age === null) continue;
    projected.push({
      scope,
      path: "declared_age",
      relativePath: DERIVED_AGE_PATH,
      value: String(age),
      // Named as the source without reproducing it: the birth date leaves only
      // when its own scope was approved, which is a different decision.
      sourceLabel: birth!.label,
      derived: "age_from_date_of_birth",
    });
  }
  return projected;
}
