"""Profile can be asked about itself now.

Location has had read tools since #6434; Profile had none, so One could open
the Security panel and still not say what was in it. "Is my phone verified",
"how many consents are waiting on me" and "is my marketplace profile visible"
were unanswerable next to a screen displaying all three.

The property these tests care about most is R9: unknown is not absent. Each
field is read from a different service, and a service being briefly unreachable
must report "could not check" rather than "no" -- otherwise One tells someone
their phone is unverified because a table was slow, which is worse than
silence.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.one_adk.action_tools import read_my_profile_status
from hushh_mcp.one_adk.agent_tree import STATE_CONSENT_TOKEN, STATE_USER_ID
from tests.test_one_adk_agent_tree import _tool_context


def _state() -> dict:
    return {STATE_USER_ID: "user_1", STATE_CONSENT_TOKEN: "token_1"}


def _auth():
    return patch(
        "hushh_mcp.one_adk.action_tools.validate_token_with_db",
        new=AsyncMock(return_value=(True, None, SimpleNamespace(user_id="user_1"))),
    )


def _identity(**fields):
    return patch(
        "hushh_mcp.one_adk.action_tools.ActorIdentityService.get_many",
        new=AsyncMock(return_value={"user_1": fields}),
    )


def _consents(pending: int):
    return patch(
        "hushh_mcp.one_adk.action_tools.ConsentCenterService.get_center_summary",
        new=AsyncMock(return_value={"counts": {"pending": pending}}),
    )


def _persona(opt_in: bool):
    return patch(
        "hushh_mcp.one_adk.action_tools.RIAIAMService.get_persona_state",
        new=AsyncMock(return_value={"investor_marketplace_opt_in": opt_in}),
    )


@pytest.mark.asyncio
async def test_it_answers_the_three_questions_profile_could_not() -> None:
    with (
        _auth(),
        _identity(phone_verified=True, email_verified=False),
        _consents(3),
        _persona(True),
    ):
        result = await read_my_profile_status(_tool_context(_state()))

    assert result["status"] == "ok"
    assert result["result"] == {
        "phone_verified": True,
        "email_verified": False,
        "pending_consents": 3,
        "marketplace_visible": True,
    }


@pytest.mark.asyncio
async def test_one_failing_service_does_not_lose_the_other_answers() -> None:
    """Partial beats nothing: the other two questions are still answerable."""
    with (
        _auth(),
        patch(
            "hushh_mcp.one_adk.action_tools.ActorIdentityService.get_many",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ),
        _consents(1),
        _persona(False),
    ):
        result = await read_my_profile_status(_tool_context(_state()))

    assert result["status"] == "ok"
    assert result["result"]["pending_consents"] == 1
    assert result["result"]["marketplace_visible"] is False


@pytest.mark.asyncio
async def test_an_unreadable_field_is_unknown_not_false() -> None:
    """R9. This is the whole reason each read has its own boundary.

    Collapsing an unavailable read into False would have One state that a
    phone is unverified because a service blipped -- a confident wrong answer
    about the person's own security posture.
    """
    with (
        _auth(),
        patch(
            "hushh_mcp.one_adk.action_tools.ActorIdentityService.get_many",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ),
        _consents(0),
        _persona(False),
    ):
        result = await read_my_profile_status(_tool_context(_state()))

    assert result["result"]["phone_verified"] is None
    assert result["result"]["email_verified"] is None
    # ...and a genuine zero/false is still reported as itself, or the null
    # above would just mean "we report nothing".
    assert result["result"]["pending_consents"] == 0
    assert result["result"]["marketplace_visible"] is False


@pytest.mark.asyncio
async def test_total_failure_says_so_once() -> None:
    """Four nulls invite the model to narrate around them; one honest failure does not."""
    with (
        _auth(),
        patch(
            "hushh_mcp.one_adk.action_tools.ActorIdentityService.get_many",
            new=AsyncMock(side_effect=RuntimeError("down")),
        ),
        patch(
            "hushh_mcp.one_adk.action_tools.ConsentCenterService.get_center_summary",
            new=AsyncMock(side_effect=RuntimeError("down")),
        ),
        patch(
            "hushh_mcp.one_adk.action_tools.RIAIAMService.get_persona_state",
            new=AsyncMock(side_effect=RuntimeError("down")),
        ),
    ):
        result = await read_my_profile_status(_tool_context(_state()))

    assert result["status"] == "failed"


@pytest.mark.asyncio
async def test_it_refuses_without_a_revalidated_vault_owner_token() -> None:
    """Same auth gate as every other read tool -- these are consent-scoped reads."""
    with patch(
        "hushh_mcp.one_adk.action_tools.validate_token_with_db",
        new=AsyncMock(return_value=(False, "invalid", None)),
    ):
        result = await read_my_profile_status(_tool_context(_state()))

    assert result["status"] == "blocked"
