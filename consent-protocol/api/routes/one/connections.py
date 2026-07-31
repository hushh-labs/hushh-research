from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

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
    message: str | None = Field(None, max_length=1000)
    requested_scope_handles: list[str] = Field(default_factory=list, max_length=25)
    offered_scope_handles: list[str] = Field(default_factory=list, max_length=25)


class AcceptConnectionRequestBody(BaseModel):
    selected_requested_scope_handles: list[str] = Field(default_factory=list, max_length=25)
    selected_offered_scope_handles: list[str] = Field(default_factory=list, max_length=25)


class LinkCircleInviteBody(BaseModel):
    peer_user_id: str


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


@router.get("/connections/{counterpart_user_id}/scope-catalog")
def connection_scope_catalog(
    counterpart_user_id: str = Path(..., min_length=1, max_length=128),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().get_scope_catalog(firebase_uid, counterpart_user_id)
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
                requested_scope_handles=body.requested_scope_handles,
                offered_scope_handles=body.offered_scope_handles,
            )
        }
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections/requests/{request_id}/scopes")
def connection_scope_proposal_history(
    request_id: str = Path(..., min_length=1, max_length=128),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().get_scope_proposal_history(firebase_uid, request_id)
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
    body: AcceptConnectionRequestBody | None = None,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {
            "result": _service().accept_request(
                firebase_uid,
                request_id,
                selected_requested_scope_handles=(
                    body.selected_requested_scope_handles if body else None
                ),
                selected_offered_scope_handles=(
                    body.selected_offered_scope_handles if body else None
                ),
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
