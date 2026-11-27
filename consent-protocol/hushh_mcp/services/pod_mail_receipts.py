"""Account-bound receipt ports; owner-pod custody and model, never hub tables."""

from __future__ import annotations

import hashlib
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from hushh_mcp.services.pod_connector_tokens import ConnectorTokenError, google_token_source


class PodReceiptConnection(GmailReceiptsService):
    def __init__(self, owner: str, account_id: str, credential_id: str):
        super().__init__()
        self.owner, self.account_id, self.credential_id = owner, account_id, credential_id

    @property
    def db(self):
        raise RuntimeError("Private receipts cannot use hub tables")

    def current(self):
        held = credentials.active_mail_account(self.account_id)
        if held is None or held.credential_id != self.credential_id or held.status != "connected":
            raise GmailApiError(
                "Reconnect this mailbox before scanning receipts.",
                status_code=409,
                code="GMAIL_CONNECTION_CHANGED",
            )
        return held

    async def get_read_access_token(self, *, user_id: str, force_refresh: bool = False) -> str:
        if user_id != self.owner:
            raise PermissionError("Mailbox owner mismatch")
        held = self.current()
        source = google_token_source()
        if force_refresh:
            source.forget("gmail", account_id=held.account_id)
        try:
            token = await source.access_token("gmail", "read", account_id=held.account_id)
        except ConnectorTokenError as exc:
            if exc.code in {"NOT_CONNECTED", "NEEDS_REAUTH"}:
                status, code = 409, "GMAIL_CONNECTION_CHANGED"
            elif exc.code == "SCOPE_NOT_GRANTED":
                status, code = 403, "GMAIL_READ_PERMISSION_REQUIRED"
            else:
                status, code = 503, "GMAIL_PROVIDER_UNAVAILABLE"
            raise GmailApiError(
                "Mailbox authorization is unavailable.", status_code=status, code=code
            ) from None
        self.current()
        return str(token)

    async def read_grant_binding(self, *, user_id: str):
        if user_id != self.owner:
            raise PermissionError("Mailbox owner mismatch")
        held = self.current()
        scopes = hashlib.sha256("\n".join(sorted(held.granted_scopes)).encode()).hexdigest()
        return user_id, "gmail", self.account_id, held.credential_id, scopes


def receipt_source_key() -> bytes:
    from hushh_mcp.services.pod_self_registration import pod_key_is_durable, pod_keypair

    if not pod_key_is_durable():
        raise GmailApiError(
            "Your private agent cannot preserve receipt references yet.",
            status_code=503,
            code="GMAIL_RECEIPT_STORE_UNAVAILABLE",
        )

    raw = pod_keypair().private_key.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=b"hussh/mail-receipt-source/v1"
    ).derive(raw)


def owner_receipt_model():
    from fastapi import HTTPException

    from api.routes.one.pod_todo_sources import private_workspace_model

    try:
        model = private_workspace_model()
    except HTTPException:
        model = None
    if model is None:
        raise GmailApiError(
            "Configure the private agent model.", status_code=503, code="GMAIL_OWNER_MODEL_REQUIRED"
        )
    return model


def owner_receipt_service(connection: PodReceiptConnection, require_access: Any):
    from hushh_mcp.services.gmail_live_receipts_service import GmailLiveReceiptsService
    from hushh_mcp.services.pod_ai_selection import ai_selection_revision

    revision = ai_selection_revision()
    model = owner_receipt_model()

    async def current():
        await require_access()
        connection.current()
        if ai_selection_revision() != revision:
            raise GmailApiError(
                "Your private agent model changed. Start a new scan.",
                status_code=409,
                code="OWNER_AI_SELECTION_CHANGED",
            )

    return GmailLiveReceiptsService(
        gmail=connection, source_secret=receipt_source_key(), model=model
    ), current
