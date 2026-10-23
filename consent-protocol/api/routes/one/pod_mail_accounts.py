"""Owner-only mailbox inventory and individual disconnect, over sealed custody."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query

from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services.pod_mail_accounts import ACCOUNT_ID, public_account_id
from hushh_mcp.services.pod_session_authority import SCOPE_POD_CONFIG, SCOPE_POD_STATUS

router = APIRouter(prefix="/connectors/gmail/accounts", tags=["personal-agent"])


async def account_inventory(*, consent_token: str, verifier=None, session=None, log=None) -> dict:
    await admit_owner_local(
        consent_token, verifier=verifier, session=session, scope=SCOPE_POD_STATUS
    )
    try:
        accounts = store.mail_account_credentials()
    except store.ConnectorCredentialsUnavailable:
        await store.load_connector_credentials(log)
        try:
            accounts = store.mail_account_credentials()
        except store.ConnectorCredentialsUnavailable:
            raise HTTPException(503, detail={"code": "CONNECTOR_CREDENTIALS_UNAVAILABLE"}) from None
    return {
        "accounts": [
            {
                "accountId": public_account_id(item),
                "credentialId": item.credential_id,
                "email": item.account_email or None,
                "provider": "google",
                "status": item.status,
                "isDefault": not bool(item.account_id),
                **store.connector_permissions(item),
            }
            for item in accounts
        ]
    }


async def disconnect_account(
    account_id: str,
    *,
    credential_id: str,
    consent_token: str,
    verifier=None,
    session=None,
    log=None,
    post=None,
) -> dict:
    from api.routes.one.pod_connectors import _hushh_id, _log, _no_store
    from hushh_mcp.services import pod_connector_connect as connect
    from hushh_mcp.services.pod_commit_log import PodLogConflict, PodLogFenced

    await admit_owner_local(
        consent_token, verifier=verifier, session=session, scope=SCOPE_POD_CONFIG
    )
    if not ACCOUNT_ID.fullmatch(account_id):
        raise HTTPException(404, detail="not found")
    held = store.active_mail_account(account_id)
    if held is None:
        return {"accountId": account_id, "status": "absent", "providerRevoked": None}
    if held.credential_id != credential_id:
        raise HTTPException(409, detail={"code": "MAIL_ACCOUNT_CHANGED"})
    log = log if log is not None else _log()
    if log is None:
        raise _no_store()
    try:
        revoked = await connect.disconnect(
            log,
            hushh_id=_hushh_id(),
            connector_id="gmail",
            account_id=held.account_id,
            expected_credential_id=held.credential_id,
            post=post,
        )
    except (PodLogConflict, PodLogFenced):
        raise HTTPException(409, detail={"code": "CONNECTOR_NOT_RECORDED"}) from None
    current = store.active_mail_account(account_id)
    return {
        "accountId": account_id,
        "status": current.status if current else "absent",
        "providerRevoked": revoked,
    }


@router.get("")
async def list_route(
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    door = await owner_local_door(
        x_consent_token, authorization, scope=SCOPE_POD_STATUS, held=False
    )
    return await account_inventory(**door)


@router.delete("/{account_id}")
async def disconnect_route(
    account_id: str,
    credential_id: str = Query(
        pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
    ),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_CONFIG, held=True)
    return await disconnect_account(account_id, credential_id=credential_id, **door)
