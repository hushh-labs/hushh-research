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

/**
 * Whether a proactive wake is worth sending right now.
 *
 * Wake is a CLIENT courtesy that runs the ~11s cold start while the person is still
 * reaching for their agent, so the turn lands warm instead of eating the boot inline.
 * It is only worth spending on a pod that both exists and is cold:
 *
 *   - `state !== "active"`  -> there is no pod to wake (reserved/provisioning/
 *     connecting/failed). Waking is meaningless and the lifecycle surface already
 *     narrates these.
 *   - not-answering (degraded/unreachable) -> this is the FAULT path. It belongs to
 *     the recovery classifier (probe -> adopt -> reinit/rebuild), never to a wake
 *     that would just retry a broken pod.
 *   - `health === "healthy"` -> already warm; a wake would be pure cost on a shared,
 *     costed fleet.
 *
 * Everything else -- `sleeping`, `unknown`, or health ABSENT (the backend omits it
 * rather than defaulting to "healthy") -- is a cold-or-unknown pod that a wake can
 * usefully warm. The caller still owns the cooldown and in-flight de-duplication so
 * that "usefully" does not become "on every render".
 */
export function shouldWakePod(
  state: string | null | undefined,
  health: string | null | undefined,
): boolean {
  if (state !== "active") return false;
  if (isAgentNotAnswering(health)) return false;
  if (health === "healthy") return false;
  return true;
}
