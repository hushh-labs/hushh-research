from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from api.middleware import require_firebase_auth
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService

router = APIRouter(prefix="/api/one", tags=["Connections"])


def _service() -> ConnectionsService:
    return ConnectionsService()


def _handle(exc: Exception) -> HTTPException:
    if isinstance(exc, ConnectionsError):
        return HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
        )
    return HTTPException(status_code=500, detail="Connections request failed.")


class CreateRequestBody(BaseModel):
    addressee_user_id: str | None = None
    query: str | None = None
    message: str | None = None
    # Optional granular data-scope request bundled with the connection request.
    # The requester publishes an on-device X25519 public key so the addressee can
    # ZK-wrap each granted scope to it (reuses the proven consent export path).
    requested_scopes: list[str] | None = None
    requester_public_key: str | None = None
    requester_key_id: str | None = None


class LinkCircleInviteBody(BaseModel):
    peer_user_id: str


class AcceptRequestBody(BaseModel):
    # Optional per-scope decision applied at accept time. Scopes the addressee
    # left OUT of `granted_scopes` (or listed in `denied_scopes`) are recorded as
    # denied; the rest are minted as pending scope requests for later resolution
    # in the consent center. Omit both to accept the connection with every
    # requested scope queued.
    granted_scopes: list[str] | None = None
    denied_scopes: list[str] | None = None


@router.get("/connections/directory")
def connections_directory(
    query: str = Query(default=""),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().search_directory(firebase_uid, query=query, page=page, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections")
def list_connections(firebase_uid: str = Depends(require_firebase_auth)):
    try:
        return {"items": _service().list_connections(firebase_uid)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections/requests")
def list_connection_requests(
    direction: str = Query(default="incoming", pattern="^(incoming|outgoing)$"),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"items": _service().list_requests(firebase_uid, direction=direction)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections/requestable-scopes")
def list_requestable_scopes(firebase_uid: str = Depends(require_firebase_auth)):
    # Global, presence-safe catalog for the Connect scope picker. Auth-gated but
    # user-agnostic: it reflects no specific user's holdings, so it cannot leak
    # whether the person being connected with has any given data.
    try:
        return _service().list_requestable_scopes()
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections/received-exports")
def list_received_exports(firebase_uid: str = Depends(require_firebase_auth)):
    # Scope exports other users sealed to THIS user's Connect requester key.
    # The payload carries only ciphertext + the X25519-wrapped export key; the
    # server never holds the plaintext, and only the addressee's on-device
    # private key can unwrap it (zero-knowledge).
    try:
        return {"items": _service().list_received_scope_exports(firebase_uid)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests")
def create_connection_request(
    body: CreateRequestBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {
            "request": _service().create_request(
                firebase_uid,
                addressee_user_id=body.addressee_user_id,
                query=body.query,
                message=body.message,
                requested_scopes=body.requested_scopes,
                requester_public_key=body.requester_public_key,
                requester_key_id=body.requester_key_id,
            )
        }
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/link-circle-invite")
def link_circle_invite(
    body: LinkCircleInviteBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {
            "result": _service().link_circle_invite(firebase_uid, peer_user_id=body.peer_user_id)
        }
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests/{request_id}/accept")
def accept_connection_request(
    request_id: str = Path(...),
    body: AcceptRequestBody | None = None,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {
            "result": _service().accept_request(
                firebase_uid,
                request_id,
                granted_scopes=(body.granted_scopes if body else None),
                denied_scopes=(body.denied_scopes if body else None),
            )
        }
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests/{request_id}/reject")
def reject_connection_request(
    request_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().reject_request(firebase_uid, request_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests/{request_id}/cancel")
def cancel_connection_request(
    request_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().cancel_request(firebase_uid, request_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.delete("/connections/{connection_id}")
def remove_connection(
    connection_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().remove_connection(firebase_uid, connection_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc
