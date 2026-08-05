"""The sweep that acts on liveness decisions: observe -> confirm -> heal.

Holds no policy of its own. Every judgment comes from ``pod_liveness_service``,
which is a pure function; this module only performs the I/O that judgment calls
for. Keeping the split means the rule "an economy pod's silence is never a fault"
is stated in exactly one place and cannot be quietly re-decided by a worker that
happens to have a database handle.

The ladder, and why each rung exists
------------------------------------
1. **Observe.** Read the registry. A stale heartbeat says the pod stopped TALKING.
2. **Confirm.** Probe the pod through the owner-less internal path. A pod can serve
   perfectly while its heartbeat is broken (hub rolled, egress blocked, route
   500ing), so acting on step 1 alone would restart healthy agents.
3. **Heal.** Only for a pod whose failure was confirmed repeatedly, and only when
   the heal switch is on. Healing REPLACES the service; it never deprovisions.

Why healing must never be deprovision + provision
-------------------------------------------------
``deprovision()`` revokes the standing pkm.read grant, writes a deletion tombstone
and deletes the registry row; a following ``provision()`` mints a NEW HusshID. The
person's agent identity -- what their consent receipts, their A2A address and their
pod's published public key all point at -- would silently become a different agent
because a health check timed out. ``replace_service`` rolls a new revision under
the same identity, which is the only correct shape for a restart.

Ship-dark
---------
Two independent switches. ``PERSONAL_AGENT_RECONCILE_ENABLED`` gates the sweep
running at all; ``HUSSH_POD_AUTOHEAL_ENABLED`` gates whether a confirmed failure
may mutate a live host. Detection is useful with the second one off, so the sweep
runs and reports honestly long before anyone lets the fleet restart itself. Both
are read on every pass, so flipping either off stops the behaviour with no redeploy.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional

from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
    personal_agent_reconcile_enabled,
    pod_autoheal_enabled,
    pod_warm_stale_seconds,
)
from hushh_mcp.services.pod_liveness_service import PodLivenessDecision, evaluate

logger = logging.getLogger(__name__)

# Async seams, injected. The worker never imports a database client or a cloud SDK
# directly, so the whole sweep is exercisable with plain callables.
FetchCandidates = Callable[[], Awaitable[list[dict]]]
ProbePod = Callable[[dict], Awaitable[bool]]
HealPod = Callable[[dict], Awaitable[bool]]
RecordState = Callable[..., Awaitable[None]]


async def run_liveness_pass(
    *,
    fetch_candidates: FetchCandidates,
    probe_pod: ProbePod,
    heal_pod: HealPod,
    record_state: RecordState,
    now: Optional[datetime] = None,
) -> dict:
    """One sweep over the fleet. Returns a counted summary for the caller to log.

    Never raises for a single bad row: one unparseable or unreachable pod must not
    abort the pass and leave the rest of the fleet unjudged.
    """
    moment = now or datetime.now(timezone.utc)
    stale_seconds = pod_warm_stale_seconds()
    heal_on = pod_autoheal_enabled()

    summary = {"seen": 0, "probed": 0, "healed": 0, "errors": 0, "states": {}}

    for row in await fetch_candidates():
        summary["seen"] += 1
        try:
            decision = evaluate(
                row,
                now=moment,
                warm_stale_seconds=stale_seconds,
                heal_enabled=heal_on,
            )
            decision = await _confirm_and_act(
                row=row,
                decision=decision,
                probe_pod=probe_pod,
                heal_pod=heal_pod,
                record_state=record_state,
                summary=summary,
                moment=moment,
                stale_seconds=stale_seconds,
                heal_on=heal_on,
            )
            states: dict = summary["states"]  # type: ignore[assignment]
            states[decision.health_state] = states.get(decision.health_state, 0) + 1
        except Exception as exc:  # noqa: BLE001 - one bad row never ends the pass
            summary["errors"] += 1
            logger.warning("pod_liveness.row_failed %s", type(exc).__name__)

    return summary


async def _confirm_and_act(
    *,
    row: dict,
    decision: PodLivenessDecision,
    probe_pod: ProbePod,
    heal_pod: HealPod,
    record_state: RecordState,
    summary: dict,
    moment: datetime,
    stale_seconds: int,
    heal_on: bool,
) -> PodLivenessDecision:
    """Carry out one row's decision, re-judging after a probe actually answers."""
    user_id = str(row.get("user_id") or "")
    failures = int(row.get("liveness_failures") or 0)

    if not decision.should_probe:
        # Nothing to confirm -- record the verdict as it stands. This is the path
        # every economy pod takes, and it performs no network call at all.
        await record_state(
            user_id=user_id,
            health_state=decision.health_state,
            healed=False,
        )
        return decision

    summary["probed"] += 1
    alive = await probe_pod(row)

    if alive:
        # It serves. The heartbeat path is what is broken, not the agent -- a real
        # and materially different fault, and emphatically not grounds for a
        # restart. Reset the streak so the pod is not healed for a plumbing problem.
        logger.info("pod_liveness.probe_alive user_id=%s heartbeat_stale=true", user_id)
        await record_state(
            user_id=user_id,
            health_state="degraded",
            liveness_failures=0,
            probed=True,
        )
        return PodLivenessDecision(
            health_state="degraded",
            should_probe=False,
            should_heal=False,
            reason="probe answered; the heartbeat path is broken, not the agent",
        )

    # Confirmed unreachable this pass. Re-judge with the incremented streak so the
    # heal threshold and the backoff are applied by the same rules as everything
    # else, rather than re-implemented here.
    failures += 1
    confirmed = evaluate(
        {**row, "liveness_failures": failures},
        now=moment,
        warm_stale_seconds=stale_seconds,
        heal_enabled=heal_on,
    )

    if not confirmed.should_heal:
        await record_state(
            user_id=user_id,
            health_state=confirmed.health_state,
            liveness_failures=failures,
            probed=True,
        )
        return confirmed

    healed = await heal_pod(row)
    summary["healed"] += 1 if healed else 0
    logger.warning(
        "pod_liveness.heal user_id=%s attempted=true succeeded=%s reason=%s",
        user_id,
        healed,
        confirmed.reason,
    )
    await record_state(
        user_id=user_id,
        health_state=confirmed.health_state,
        liveness_failures=failures,
        probed=True,
        # Stamp the heal only when it actually happened, so a FAILED heal does not
        # start the backoff clock and lock the pod out of its next real attempt.
        healed=healed,
    )
    return confirmed


async def start_liveness_loop(
    *,
    fetch_candidates: FetchCandidates,
    probe_pod: ProbePod,
    heal_pod: HealPod,
    record_state: RecordState,
    interval_seconds: int = 120,
) -> None:
    """Run :func:`run_liveness_pass` forever, re-reading both flags every pass."""
    while True:
        if personal_agent_enabled() and personal_agent_reconcile_enabled():
            try:
                summary = await run_liveness_pass(
                    fetch_candidates=fetch_candidates,
                    probe_pod=probe_pod,
                    heal_pod=heal_pod,
                    record_state=record_state,
                )
                logger.info("pod_liveness.pass %s", summary)
            except Exception as exc:  # noqa: BLE001 - a failed pass must not end the loop
                logger.warning("pod_liveness.pass_failed %s", type(exc).__name__)
        await asyncio.sleep(interval_seconds)
