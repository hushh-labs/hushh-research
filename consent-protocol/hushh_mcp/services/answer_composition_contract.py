"""Bounded paid-answer metadata; private facts never enter this hub contract."""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ProcessingRuntime(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1] = 1
    provider: Literal["gemini", "azure_openai", "openai"]
    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:/-]+$")
    mode: Literal["private", "shared"]
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


class RuntimeBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    owner: str = Field(min_length=1, max_length=256)
    hushh_id: str = Field(min_length=1, max_length=128)
    service_uid: str = Field(min_length=1, max_length=256)
    signing_key_id: str = Field(min_length=1, max_length=128)
    image_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    placement_epoch: int = Field(ge=0)


def private_answer_binding(row: dict[str, Any]) -> dict[str, Any]:
    metadata = row.get("backend_metadata") or {}
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if (
        row.get("status") != "provisioned"
        or not isinstance(metadata, dict)
        or "erasure" in metadata
    ):
        raise ValueError("private_answer_runtime_unavailable")
    from hushh_mcp.services.personal_agent_upgrade_policy import running_image

    image = running_image({**row, "backend_metadata": metadata}) or ""
    digest = re.search(r"@sha256:([a-f0-9]{64})$", image)
    if digest is None:
        raise ValueError("private_answer_image_unqualified")
    return RuntimeBinding(
        owner=row["user_id"],
        hushh_id=row["hushh_id"],
        service_uid=metadata.get("serviceUid", ""),
        signing_key_id=row.get("pod_signing_key_id", ""),
        image_digest=digest[1],
        placement_epoch=row.get("placement_epoch", 0),
    ).model_dump()


class PaidAnswerAuthority(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    requestId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    termsDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    question: str = Field(min_length=1, max_length=2000)
    modelProcessingConsented: Literal[True]
    processingRuntime: ProcessingRuntime | None
    approvedScopes: list[str] = Field(min_length=1, max_length=100)
    omittedScopes: list[str] = Field(max_length=100)
    period: dict[str, str] | None
    runtimeBinding: RuntimeBinding
    authorityToken: str = Field(min_length=1, max_length=4096)


class PrivateCompositionAssertion(BaseModel):
    """No arbitrary prose, projection, coverage or credential fields are admitted."""

    model_config = ConfigDict(extra="forbid", strict=True)
    authorityToken: str = Field(min_length=1, max_length=4096)
    processingRuntime: ProcessingRuntime
    selectionRevision: int = Field(ge=0)
    runtimeMode: Literal["byok", "user_adc", "hosted_pod_adc", "user_azure_mi"]
    answerDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    inputDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
