"""Owner-only review intent for a future hosted Live Memory pilot.

No endpoint in this router pairs a worker, accepts a key, or enables capture.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token
from hushh_mcp.services.hosted_memory_envelope_contract import decode_base64url
from hushh_mcp.services.hosted_memory_envelope_service import (
    HostedMemoryEnvelopeConflict,
    HostedMemoryEnvelopeService,
    HostedMemoryEnvelopeUnavailable,
)
from hushh_mcp.services.hosted_memory_pilot_service import (
    HostedMemoryPilotConflict,
    HostedMemoryPilotService,
    HostedMemoryPilotUnavailable,
)

logger = logging.getLogger(__name__)
_NO_STORE = {"Cache-Control": "private, no-store"}


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status, detail={"code": code, "message": message}, headers=_NO_STORE
    )


class _PrivateRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                raise HTTPException(
                    exc.status_code, exc.detail, headers={**(exc.headers or {}), **_NO_STORE}
                ) from None
            except RequestValidationError:
                raise _error(
                    422, "INVALID_PILOT_REVIEW", "Review the selected source and custody terms."
                ) from None
            response.headers.update(_NO_STORE)
            return response

        return private_handler


router = APIRouter(
    prefix="/api/one/hosted-memory/pilot",
    tags=["Hosted Memory Pilot"],
    route_class=_PrivateRoute,
)


class PendingReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sourceKind: Literal["curated_oauth_connector"]
    sourceId: str = Field(pattern=r"^[a-z0-9_][a-z0-9_.:-]{0,127}$")
    reviewVersion: Literal["hosted_memory_pilot.v1"]
    expectedGeneration: str = Field(pattern=r"^(0|[1-9][0-9]{0,18})$")
    acknowledgeHostedCustody: bool = Field(strict=True)
    acknowledgeSourceScope: bool = Field(strict=True)

    @model_validator(mode="after")
    def require_explicit_review(self) -> PendingReviewRequest:
        if (
            not self.acknowledgeHostedCustody
            or not self.acknowledgeSourceScope
            or int(self.expectedGeneration) > 2**63 - 1
        ):
            raise ValueError("hosted pilot review requires both acknowledgements")
        return self


class PilotReviewState(BaseModel):
    status: Literal["off", "pending", "expired", "revoked"]
    grantId: str | None
    generation: str
    sourceKind: Literal["curated_oauth_connector"] | None
    sourceId: str | None
    reviewVersion: Literal["hosted_memory_pilot.v1"] | None
    reviewedAt: str | None
    expiresAt: str | None
    revokedAt: str | None
    captureEnabled: Literal[False]
    workerPaired: Literal[False]


_DECIMAL = r"^(0|[1-9][0-9]{0,18})$"
_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
_BASE64URL = r"^[A-Za-z0-9_-]+$"


class OwnerEnvelopeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    grantId: str = Field(pattern=_UUID)
    expectedGeneration: str = Field(pattern=_DECIMAL)
    sourceKind: Literal["curated_oauth_connector"]
    sourceId: str = Field(pattern=r"^[a-z0-9_][a-z0-9_.:-]{0,127}$")
    scope: Literal["connector_status.v1"]
    envelopeVersion: Literal["aes256gcm.pilot.v1"]
    expectedRevision: str = Field(pattern=_DECIMAL)
    keyId: str = Field(pattern=_UUID)
    nonceBase64Url: str = Field(pattern=_BASE64URL, max_length=32)
    ciphertextBase64Url: str = Field(pattern=_BASE64URL, max_length=22_000)
    aadSha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def bounded_numbers(self) -> OwnerEnvelopeRequest:
        if (
            int(self.expectedGeneration) < 1
            or int(self.expectedGeneration) > 2**63 - 1
            or int(self.expectedRevision) > 2**63 - 2
        ):
            raise ValueError("invalid envelope generation or revision")
        return self


class OwnerEnvelopeReadback(BaseModel):
    grantId: str
    generation: str
    sourceKind: Literal["curated_oauth_connector"]
    sourceId: str
    scope: Literal["connector_status.v1"]
    envelopeVersion: Literal["aes256gcm.pilot.v1"]
    keyId: str
    revision: str
    nonceBase64Url: str
    ciphertextBase64Url: str
    ciphertextSha256: str
    aadSha256: str
    captureEnabled: Literal[False]
    workerPaired: Literal[False]


async def _run(
    operation: str,
    user_id: str,
    *,
    expected_generation: int | None = None,
    source_id: str | None = None,
) -> dict[str, Any]:
    try:
        service = HostedMemoryPilotService()
        if operation == "read":
            state = await service.current(user_id=user_id)
        elif operation == "pending":
            if expected_generation is None or source_id is None:
                raise ValueError("review generation and source required")
            state = await service.request_pending(
                user_id=user_id, expected_generation=expected_generation, source_id=source_id
            )
        elif operation == "revoke":
            state = await service.revoke(user_id=user_id)
        else:
            raise ValueError("unsupported pilot operation")
        if state.get("captureEnabled") is not False or state.get("workerPaired") is not False:
            raise ValueError("pilot state cannot authorize capture")
        return cast(dict[str, Any], state)
    except HostedMemoryPilotConflict:
        raise _error(409, "PILOT_REVIEW_CHANGED", "Reload the current review state.") from None
    except (HostedMemoryPilotUnavailable, ValueError) as exc:
        logger.warning(
            "hosted_memory_pilot.unavailable operation=%s type=%s", operation, type(exc).__name__
        )
        raise _error(
            503, "PILOT_REVIEW_UNAVAILABLE", "Hosted memory review is unavailable."
        ) from None
    except Exception as exc:
        logger.error(
            "hosted_memory_pilot.unexpected operation=%s type=%s", operation, type(exc).__name__
        )
        raise _error(
            503, "PILOT_REVIEW_UNAVAILABLE", "Hosted memory review is unavailable."
        ) from None


@router.get("", response_model=PilotReviewState)
async def get_pilot_review(
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    return await _run("read", token_data["user_id"])


@router.post("", response_model=PilotReviewState)
async def request_pilot_review(
    body: PendingReviewRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    return await _run(
        "pending",
        token_data["user_id"],
        expected_generation=int(body.expectedGeneration),
        source_id=body.sourceId,
    )


@router.delete("", response_model=PilotReviewState)
async def revoke_pilot_review(
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    return await _run("revoke", token_data["user_id"])


@router.put("/envelope", response_model=OwnerEnvelopeReadback)
async def stage_pilot_envelope(
    body: OwnerEnvelopeRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        return cast(
            dict[str, Any],
            await HostedMemoryEnvelopeService().stage_owner_envelope(
                user_id=token_data["user_id"],
                grant_id=body.grantId,
                generation=int(body.expectedGeneration),
                source_id=body.sourceId,
                expected_revision=int(body.expectedRevision),
                key_id=body.keyId,
                nonce=decode_base64url(body.nonceBase64Url),
                ciphertext=decode_base64url(body.ciphertextBase64Url),
                aad_sha256=body.aadSha256,
            ),
        )
    except ValueError:
        raise _error(422, "INVALID_ENVELOPE", "Review the encrypted source envelope.") from None
    except HostedMemoryEnvelopeConflict:
        raise _error(409, "ENVELOPE_CHANGED", "Reload the current source review.") from None
    except HostedMemoryEnvelopeUnavailable:
        raise _error(
            503, "ENVELOPE_UNAVAILABLE", "Encrypted source storage is unavailable."
        ) from None
    except Exception as exc:
        logger.error("hosted_memory_envelope.stage_unexpected type=%s", type(exc).__name__)
        raise _error(
            503, "ENVELOPE_UNAVAILABLE", "Encrypted source storage is unavailable."
        ) from None


@router.get("/envelope", response_model=OwnerEnvelopeReadback)
async def read_pilot_envelope(
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        state = await HostedMemoryEnvelopeService().owner_readback(user_id=token_data["user_id"])
        if state is None:
            raise _error(404, "ENVELOPE_NOT_FOUND", "No current encrypted source envelope.")
        return cast(dict[str, Any], state)
    except HostedMemoryEnvelopeUnavailable:
        raise _error(
            503, "ENVELOPE_UNAVAILABLE", "Encrypted source storage is unavailable."
        ) from None
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("hosted_memory_envelope.read_unexpected type=%s", type(exc).__name__)
        raise _error(
            503, "ENVELOPE_UNAVAILABLE", "Encrypted source storage is unavailable."
        ) from None


__all__ = ["router"]
