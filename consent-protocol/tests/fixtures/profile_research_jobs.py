"""Shared owner-admission fixtures for discovery/job contract tests."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import profile_research_jobs as jobs
from tests.fixtures.profile_research_store import MemoryStore

RESULT = {
    "status": "offered",
    "pkm_written": False,
    "report": {
        "match_status": "no_match",
        "name": "Example Person",
        "summary": "No reliable public match.",
        "sections": [],
    },
    "search_suggestions": [],
}


@pytest.fixture(autouse=True)
def authority(monkeypatch, shared_hub_owner):
    from hushh_mcp.services import owner_placement_guard

    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value="shared")
    )
    monkeypatch.setattr(jobs, "admit_hub_content", AsyncMock())
    from hushh_mcp.services import world_model_service

    monkeypatch.setattr(
        world_model_service,
        "preferences",
        AsyncMock(
            return_value={
                "enabled": True,
                "generation": "00000000-0000-4000-8000-000000000001",
                "auto_started_at": None,
            }
        ),
    )
    monkeypatch.setattr(jobs, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    monkeypatch.setattr(jobs, "one_profile_research_enabled", lambda: True)
    # The breaker is process-wide; one test's provider refusals must not leak.
    monkeypatch.setattr(jobs, "provider_breaker", jobs.ProviderBreaker())


def manager(store=None, offer=None, check=None, clock=None):
    return jobs.ProfileResearchJobs(
        store=store or MemoryStore(),
        offer=offer or AsyncMock(return_value=RESULT),
        check=check or AsyncMock(return_value=(None, "owner-bound-identity")),
        **({"clock": clock} if clock else {}),
    )


async def settle(instance):
    if instance.tasks:
        await asyncio.gather(*list(instance.tasks))


def pwm_manager(monkeypatch, **kwargs):
    from hushh_mcp.services import world_model_service as pwm

    monkeypatch.setattr(pwm, "validate_first_party_owner_token", AsyncMock(return_value=object()))
    return pwm.WorldModelJobs(
        store=kwargs.pop("store", MemoryStore()),
        offer=kwargs.pop("offer", AsyncMock(return_value=RESULT)),
        check=kwargs.pop("check", AsyncMock(return_value=(None, "owner-bound-identity"))),
        max_attempts=52,
        stored_attempts=52,
        review_ids=True,
        preserve_budget_on_identity_change=True,
        **kwargs,
    )
