"""Is this person's agent actually alive -- and if not, what is the honest reason?

The question sounds like it has one answer and it has two, because a pod's silence
means opposite things depending on how that pod was created:

    warm     (minScale >= 1)  a paid always-on instance. It is SUPPOSED to be
                              running, so silence is a fault.
    economy  (minScale  = 0)  scale-to-zero. It is SUPPOSED to be asleep when
                              idle, so silence is the healthy steady state.

Applying the warm rule to the economy tier is not a cosmetic mistake. The sweep
would find every sleeping pod "unreachable", probe it -- which WAKES it, because an
inbound request is exactly what scales a Cloud Run service off zero -- and then
"heal" it. The result is that the tier built to cost nothing while idle is kept
permanently awake by its own health check, and the bill lands on the founder as a
mystery. That failure mode is why ``liveness_mode`` is a stored per-row column
(migration 905) rather than a lookup of the current ``HUSSH_POD_MIN_INSTANCES``.

What this module is
-------------------
:func:`evaluate` is a PURE function: a row plus a clock in, a decision out. No
database, no network, no environment reads beyond the thresholds passed to it. All
the policy that is easy to get wrong is therefore testable without a pod, a cloud
project, or a clock that actually advances -- and the sweep that applies the
decisions holds no policy of its own.

Why "probe" and "heal" are separate outputs
-------------------------------------------
A stale heartbeat is evidence that a pod has stopped TALKING. It is not evidence
that the pod is DOWN: the hub could have been rolled, the heartbeat route could
have 500'd, the pod's egress could be broken while it still serves fine. Restarting
someone's agent on that evidence would be acting on an unconfirmed inference. So
the ladder is always observe -> confirm -> act, and a heal is only ever proposed
for a pod whose failure was CONFIRMED by an actual probe, repeatedly
(``failure_threshold``), and only when the heal switch is on.

What healing is, and what it must never be
------------------------------------------
Healing replaces the pod's SERVICE (``GcpRunClient.replace_service``, a PUT that
rolls a new revision). It must never be ``deprovision()`` followed by
``provision()``: deprovision revokes the standing pkm.read grant, writes a deletion
tombstone and deletes the registry row, and re-provisioning then mints a NEW
HusshID. The person's agent identity -- the thing their consent receipts, their A2A
address and their pod's published public key all point at -- would silently become
a different agent because a health check timed out. The HusshID survives a heal.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Health states. Mirrors the CHECK constraint in migration 905 -- if these ever
# diverge the database rejects the write, which is the intended failure direction.
HEALTH_UNKNOWN = "unknown"
HEALTH_HEALTHY = "healthy"
HEALTH_DEGRADED = "degraded"
HEALTH_UNREACHABLE = "unreachable"
HEALTH_SLEEPING = "sleeping"

MODE_WARM = "warm"
MODE_ECONOMY = "economy"

# A newly created pod has not had time to say anything yet. Judging it before its
# first heartbeat could plausibly have arrived would mark every fresh provision
# unreachable and, with healing on, restart pods that were merely still booting.
# Boot was measured at ~3.9s; a minute is generous cover for image pull + cold start.
_BOOT_GRACE_SECONDS = 120

# Consecutive CONFIRMED failures before a heal is proposed. Two, not one: one probe
# failure is a blip (a cold start that outran the timeout, a transient 503 mid-roll),
# and a service replacement is too blunt an answer to a single missed request.
_DEFAULT_FAILURE_THRESHOLD = 2

# Minimum gap between heals of the same pod. A pod broken in a way a restart cannot
# fix -- a bad image, poisoned config, a crash-on-import -- would otherwise be
# restarted every sweep forever, turning auto-heal into a self-inflicted outage loop
# that also hides the real fault behind endless "healing" noise.
_DEFAULT_HEAL_BACKOFF_SECONDS = 1800


@dataclass(frozen=True)
class PodLivenessDecision:
    """What the hub concluded about one pod, and what (if anything) to do next."""

    health_state: str
    should_probe: bool
    should_heal: bool
    reason: str

    @property
    def is_actionable(self) -> bool:
        return self.should_probe or self.should_heal


def _parse_ts(value: Any) -> Optional[datetime]:
    """Parse a timestamp column into an aware datetime, or None.

    Returns None for anything unparseable rather than raising. A malformed
    timestamp must not be able to take down a fleet-wide sweep, and None routes
    into the same branch as "never heard from", which is the conservative reading.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        logger.info("pod_liveness.unparseable_timestamp")
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def evaluate(
    row: dict,
    *,
    now: datetime,
    warm_stale_seconds: int,
    failure_threshold: int = _DEFAULT_FAILURE_THRESHOLD,
    heal_backoff_seconds: int = _DEFAULT_HEAL_BACKOFF_SECONDS,
    heal_enabled: bool = False,
) -> PodLivenessDecision:
    """Judge one registry row. Pure: no I/O, no globals, no ambient clock.

    ``now`` is injected rather than read here so the whole ladder -- boot grace,
    staleness, heal backoff -- is exercisable at any point in time without waiting.
    """
    mode = str(row.get("liveness_mode") or MODE_WARM).strip() or MODE_WARM
    failures = int(row.get("liveness_failures") or 0)
    last_beat = _parse_ts(row.get("last_heartbeat_at"))
    created = _parse_ts(row.get("created_at"))
    last_healed = _parse_ts(row.get("last_healed_at"))

    # -- never heard from -----------------------------------------------------
    if last_beat is None:
        # Still inside the boot window: not yet evidence of anything.
        if created is not None and (now - created) < timedelta(seconds=_BOOT_GRACE_SECONDS):
            return PodLivenessDecision(
                health_state=HEALTH_UNKNOWN,
                should_probe=False,
                should_heal=False,
                reason="within boot grace; no heartbeat expected yet",
            )
        # An economy pod that has never spoken is indistinguishable from one that
        # is simply asleep and has never been needed. Probing to find out would
        # wake it -- paying, on a schedule, for the answer to a question nobody
        # asked. The honest label is that we do not know, and that is where it
        # stays until real demand (an owner opening their agent) wakes it anyway.
        if mode == MODE_ECONOMY:
            return PodLivenessDecision(
                health_state=HEALTH_UNKNOWN,
                should_probe=False,
                should_heal=False,
                reason="economy pod has never reported; silence is not evidence of failure",
            )
        return PodLivenessDecision(
            health_state=HEALTH_DEGRADED,
            should_probe=True,
            should_heal=False,
            reason="warm pod past boot grace with no heartbeat ever",
        )

    age_seconds = (now - last_beat).total_seconds()

    # -- economy: silence is the healthy steady state -------------------------
    if mode == MODE_ECONOMY:
        # Deliberately no staleness ladder and no scheduled probe. `sleeping` is a
        # distinct state from `healthy` because it is a different fact -- the pod is
        # not currently serving -- and the presence surface should be able to say
        # "asleep, wakes on demand" rather than implying a warm instance is standing
        # by. It is emphatically NOT a fault: nothing here proposes a probe or a heal.
        if age_seconds > warm_stale_seconds:
            return PodLivenessDecision(
                health_state=HEALTH_SLEEPING,
                should_probe=False,
                should_heal=False,
                reason="economy pod idle and scaled to zero, as designed",
            )
        return PodLivenessDecision(
            health_state=HEALTH_HEALTHY,
            should_probe=False,
            should_heal=False,
            reason="economy pod reported recently",
        )

    # -- warm: silence is a fault ---------------------------------------------
    if age_seconds <= warm_stale_seconds:
        return PodLivenessDecision(
            health_state=HEALTH_HEALTHY,
            should_probe=False,
            should_heal=False,
            reason="heartbeat is fresh",
        )

    # Stale. Not yet confirmed dead -- the pod may serve fine while its heartbeat
    # path is broken -- so this proposes a probe, never a heal.
    if failures < failure_threshold:
        return PodLivenessDecision(
            health_state=HEALTH_DEGRADED,
            should_probe=True,
            should_heal=False,
            reason=f"warm heartbeat stale by {int(age_seconds - warm_stale_seconds)}s",
        )

    # Confirmed unreachable: the probe has failed `failure_threshold` times running.
    #
    # Every branch below still asks for a probe. A stale warm pod is ALWAYS worth
    # confirming: the streak and the heal switch govern whether a confirmed failure
    # may ESCALATE to a restart, they do not make the pod's real state less worth
    # knowing. Suppressing the probe here would leave a pod that recovered on its own
    # marked unreachable until it happened to beat again -- and, worse, would let a
    # heal fire on a streak accumulated minutes ago without one fresh check that the
    # pod is still down.
    if not heal_enabled:
        # Report the truth and keep watching. Detection is useful on its own, and it is what
        # runs while a human is still deciding whether the fleet may restart itself.
        return PodLivenessDecision(
            health_state=HEALTH_UNREACHABLE,
            should_probe=True,
            should_heal=False,
            reason=f"confirmed unreachable after {failures} probes; auto-heal is off",
        )
    if last_healed is not None and (now - last_healed) < timedelta(seconds=heal_backoff_seconds):
        # Already healed recently and still unreachable, so the restart did not fix
        # it. Repeating it would only produce a louder loop; leave it visibly
        # unreachable for a human, which is the accurate state.
        return PodLivenessDecision(
            health_state=HEALTH_UNREACHABLE,
            should_probe=True,
            should_heal=False,
            reason="unreachable after a recent heal; backing off for a human",
        )
    return PodLivenessDecision(
        health_state=HEALTH_UNREACHABLE,
        should_probe=True,
        should_heal=True,
        reason=f"confirmed unreachable after {failures} probes; proposing service replacement",
    )
