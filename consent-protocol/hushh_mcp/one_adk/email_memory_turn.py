"""Request-only memory projection and acknowledgment of the existing PKM ledger."""

from __future__ import annotations

from typing import Any

from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret

STATE_EMAIL_MEMORY = "temp:one_email_memory_projection"
STATE_EMAIL_MEMORY_COMMIT = "temp:one_email_memory_commit"
STATE_EMAIL_MEMORY_PENDING = "hussh:email_memory_pending"


class _Projection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: str = Field(pattern=r"^one_memory\.markdown$")
    owner_id: str = Field(min_length=1, max_length=256)
    markdown: str = Field(max_length=18_000)
    budget_chars: int = Field(default=18_000, ge=1, le=18_000)
    revision: int | None = Field(default=None, ge=0)


class _Commit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str = Field(min_length=36, max_length=36)
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    receipt_ref: str = Field(pattern=r"^pkm_plan_[a-f0-9]{32}$")
    revision: int = Field(ge=0)
    saved_count: int = Field(ge=0, le=1)


def admit_email_memory(forwarded: dict, *, user_id: str | None, admitted: bool) -> dict:
    projection = forwarded.pop("emailMemoryProjection", None)
    commit = forwarded.pop("emailMemoryCommit", None)
    result = {STATE_EMAIL_MEMORY: "", STATE_EMAIL_MEMORY_COMMIT: ""}
    if not admitted or not user_id:
        return result
    if projection is not None:
        parsed = _Projection.model_validate(projection)
        if (
            parsed.owner_id != user_id
            or len(parsed.markdown.encode("utf-16-le")) // 2 > parsed.budget_chars
        ):
            raise ValueError("Memory projection does not match the current owner or budget")
        result[STATE_EMAIL_MEMORY] = store_request_secret(parsed.markdown)
    if commit is not None:
        parsed_commit = _Commit.model_validate(commit)
        result[STATE_EMAIL_MEMORY_COMMIT] = store_request_secret(parsed_commit.model_dump_json())
    return result


def pending_memory_receipt(directive: dict) -> dict:
    from hushh_mcp.services.email_oss.memory import memory_save_plan_id

    return {
        "request_id": directive["request_id"],
        "digest": directive["digest"],
        "receipt_ref": memory_save_plan_id(directive),
    }


async def email_memory_before_model(callback_context: Any, llm_request: Any) -> None:
    """Browser success alone is insufficient; prove this pending owner commit."""
    state = callback_context.state
    raw = resolve_request_secret(state.get(STATE_EMAIL_MEMORY_COMMIT))
    pending = state.get(STATE_EMAIL_MEMORY_PENDING)
    if not raw or not isinstance(pending, dict):
        return
    try:
        receipt = _Commit.model_validate_json(raw)
    except ValidationError:
        return
    if any(
        getattr(receipt, name) != pending.get(name)
        for name in ("request_id", "digest", "receipt_ref")
    ):
        return
    from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
    from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

    owner = str(state.get("hussh:user_id") or "")
    token = resolve_request_secret(state.get("hussh:consent_token"))
    if await validate_first_party_owner_token(owner, token) is None:
        return
    rows = await get_pkm_service().find_mutation_commits(
        user_id=owner, commits=[("one_memory", receipt.receipt_ref)]
    )
    if await validate_first_party_owner_token(owner, token) is None:
        return
    if (
        not rows
        or rows[0].get("exists") is not True
        or rows[0].get("data_version") != receipt.revision
    ):
        return
    instruction = "\nMEMORY COMMIT: The existing owner-scoped PKM ledger confirms the pending memory write committed. You may acknowledge it as saved."
    llm_request.config = llm_request.config or types.GenerateContentConfig()
    current = llm_request.config.system_instruction
    if isinstance(current, str):
        llm_request.config.system_instruction = current + instruction
    elif isinstance(current, types.Content):
        llm_request.config.system_instruction = current.model_copy(
            update={"parts": list(current.parts or []) + [types.Part(text=instruction)]}
        )
    else:
        llm_request.config.system_instruction = instruction
    state[STATE_EMAIL_MEMORY_PENDING] = None
    state[STATE_EMAIL_MEMORY_COMMIT] = ""
