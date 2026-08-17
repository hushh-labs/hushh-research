/**
 * Presence, which is a different question from lifecycle.
 *
 * "Does a pod exist" is lifecycle and lives in `deployment-progress-policy.ts`.
 * "Is it answering right now" is presence, and it is this file. They were being
 * answered by one expression in two components, which is how a normal state came
 * to be rendered as a fault.
 *
 * THE DEFECT THIS CLOSES
 *
 * Both surfaces asked `health && health !== "healthy"`. The backend vocabulary is
 * `unknown | healthy | degraded | unreachable | sleeping`
 * (`pod_liveness_service.py:59-63`), and `sleeping` is documented there in as many
 * words as "emphatically NOT a fault": an economy pod is *supposed* to be asleep
 * between turns and wakes on demand, which is why that path proposes no probe and
 * no heal. Testing for inequality with "healthy" therefore reported every idle pod
 * as broken, and idle is the steady state for the default tier.
 *
 * WHY AN ALLOWLIST
 *
 * A denylist makes every value added later default to "alarm". This defaults to
 * silence instead, which is the safer direction for copy a person reads about
 * their own agent: a state we have no opinion about should produce no claim.
 * `unknown` is excluded for that reason and not by omission -- the backend omits
 * health entirely rather than defaulting it to "healthy", so inventing a verdict
 * here would be making exactly the claim the backend declined to make.
 */

/** Verdicts that mean the agent is genuinely not answering. */
const NOT_ANSWERING = new Set<string>(["degraded", "unreachable"]);

/** Asleep, which is normal on the economy tier and never a fault. */
const ASLEEP = "sleeping";

export function isAgentNotAnswering(health: string | null | undefined): boolean {
  return Boolean(health && NOT_ANSWERING.has(health));
}

export function isAgentAsleep(health: string | null | undefined): boolean {
  return health === ASLEEP;
}
