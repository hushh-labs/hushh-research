"""Typed consumer-MCP memory door for the owner's pod.

The hub sends a short-lived ``cap.consumer.memory`` token.  The pod asks the
hub authority to verify that token against its own HusshID before recovering
custody or touching its local PKM.  No caller-selected owner or role is trusted.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consumer_mcp_memory import ConsumerMemoryInvalid
from hushh_mcp.services.pod_consent_client import require_owner_scope
from hushh_mcp.services.pod_consumer_memory import (
    PodConsumerMemoryConflict,
    PodConsumerMemoryUnavailable,
    execute_pod_consumer_memory,
)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])


class PodConsumerMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    owner_id: str = Field(..., alias="ownerId", min_length=1, max_length=128)
    connection_id: str = Field(..., alias="connectionId", min_length=1, max_length=128)
    generation: int = Field(..., ge=1)
    operation: Literal["read", "query", "save", "correct", "export"]
    arguments: dict[str, Any]


@router.post("/consumer/memory")
async def pod_consumer_memory_route(
    payload: PodConsumerMemoryRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
) -> dict[str, Any]:
    token = str(x_consent_token or "").strip()
    if not token:
        raise HTTPException(status_code=403, detail="consumer memory grant required")
    try:
        verdict = await require_owner_scope(
            token,
            expected_scope=ConsentScope.CAP_CONSUMER_MEMORY.value,
            user_id=payload.owner_id,
            expected_agent_id=f"consumer_mcp:{payload.connection_id}:{payload.generation}",
        )
        result = await execute_pod_consumer_memory(
            owner_id=verdict.user_id,
            operation=payload.operation,
            arguments=payload.arguments,
        )
    except PermissionError as exc:
        raise HTTPException(
            status_code=403, detail="consumer memory grant is not valid here"
        ) from exc
    except ConsumerMemoryInvalid as exc:
        raise HTTPException(status_code=422, detail="invalid consumer memory request") from exc
    except PodConsumerMemoryConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "MEMORY_REVISION_CONFLICT", "message": str(exc)},
        ) from exc
    except PodConsumerMemoryUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "OWNER_POD_MEMORY_UNAVAILABLE", "message": str(exc)},
        ) from exc
    return {
        "provider": "owner_pod_pkm",
        "execution_target": "owner_pod",
        **result,
    }


__all__ = ["PodConsumerMemoryRequest", "pod_consumer_memory_route", "router"]
