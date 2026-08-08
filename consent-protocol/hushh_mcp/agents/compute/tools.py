# SPDX-FileCopyrightText: 2026 Hushh Labs
# SPDX-License-Identifier: Apache-2.0

"""Tools for the Compute specialist.

**This agent runs in the person's pod. Their machine is somewhere else.**

That one fact shapes everything here. The pod cannot see the person's cores,
memory, or accelerator, so nothing in this module measures anything or decides
anything. Measurement and placement happen in Hermes, on the device, where the
numbers actually are — see ``hermes_cli/hussh_one_burst/`` in
``hushh-labs/hussh-one-hermes``.

If these tools measured the container they run in, they would report the pod's
hardware as the person's and answer confidently with someone else's numbers.
So they don't measure. They explain, and they narrate a decision the device has
already made.

The placement engine is deliberately **not** reimplemented here. Two copies of
that logic in two repositories is precisely the divergence that the
``puppy``/``gcp`` vocabulary split already cost this capability once.
"""

from __future__ import annotations

from typing import Any, Optional

#: Where a job runs, in Hermes' vocabulary.  Kept as data rather than a literal
#: so the pod never invents a third name for the same two places.
_TARGET_LABELS = {
    "device": "on your own machine",
    "cloud": "in your own cloud",
}


def describe_burst_capability() -> dict[str, Any]:
    """Explain what Xtreme Burst does and where the decision gets made.

    Use this when the person asks what bursting is, whether their machine can
    handle something, or why a job would go to the cloud.
    """
    return {
        "what_it_is": (
            "Xtreme Burst runs heavy compute on your own machine when it fits, and "
            "moves it to your own cloud account when it does not."
        ),
        "where_the_decision_happens": (
            "On your machine. Hermes measures the free memory, disk and accelerator "
            "there and decides from those numbers alone — nothing about the workload "
            "itself is sent anywhere to make that decision."
        ),
        "who_pays": (
            "You do, directly. The accelerator is provisioned in your own cloud "
            "project with your own credentials, and torn down when the job ends."
        ),
        "what_this_agent_can_do": [
            "explain a placement decision your machine has already made",
            "explain what bursting costs and why hardware was chosen",
        ],
        "what_this_agent_cannot_do": [
            "measure your machine — it is not running on it",
            "decide placement — your device decides, this agent explains",
        ],
    }


def explain_placement_decision(
    target: str,
    reason: str,
    workload: Optional[str] = None,
    accelerator: Optional[str] = None,
    estimated_cost_usd: Optional[float] = None,
) -> dict[str, Any]:
    """Turn a placement decision made on the person's device into plain language.

    Pass the decision exactly as Hermes reported it. Never invent these values:
    if a decision has not been supplied, say so and offer to check the machine
    instead of guessing at one.
    """
    normalized = (target or "").strip().lower()
    if normalized not in _TARGET_LABELS:
        return {
            "status": "unknown_target",
            "message": (
                f"'{target}' is not a placement this system produces. Ask the person's "
                "device to report the decision again rather than guessing."
            ),
        }

    summary = f"This will run {_TARGET_LABELS[normalized]}."
    detail: dict[str, Any] = {
        "status": "explained",
        "target": normalized,
        "summary": summary,
        "reason": reason,
        "decided_by": "the person's own device",
    }
    if workload:
        detail["workload"] = workload
    if normalized == "cloud":
        if accelerator:
            detail["hardware"] = accelerator
        if estimated_cost_usd is not None:
            detail["estimated_cost_usd"] = round(float(estimated_cost_usd), 2)
            detail["cost_note"] = (
                "An estimate on modeled rates, billed by your own cloud provider — "
                "not a quote."
            )
        detail["teardown"] = (
            "The instance is released when the job finishes, fails, or hits its deadline."
        )
    return detail
