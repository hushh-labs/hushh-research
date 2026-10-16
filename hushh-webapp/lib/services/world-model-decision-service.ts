import {
  appendMarkdownMemoryFacts,
  findMarkdownMemoryBullet,
  loadMarkdownMemory,
  markdownMemoryFactText,
  peekMarkdownMemory,
} from "@/lib/pkm/markdown-memory";
import type { SoulFact, SoulSection } from "@/lib/pkm/soul-document";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import type { ProfileReport } from "@/lib/services/profile-research-service";

/** One of the 20 research topics the PWM specialist assigns to each finding. */
export type PwmTopic = ProfileReport["sections"][number]["kind"];

export type PwmSectionId =
  | "about"
  | "work"
  | "education"
  | "projects"
  | "interests"
  | "preferences"
  | "public_presence";

/**
 * Display grouping only. The model chooses the topic; this map never
 * reinterprets a statement, it only places a model-chosen topic on the page.
 */
export const PWM_SECTIONS: readonly {
  id: PwmSectionId;
  label: string;
  topics: readonly PwmTopic[];
}[] = [
  { id: "about", label: "About", topics: ["personal"] },
  { id: "work", label: "Work", topics: ["career", "business", "achievements"] },
  { id: "education", label: "Education", topics: ["education"] },
  { id: "projects", label: "Projects", topics: ["projects", "publications"] },
  {
    id: "interests",
    label: "Interests",
    topics: ["interests", "community", "entertainment", "travel", "food"],
  },
  {
    id: "preferences",
    label: "Preferences",
    topics: ["preferences", "dislikes", "style", "shopping", "communication"],
  },
  {
    id: "public_presence",
    label: "Public presence",
    topics: ["digital_presence", "public_records", "security"],
  },
];

export function pwmSectionForTopic(topic: PwmTopic): PwmSectionId {
  return (
    PWM_SECTIONS.find((section) => section.topics.includes(topic))?.id ??
    "about"
  );
}

/** Owner decision on one research statement. "rejected" never implies the opposite. */
export type PwmDecision = "accepted" | "edited" | "rejected" | "removed";

export type PwmClaim = {
  /** pwmClaimKey() of the statement the owner was first shown. */
  key: string;
  decision: PwmDecision;
  /**
   * accepted: the exact statement saved to Soul.md; edited: the owner's
   * corrected wording saved to Soul.md; rejected/removed: the declined
   * statement, kept only so research does not propose it again.
   */
  text: string;
  topic: PwmTopic;
  /** ISO-8601 time of the owner's decision. */
  decided_at: string;
  /** Google-grounded research is view-only: only the owner's declaration is saved. */
  basis: "owner_declaration";
};

export type PwmMemory = {
  claims: Readonly<Record<string, PwmClaim>>;
  /** accepted/edited claims whose exact bullet is still in Soul.md, newest first. */
  saved: readonly PwmClaim[];
  /** Hides a draft statement: every claim key plus pwmClaimKey(claim.text). */
  decidedKeys: ReadonlySet<string>;
};

export type PwmMemoryAuthority = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  assertCurrent?: () => Promise<void>;
};

export type PwmOwnerDecisions = { confirmed: string[]; rejected: string[] };

export function normalizePwmStatement(statement: string): string {
  return statement
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!。]+$/u, "");
}

/** Stable, content-derived key; stored only inside the vault-encrypted Soul.md domain. */
export function pwmClaimKey(statement: string): Promise<string> {
  return sha256Hex(`pwm-claim-v1\n${normalizePwmStatement(statement)}`);
}

// One full research draft can contain 269 independently reviewable statements.
const MAX_OWNER_DECISIONS = 269;
const MAX_STATEMENT_CHARS = 600;
const PREFERENCE_TOPICS: ReadonlySet<PwmTopic> = new Set<PwmTopic>([
  "preferences",
  "dislikes",
  "style",
  "food",
  "shopping",
  "entertainment",
  "travel",
  "interests",
  "communication",
]);
const CONFIRMATION = {
  confirmedByUser: true,
  surface: "web",
  source: "pwm_owner_review",
} as const;

function soulSection(topic: PwmTopic): SoulSection {
  return PREFERENCE_TOPICS.has(topic) ? "Preferences" : "Facts";
}

function savedText(value: string): string {
  const text = markdownMemoryFactText(value);
  if (!text || text.length > MAX_STATEMENT_CHARS)
    throw new Error("This detail can't be saved to your memory.");
  return text;
}

function newestFirst(a: PwmClaim, b: PwmClaim): number {
  return Date.parse(b.decided_at) - Date.parse(a.decided_at);
}

async function toPwmMemory(
  markdown: string,
  claims: Readonly<Record<string, PwmClaim>>,
): Promise<PwmMemory> {
  const all = Object.values(claims);
  const decidedKeys = new Set<string>(Object.keys(claims));
  for (const key of await Promise.all(
    all.map((claim) => pwmClaimKey(claim.text)),
  ))
    decidedKeys.add(key);
  return {
    claims,
    saved: all
      .filter(
        (claim) =>
          (claim.decision === "accepted" || claim.decision === "edited") &&
          findMarkdownMemoryBullet(markdown, claim.text) !== null,
      )
      .sort(newestFirst),
    decidedKeys,
  };
}

async function readMemory(input: PwmMemoryAuthority, forceRefresh = false) {
  await input.assertCurrent?.();
  const memory = await loadMarkdownMemory({
    userId: input.userId,
    vaultKey: input.vaultKey,
    vaultOwnerToken: input.vaultOwnerToken,
    forceRefresh,
  });
  await input.assertCurrent?.();
  if (!memory) throw new Error("Unlock your vault to open your memory.");
  return memory;
}

/** One compare-and-set commit of a bullet change plus its private decision. */
async function commitDecision(
  input: PwmMemoryAuthority,
  claim: PwmClaim,
  facts: SoulFact[],
  previous: PwmClaim | undefined,
): Promise<PwmMemory> {
  // A retry of the same decision reuses its plan id; a later change does not.
  const scope = `pwm:${claim.key}:${claim.decision}:${await sha256Hex(claim.text)}:${previous?.decided_at ?? "none"}`;
  let result: Awaited<ReturnType<typeof appendMarkdownMemoryFacts>>;
  try {
    result = await appendMarkdownMemoryFacts({
      userId: input.userId,
      vaultKey: input.vaultKey,
      vaultOwnerToken: input.vaultOwnerToken,
      facts,
      confirmation: CONFIRMATION,
      beforeEffect: input.assertCurrent,
      idempotencyScope: scope,
      pwmClaim: claim,
      // Compare-and-set on the decision itself, not only on the document.
      pwmClaimPrevious: previous ?? null,
    });
  } catch {
    result = { success: false, saved: 0, markdown: null };
  }
  if (!result.success) {
    // The next attempt must start from the latest memory, never a stale target.
    await readMemory(input, true).catch(() => undefined);
    throw new Error("Your memory wasn't updated. Try again.");
  }
  let memory = peekMarkdownMemory(input.userId);
  const cached = memory?.pwmClaims?.[claim.key];
  // An idempotent replay does not refresh the local copy; read it back.
  if (
    !memory ||
    cached?.decision !== claim.decision ||
    cached.text !== claim.text
  )
    memory = await readMemory(input, true);
  await input.assertCurrent?.();
  const stored = memory.pwmClaims?.[claim.key];
  if (stored?.decision !== claim.decision || stored.text !== claim.text)
    throw new Error("Your memory wasn't updated. Try again.");
  return toPwmMemory(memory.markdown, memory.pwmClaims ?? {});
}

/**
 * Every write resolves only after the encrypted Soul.md commit succeeds and
 * returns the reloaded memory; any failure rejects and nothing is reported as
 * saved. Retrying the same decision is idempotent.
 */
export const WorldModelDecisionService = {
  async load(input: PwmMemoryAuthority): Promise<PwmMemory> {
    const memory = await readMemory(input);
    return toPwmMemory(memory.markdown, memory.pwmClaims ?? {});
  },
  /** Yes: save the exact statement as the owner's declaration. */
  async confirm(
    input: PwmMemoryAuthority & { statement: string; topic: PwmTopic },
  ): Promise<PwmMemory> {
    const text = savedText(input.statement);
    const key = await pwmClaimKey(input.statement);
    const memory = await readMemory(input);
    const previous = memory.pwmClaims?.[key];
    if (
      previous?.decision === "accepted" &&
      previous.text === text &&
      findMarkdownMemoryBullet(memory.markdown, text)
    )
      return toPwmMemory(memory.markdown, memory.pwmClaims ?? {});
    return commitDecision(
      input,
      {
        key,
        decision: "accepted",
        text,
        topic: input.topic,
        decided_at: new Date().toISOString(),
        basis: "owner_declaration",
      },
      [{ text, section: soulSection(input.topic) }],
      previous,
    );
  },
  /** No: remember the rejection only; never writes a Soul.md bullet. */
  async reject(
    input: PwmMemoryAuthority & { statement: string; topic: PwmTopic },
  ): Promise<PwmMemory> {
    const text = input.statement.trim().slice(0, MAX_STATEMENT_CHARS);
    if (!text) throw new Error("Nothing to decline.");
    const key = await pwmClaimKey(input.statement);
    const memory = await readMemory(input);
    const previous = memory.pwmClaims?.[key];
    if (previous?.decision === "rejected" && previous.text === text)
      return toPwmMemory(memory.markdown, memory.pwmClaims ?? {});
    return commitDecision(
      input,
      {
        key,
        decision: "rejected",
        text,
        topic: input.topic,
        decided_at: new Date().toISOString(),
        basis: "owner_declaration",
      },
      [],
      previous,
    );
  },
  /** Save the owner's corrected wording for a draft or an already saved claim. */
  async edit(
    input: PwmMemoryAuthority & {
      claimKey: string;
      text: string;
      topic: PwmTopic;
    },
  ): Promise<PwmMemory> {
    if (!/^[a-f0-9]{64}$/.test(input.claimKey))
      throw new Error("Unknown detail.");
    const text = savedText(input.text);
    const memory = await readMemory(input);
    const previous = memory.pwmClaims?.[input.claimKey];
    const target =
      previous &&
      (previous.decision === "accepted" || previous.decision === "edited")
        ? findMarkdownMemoryBullet(memory.markdown, previous.text)
        : null;
    if (previous?.decision === "edited" && previous.text === text && target)
      return toPwmMemory(memory.markdown, memory.pwmClaims ?? {});
    const section = soulSection(input.topic);
    return commitDecision(
      input,
      {
        key: input.claimKey,
        decision: "edited",
        text,
        topic: input.topic,
        decided_at: new Date().toISOString(),
        basis: "owner_declaration",
      },
      [
        target
          ? { text, section, mutation: { kind: "correct", target } }
          : { text, section },
      ],
      previous,
    );
  },
  /** Remove a saved claim's bullet and keep it suppressed. */
  async remove(
    input: PwmMemoryAuthority & { claimKey: string },
  ): Promise<PwmMemory> {
    const memory = await readMemory(input);
    const previous = memory.pwmClaims?.[input.claimKey];
    if (!previous) throw new Error("Unknown detail.");
    if (previous.decision === "removed")
      return toPwmMemory(memory.markdown, memory.pwmClaims ?? {});
    const target =
      previous.decision === "accepted" || previous.decision === "edited"
        ? findMarkdownMemoryBullet(memory.markdown, previous.text)
        : null;
    return commitDecision(
      input,
      {
        ...previous,
        decision: "removed",
        decided_at: new Date().toISOString(),
      },
      target
        ? [
            {
              text: "",
              section: soulSection(previous.topic),
              mutation: { kind: "delete", target },
            },
          ]
        : [],
      previous,
    );
  },
  /** Bounded owner decisions sent with research starts so the model avoids repeats. */
  ownerDecisions(memory: PwmMemory): PwmOwnerDecisions {
    const bounded = (claims: readonly PwmClaim[]) =>
      claims
        .map((claim) => claim.text.trim().slice(0, MAX_STATEMENT_CHARS))
        .filter(Boolean)
        .slice(0, MAX_OWNER_DECISIONS);
    return {
      confirmed: bounded(memory.saved),
      rejected: bounded(
        Object.values(memory.claims)
          .filter(
            (claim) =>
              claim.decision === "rejected" || claim.decision === "removed",
          )
          .sort(newestFirst),
      ),
    };
  },
};
