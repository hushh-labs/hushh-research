"""Settle an accepted replacement from its existing exact revision verdict."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TypeVar

from hushh_mcp.services.azure_arm_client import ArmClient, ArmError, ArmResponse
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused

logger = logging.getLogger(__name__)
_Observation = TypeVar("_Observation")


def confirm_replacement(
    arm: ArmClient, response: ArmResponse, *, read_verdict: Callable[[], _Observation]
) -> _Observation:
    unsettled = False
    try:
        if arm.needs_poll(response):
            arm.wait(response, "deploying_agent")
    except (ArmError, OSError) as exc:
        unsettled = True
        logger.warning("user_azure_backend.replace_poll_failed err=%s", type(exc).__name__)
    try:
        observation = read_verdict()
    except AzureSetupRefused as exc:
        if unsettled and exc.code == "UPGRADE_REVISION_FAILED":
            arm.confirm_observed_mutation(response, succeeded=False)
        raise
    if unsettled:
        arm.confirm_observed_mutation(response, succeeded=True)
    return observation
