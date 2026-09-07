#!/usr/bin/env node

/**
 * verify-restraint-charter — give the Restraint Charter teeth.
 *
 * The charter (docs/reference/quality/design.md, Visual Language rule 1; ported to
 * the frontend-design-system review kernel) said one title per screen, one primary
 * action, and no decorative badges. Until this guard existed it was prose competing
 * with ~30 machine-checked build contracts, and additive bias won by default: the
 * cloud step grew a duplicate card title, a "Ready" badge that only mirrored button
 * state, and three "continue" buttons before anyone noticed.
 *
 * This enforces the two most mechanical laws on the surfaces where restraint is
 * non-negotiable — first-run setup screens, which a person meets before they trust
 * anything and where clutter reads as the whole product being noisy:
 *
 *   Law 1 — one title per screen. A single card under a PageHeader must not pass a
 *           title / description / eyebrow to its grouping primitive; that
 *           double-headers by construction.
 *   Law 2 — one primary action. At most one default-variant <Button> per card;
 *           every other action demotes to a variant or a text link.
 *   Law 5 — no decorative badge. First-run setup surfaces carry no <Badge>; a badge
 *           must encode decision-relevant state, which these screens do not have.
 *
 * A surface joins FIRST_RUN_SURFACES once it has been brought to charter compliance,
 * so the list grows as screens are cleaned, never shrinks silently. The scanner is
 * brace/string-aware on purpose: a naive `>` split would mistake an onClick arrow
 * (`() => …`) for the end of a tag and miscount.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// First-run setup surfaces, each verified charter-compliant when added here.
// SINGLE-card surfaces (one grouping primitive) go in `singleCard: true` so Law 1
// applies; a multi-group settings page would legitimately title each group.
const FIRST_RUN_SURFACES = [
  { path: "components/connections/byoc-cloud-card.tsx", singleCard: true },
  { path: "components/connections/byoc-cloud-setup-page.tsx", singleCard: false },
];

const CHARTER = "Restraint Charter (docs/reference/quality/design.md, Visual Language 1)";

// Surfaces that carry legitimate state badges (a real "Saved"/"Selected"/"Locked"
// state) or morphy-ux buttons whose primary reading is a variant, not the absence of
// one, cannot use the generalizable scan above without false positives. For those,
// pin the specific charter fix with an exact-string assertion (the house-guard style
// in verify-apple-hierarchy): a fix that regresses reappears as the banned string, or
// disappears as a missing required one.
const REGRESSION_ASSERTIONS = [
  {
    path: "components/connections/gemini-runtime-configuration-page.tsx",
    absent: "stays in this session until you finish setup",
    law: "law 3 (earn every element): the AI-access header must not restate the BYOK row's session-scope caveat",
  },
  {
    path: "components/connections/gemini-runtime-settings-card.tsx",
    absent: 'trailing={<Badge variant="outline">Coming soon</Badge>}',
    law: "law 5 (no decorative badge): the per-row Coming soon badge only restated the group title and the disabled state",
  },
  {
    path: "components/connections/gemini-runtime-settings-card.tsx",
    present: 'requiresExplicitSelection ? "blue" : "blue-gradient"',
    law: "law 2 (one primary action): the AI-access confirm/validate action must demote below the footer on the first-run step",
  },
  {
    path: "components/onboarding/setup/one-setup-hub.tsx",
    absent: "takeoverHeading",
    law: "law 1 (one title per screen): the setup hub's two-title takeover path (a PageHeader stacked over a story screen) must not return",
  },
];

const failures = [];

function read(repoPath) {
  return fs.readFileSync(path.join(repoRoot, repoPath), "utf8");
}

/**
 * Return the full opening-tag text for each `<TagName …>` in `src`, tracking brace
 * depth and string delimiters so a `>` inside `{() => …}` or a string never ends the
 * tag early. Self-closing and normal openers both return their text through the `>`.
 */
function openingTags(src, tagName) {
  const tags = [];
  const needle = `<${tagName}`;
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    const boundary = src[i + needle.length];
    // `<Buttonish` must not match `<Button`; the next char has to end the name.
    if (boundary && !/[\s/>]/.test(boundary)) {
      i += needle.length;
      continue;
    }
    let depth = 0;
    let quote = null;
    let j = i + needle.length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return tags;
}

for (const surface of FIRST_RUN_SURFACES) {
  const src = read(surface.path);

  // Law 5 — no decorative badge on a first-run surface.
  if (openingTags(src, "Badge").length > 0) {
    failures.push(
      `${surface.path}: a first-run setup surface carries a <Badge>. ${CHARTER} law 5: a badge must encode decision-relevant state, not fill space.`,
    );
  }

  // Law 2 — at most one default-variant (primary) <Button> per card.
  const primaryButtons = openingTags(src, "Button").filter(
    (tag) => !tag.includes("variant="),
  );
  if (primaryButtons.length > 1) {
    failures.push(
      `${surface.path}: ${primaryButtons.length} primary <Button>s. ${CHARTER} law 2: exactly one primary action; demote the rest to a variant or a text link.`,
    );
  }

  // Law 1 — a single card does not restate the page's title.
  if (surface.singleCard) {
    for (const tag of openingTags(src, "SettingsGroup")) {
      for (const prop of ["title=", "description=", "eyebrow="]) {
        if (tag.includes(prop)) {
          failures.push(
            `${surface.path}: single-card surface passes ${prop.slice(0, -1)} to SettingsGroup. ${CHARTER} law 1: the PageHeader owns the one title; a lone card must not restate it.`,
          );
        }
      }
    }
  }
}

for (const assertion of REGRESSION_ASSERTIONS) {
  const src = read(assertion.path);
  if (assertion.absent && src.includes(assertion.absent)) {
    failures.push(
      `${assertion.path}: reintroduced "${assertion.absent}". ${CHARTER} ${assertion.law}.`,
    );
  }
  if (assertion.present && !src.includes(assertion.present)) {
    failures.push(
      `${assertion.path}: missing required "${assertion.present}". ${CHARTER} ${assertion.law}.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`verify-restraint-charter: ${failures.length} failure(s)\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `verify-restraint-charter: OK (${FIRST_RUN_SURFACES.length} first-run surfaces, ${REGRESSION_ASSERTIONS.length} pinned fixes)`,
);
