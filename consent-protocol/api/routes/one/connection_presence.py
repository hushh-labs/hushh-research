"""Owner-scoped read and partial update of Connect directory presence (migration 433)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from api.routes.one.connections import _handle
from hushh_mcp.services import connection_presence
from hushh_mcp.services.connections_service import ConnectionsService

router = APIRouter(prefix="/api/one", tags=["Connections"])


class DirectoryPresenceBody(BaseModel):
    """Partial update: only the fields present in the request change."""

    listed: bool | None = None
    # Validated and trimmed by the service; the generous bound here only stops
    # a pathological body from reaching it.
    role_label: str | None = Field(None, max_length=1000)

    def sent_fields(self) -> set[str]:
        sent: object = getattr(self, "model_fields_set", None)
        if sent is None:
            sent = getattr(self, "__fields_set__", set())
        return {str(name) for name in (sent if isinstance(sent, (set, frozenset)) else ())}


def _execute_one():
    return ConnectionsService()._execute_one


@router.get("/connections/directory-presence")
def get_directory_presence(
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """The caller's own people-search presence and what they do."""
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return connection_presence.get_directory_presence(_execute_one(), user_id=firebase_uid)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.put("/connections/directory-presence")
def update_directory_presence(
    body: DirectoryPresenceBody,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return connection_presence.update_directory_presence(
            _execute_one(),
            user_id=firebase_uid,
            fields=body.sent_fields(),
            listed=body.listed,
            role_label=body.role_label,
        )
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc
