"""Requester-only Drive request endpoints.

GET  /api/connectors/google_drive/sharing/recipient-identity
POST /api/connectors/google_drive/sharing/requests/{request_id}/review-request

Requester-scoped, vault-owner authorized and never cached. They return only the
caller's own data and never owner coverage, fees or provider identifiers.
"""

from __future__ import annotations

from fastapi import APIRouter

from api.routes.drive_sharing import PrivateSharingRoute

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)
