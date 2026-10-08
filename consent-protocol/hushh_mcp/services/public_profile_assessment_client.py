"""Official A2A client for HusshOne's public-only assessment capability."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import uuid4

import httpx
from a2a.client import A2AClient
from a2a.types import GetTaskRequest, SendMessageRequest
from pydantic import BaseModel, ConfigDict, Field


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IdentityAssessment(StrictContract):
    verdict: Literal["matched", "ambiguous", "insufficient_evidence"]
    reason: str = Field(max_length=1000)


class PublicFinding(StrictContract):
    category: str = Field(min_length=1, max_length=80)
    claim: str = Field(min_length=1, max_length=2000)
    confidence: Literal["low", "medium", "high"] | None
    support: str | None = Field(max_length=4000)
    source_urls: list[str] = Field(min_length=1, max_length=12)
    observed_at: datetime | None
    collected_at: datetime


class AssessmentProvenance(StrictContract):
    model: str = Field(min_length=1, max_length=200)
    prompt_version: Literal["public-profile.v1"]
    mode: Literal["fixture", "vertex"]
    acquisition_refs: list[str] = Field(max_length=100)


class PreparedPublicProfile(StrictContract):
    schema_version: Literal["public_profile_review.v1"]
    entity_id: str
    revision: int = Field(ge=1)
    display_name: str = Field(min_length=1, max_length=160)
    summary: str = Field(max_length=4000)
    collected_at: datetime
    identity: IdentityAssessment
    facts: list[PublicFinding] = Field(max_length=100)
    sources: list[str] = Field(max_length=100)
    conflicts: list[str] = Field(max_length=20)
    warnings: list[str] = Field(max_length=20)
    provenance: AssessmentProvenance


def reject_public_contact(value: str) -> None:
    """Reject contact-bearing provider text, including encoded source paths."""
    from urllib.parse import unquote

    from hushh_mcp.services.public_profile_discovery_service import (
        _clean_text,
        _safe_public_text,
    )

    decoded = value
    for _ in range(4):
        limit = max(len(decoded), 1)
        if _safe_public_text(decoded, limit=limit) != _clean_text(decoded, limit=limit):
            raise ValueError("Public profile contains contact information")
        next_value = unquote(decoded)
        if next_value == decoded:
            return
        decoded = next_value
    raise ValueError("Public profile contains excessively encoded text")


def _validate_public_fields(value: Any) -> None:
    if isinstance(value, str):
        reject_public_contact(value)
    elif isinstance(value, list):
        for item in value:
            _validate_public_fields(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key not in {"entity_id", "observed_at", "collected_at"}:
                _validate_public_fields(item)


def validate_prepared_profile(value: Any) -> dict[str, Any]:
    from uuid import UUID

    from hushh_mcp.services.public_profile_discovery_service import _public_url

    profile = PreparedPublicProfile.model_validate(value).model_dump(mode="json")
    UUID(profile["entity_id"])
    _validate_public_fields(profile)
    if profile["schema_version"] != "public_profile_review.v1":
        raise ValueError("Unsupported profile schema")
    if profile["identity"].get("verdict") not in {"matched", "ambiguous", "insufficient_evidence"}:
        raise ValueError("Invalid identity verdict")
    if not profile["provenance"].get("model") or profile["provenance"].get("mode") not in {
        "fixture",
        "vertex",
    }:
        raise ValueError("Missing model provenance")
    for url in profile["sources"]:
        if _public_url(url) != url:
            raise ValueError("Public profile source must be canonical")
    for fact in profile["facts"]:
        if not isinstance(fact.get("claim"), str) or not fact.get("source_urls"):
            raise ValueError("Finding without evidence")
        if any(url not in profile["sources"] for url in fact["source_urls"]):
            raise ValueError("Undeclared source")
    if profile["identity"]["verdict"] == "matched" and not profile["facts"]:
        raise ValueError("Empty matched profile")
    return profile


class PublicAssessmentClient:
    def __init__(self, client: httpx.AsyncClient, base_url: str, api_key: str):
        self._client = A2AClient(
            httpx_client=client, url=base_url.rstrip("/") + "/api/v1/public-profile/tasks"
        )
        self._http_kwargs = {"headers": {"Authorization": f"Bearer {api_key}"}}

    async def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.send_message(
            SendMessageRequest.model_validate(
                {
                    "id": str(uuid4()),
                    "params": {
                        "message": {
                            "kind": "message",
                            "role": "user",
                            "messageId": payload["operationId"],
                            "parts": [{"kind": "data", "data": payload}],
                        },
                        "configuration": {"blocking": False},
                    },
                }
            ),
            http_kwargs=self._http_kwargs,
        )
        return self._result(response)

    async def get(self, task_id: str) -> dict[str, Any]:
        response = await self._client.get_task(
            GetTaskRequest.model_validate(
                {
                    "id": str(uuid4()),
                    "params": {"id": task_id},
                }
            ),
            http_kwargs=self._http_kwargs,
        )
        return self._result(response)

    @staticmethod
    def _result(response) -> dict[str, Any]:
        payload = response.model_dump(mode="json", exclude_none=True)
        if "error" in payload or not isinstance(payload.get("result"), dict):
            raise ValueError("Assessment task unavailable")
        return payload["result"]
