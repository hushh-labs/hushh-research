"""Run one public PWM slice under a website processing grant."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.managed_ai_config import load_pwm_policy
from hushh_mcp.one_adk.azure_workload_identity import azure_openai_token_provider
from hushh_mcp.one_adk.world_model_azure import run_world_model_azure
from hushh_mcp.runtime_settings import get_app_runtime_settings, one_profile_research_enabled
from hushh_mcp.services.profile_research_service import resolve_profile_research_identity
from hushh_mcp.services.world_model_preferences import AZURE_TAVILY_CONSENT_VERSION
from hushh_mcp.services.world_model_service import fresh_owner_record


@dataclass(frozen=True)
class WebsiteResearchGrant:
    owner_id: str
    job_id: str
    consent_version: str
    expires_at: datetime


async def run_website_research_slice(
    grant: WebsiteResearchGrant,
    *,
    read_active_grant: Callable[[], Awaitable[WebsiteResearchGrant | None]],
    reserve_attempts: Callable[[tuple[int, ...]], Awaitable[None]],
    save_checkpoint: Callable[[dict[str, Any]], Awaitable[None]],
    attempts_used: tuple[int, ...] = (),
    checkpoint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Use the website's authenticated, lease-bound grant and checkpoint authority.

    The caller must bind all three callbacks to the same active grant and job lease.
    The worker holds no Vault key and has no Memory write authority.
    """
    policy = load_pwm_policy()
    if (
        get_app_runtime_settings().environment != "uat"
        or not one_profile_research_enabled()
        or policy["provider"] != "azure_openai_tavily"
        or grant.consent_version != AZURE_TAVILY_CONSENT_VERSION
    ):
        raise PermissionError("Website PWM research is unavailable for this grant")

    async def require_access() -> None:
        if (
            grant.expires_at <= datetime.now(timezone.utc)
            or await read_active_grant() != grant
        ):
            raise PermissionError("Website research grant is no longer active")

    await require_access()
    record = await fresh_owner_record(grant.owner_id)
    identity = await resolve_profile_research_identity(grant.owner_id, record)
    name, email, phone = (identity[key] for key in ("full_name", "email", "phone_number"))
    if (
        not name
        or len(name) > 160
        or any(ord(character) < 32 for character in name)
        or (email is not None and (not isinstance(email, str) or len(email) > 320))
        or (phone is not None and not re.fullmatch(r"\+[1-9]\d{7,14}", phone))
        or not (email or phone)
    ):
        return {"status": "insufficient_identity", "pkm_written": False}
    if checkpoint is not None and checkpoint.get("identity") != identity:
        raise PermissionError("Website research identity changed")

    async def reserve(slots: tuple[int, ...]) -> None:
        await require_access()
        await reserve_attempts(slots)

    async def persist(work: dict[str, Any]) -> None:
        await require_access()
        await save_checkpoint({"identity": identity, "work": work})

    azure = policy["azure"]
    result = await run_world_model_azure(
        identity=identity,
        user_id=grant.owner_id,
        consent_token="",
        require_access=require_access,
        on_attempts_start=reserve,
        on_progress=persist,
        attempts_used=attempts_used,
        work=checkpoint["work"] if checkpoint is not None else None,
        primary_endpoint=azure["primary_endpoint"],
        primary_deployment=azure["primary_deployment"],
        primary_token_supplier=azure_openai_token_provider(
            tenant_id=azure["tenant_id"], client_id=azure["client_id"]
        ),
        search_provider="tavily",
    )
    await require_access()
    if await resolve_profile_research_identity(
        grant.owner_id, await fresh_owner_record(grant.owner_id)
    ) != identity:
        raise PermissionError("Website research identity changed")
    await require_access()
    return {
        key: result[key]
        for key in ("status", "pkm_written", "restart_required", "report", "research")
        if key in result
    }
