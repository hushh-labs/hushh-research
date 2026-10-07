"""Connect, disconnect and revoke a connector login, entirely inside the owner's agent.

``connect`` takes an opened envelope (``pod_connector_credential_seal``) and, for a
Google sign-in, redeems the code with Google itself, checks who signed in and what
they granted, and records the login (``pod_connector_credentials``). A redemption the
agent cannot keep (no refresh token, an unverified account, a missing scope, or a
record that lost a race) triggers revocation only when no live sibling shares its
grant. An unconfirmed cleanup is reported separately. ``disconnect`` clears local
custody before awaiting revocation. ``revoke_fenced`` inventories the verified fenced
log for erasure, without appending or relying on the process's active copy.

Google revokes a *grant*, not one token: revoking any refresh token removes the app
from the person's third-party access and kills every token issued to every client
in that Google project for that account. Configured native clients in one project
therefore share one grant per account. A token is revoked only when no other live
login shares that project and account; unknown projects are treated conservatively.
After revocation, provider validation marks an exact generation ``needs_reauth``
only when Google refuses it as ``invalid_grant``. A fresh authorization survives.

Every refusal is ``ConnectRefused(code)``. No code, token, verifier or secret reaches
a log line or a response.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import replace
from typing import Any, Iterable, Mapping, Optional

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_google_oauth as google
from hushh_mcp.services.pod_connector_credential_seal import (
    GOOGLE_OWNER_CLIENT,
    KIND_AUTHORIZATION_CODE,
    KIND_MCP_OAUTH,
    PROVIDER_GOOGLE,
    REFRESH_TOKEN_MISSING,
    OpenedConnectorCredential,
    allowed_scopes,
)
from hushh_mcp.services.pod_connector_tokens import (
    NEEDS_REAUTH,
    ConnectorTokenError,
    google_token_source,
    required_scopes,
)

logger = logging.getLogger(__name__)

CODE_REFUSED = "CODE_REFUSED"
PROVIDER_UNREACHABLE = "PROVIDER_UNREACHABLE"
ACCOUNT_UNVERIFIED = "ACCOUNT_UNVERIFIED"
SCOPE_NOT_GRANTED = "SCOPE_NOT_GRANTED"
OWNER_CLIENT_MISSING = "OWNER_CLIENT_MISSING"


class ConnectRefused(ValueError):
    """The login was not kept. ``code`` is the whole explanation."""

    def __init__(self, code: str, *, provider_revoked: Optional[bool] = None) -> None:
        super().__init__(code)
        self.code = code
        self.provider_revoked = provider_revoked


def _owner_client_secret(opened: OpenedConnectorCredential, held: dict) -> Optional[str]:
    if opened.client_profile != "owner_client":
        return None
    owner = held.get(GOOGLE_OWNER_CLIENT)
    if owner is None or owner.client_id != opened.client_id or not owner.client_secret:
        raise ConnectRefused(OWNER_CLIENT_MISSING)
    return str(owner.client_secret)


def _live_on_grant(
    held: Mapping[str, store.ConnectorCredential],
    client_id: str,
    subject: Optional[str],
    *,
    excluding: Iterable[str] = (),
) -> list[store.ConnectorCredential]:
    """Live logins on (project, account), conservatively including unknown projects."""
    skip = set(excluding)
    project = google.oauth_project_id(client_id)
    return [
        credential
        for name, credential in held.items()
        if name not in skip
        and credential.provider == PROVIDER_GOOGLE
        and credential.status == store.STATUS_CONNECTED
        and credential.refresh_token
        and (
            credential.client_id == client_id
            or project is None
            or google.oauth_project_id(credential.client_id) in {None, project}
        )
        and (subject is None or credential.account_subject == subject)
    ]


async def _mark_grant_lost(
    log: Any,
    *,
    hushh_id: str,
    client_id: str,
    subject: Optional[str],
    excluding: Iterable[str],
    post: Any = None,
) -> None:
    """After revocation, verify exact siblings; a fresh grant may already exist."""
    try:
        held, _floors = await store.read_connector_credentials(log, hushh_id=hushh_id)
    except Exception as exc:  # noqa: BLE001 - a revocation already happened; never mask it
        logger.warning("pod_connector_connect.sibling_read_failed reason=%s", type(exc).__name__)
        return
    siblings = _live_on_grant(held, client_id, subject, excluding=excluding)
    source = google_token_source()
    for sibling in siblings:
        source.forget(sibling.connector_id)
    for sibling in siblings:
        try:
            await source.validate_current(sibling, post=post)
        except ConnectorTokenError as exc:
            if exc.code != NEEDS_REAUTH:
                logger.warning("pod_connector_connect.sibling_validation_unavailable")
        except Exception as exc:  # noqa: BLE001 - its next refresh flips it anyway
            logger.warning(
                "pod_connector_connect.sibling_mark_failed reason=%s", type(exc).__name__
            )


async def _revoke_unless_shared(
    log: Any,
    *,
    hushh_id: str,
    token: Optional[str],
    client_id: str,
    subject: Optional[str],
    excluding: Iterable[str] = (),
    post: Any = None,
) -> Optional[bool]:
    """Revoke ``token``'s grant at Google unless a live login here still uses it.

    None for a known shared grant or no token; False when sibling custody could not
    be checked or the provider did not confirm. A working login is never killed on
    a guess, and an unavailable check is never reported as known sharing.
    """
    if not token:
        return None
    excluded = tuple(excluding)
    try:
        held, _floors = await store.read_connector_credentials(log, hushh_id=hushh_id)
    except Exception as exc:  # noqa: BLE001 - unknown siblings: do not revoke on a guess
        logger.warning("pod_connector_connect.grant_check_failed reason=%s", type(exc).__name__)
        return False
    if _live_on_grant(held, client_id, subject, excluding=excluded):
        logger.info("pod_connector_connect.revoke_skipped_shared_grant")
        return None
    revoked = await google.revoke(token, post=post)
    if not revoked:
        logger.warning("pod_connector_connect.revoke_unconfirmed")
        return False
    await _mark_grant_lost(
        log, hushh_id=hushh_id, client_id=client_id, subject=subject, excluding=(), post=post
    )
    return True


async def _redeem(
    log: Any,
    *,
    hushh_id: str,
    opened: OpenedConnectorCredential,
    client_secret: Optional[str],
    post: Any,
) -> tuple[str, tuple[str, ...], str]:
    """(account subject, granted scopes kept, refresh token) or a refusal, cleaned up."""
    client_id = str(opened.client_id)
    try:
        grant = await google.redeem_code(
            client_id=client_id,
            code=str(opened.code),
            code_verifier=str(opened.code_verifier),
            redirect_uri=str(opened.redirect_uri),
            client_secret=client_secret,
            post=post,
        )
    except google.GoogleOAuthError as exc:
        unreachable = exc.code == google.PROVIDER_UNREACHABLE
        raise ConnectRefused(PROVIDER_UNREACHABLE if unreachable else CODE_REFUSED) from None
    keep = grant.refresh_token or grant.access_token
    subject: Optional[str] = None
    try:
        subject = google.id_token_subject(grant.id_token, client_id=client_id)
        if not grant.refresh_token:
            raise ConnectRefused(REFRESH_TOKEN_MISSING)
        granted = tuple(s for s in grant.scopes if s in allowed_scopes(opened.connector_id))
        required_scopes(opened.connector_id, "read", granted)
    except (google.GoogleOAuthError, ConnectorTokenError, ConnectRefused) as exc:
        # An unverified account (subject None) may be any account on this client.
        revoked = await _revoke_unless_shared(
            log, hushh_id=hushh_id, token=keep, client_id=client_id, subject=subject, post=post
        )
        if isinstance(exc, google.GoogleOAuthError):
            raise ConnectRefused(ACCOUNT_UNVERIFIED, provider_revoked=revoked) from None
        if isinstance(exc, ConnectorTokenError):
            raise ConnectRefused(SCOPE_NOT_GRANTED, provider_revoked=revoked) from None
        raise ConnectRefused(exc.code, provider_revoked=revoked) from None
    return subject, granted, grant.refresh_token


async def _connect_google_code(
    log: Any, *, hushh_id: str, opened: OpenedConnectorCredential, post: Any
) -> store.ConnectorCredential:
    held, _floors = await store.read_connector_credentials(log, hushh_id=hushh_id)
    previous = held.get(opened.connector_id)
    secret = _owner_client_secret(opened, held)
    if opened.client_profile != "owner_client":
        try:
            google.validate_native_client(
                str(opened.client_profile), str(opened.client_id), str(opened.redirect_uri)
            )
        except google.GoogleOAuthError:
            raise ConnectRefused(google.CLIENT_PROFILE_UNSUPPORTED) from None
    subject, granted, refresh_token = await _redeem(
        log, hushh_id=hushh_id, opened=opened, client_secret=secret, post=post
    )
    client_id = str(opened.client_id)
    try:
        recorded = await store.record_connector_credential(
            log,
            hushh_id=hushh_id,
            opened=opened,
            account_subject=subject,
            granted_scopes=granted,
            refresh_token=refresh_token,
        )
    except BaseException as exc:
        revoked = await _revoke_unless_shared(
            log,
            hushh_id=hushh_id,
            token=refresh_token,
            client_id=client_id,
            subject=subject,
            post=post,
        )
        # Preserve the store exception's type/status while exposing only the
        # bounded provider outcome to the route's cleanup receipt.
        exc.__dict__["provider_revoked"] = revoked
        raise
    google_token_source().forget(opened.connector_id)
    await _retire_replaced(log, hushh_id=hushh_id, previous=previous, kept=refresh_token, post=post)
    return recorded


async def _retire_replaced(
    log: Any,
    *,
    hushh_id: str,
    previous: Optional[store.ConnectorCredential],
    kept: str,
    post: Any,
) -> None:
    """A replaced login's grant is revoked only when nothing here still uses it."""
    if previous is None or previous.provider != PROVIDER_GOOGLE:
        return
    if not previous.refresh_token or previous.refresh_token == kept:
        return
    await _revoke_unless_shared(
        log,
        hushh_id=hushh_id,
        token=previous.refresh_token,
        client_id=previous.client_id,
        subject=previous.account_subject,
        post=post,
    )


async def connect(
    log: Any, *, hushh_id: str, opened: OpenedConnectorCredential, post: Any = None
) -> store.ConnectorCredential:
    """Redeem (when it is a code), check, and record. Raises ``ConnectRefused``."""
    if opened.kind == KIND_AUTHORIZATION_CODE:
        return await _connect_google_code(log, hushh_id=hushh_id, opened=opened, post=post)
    if opened.kind == KIND_MCP_OAUTH:
        mcp = dict(opened.mcp or {})
        refresh_token = str(mcp.pop("refreshToken", "") or "")
        if not refresh_token:
            raise ConnectRefused(REFRESH_TOKEN_MISSING)
        return await store.record_connector_credential(
            log,
            hushh_id=hushh_id,
            opened=replace(opened, mcp=mcp),
            account_subject=str(mcp.get("issuer") or ""),
            granted_scopes=opened.scopes,
            refresh_token=refresh_token,
        )
    # ``owner_client``: the owner's own Google client, kept for their sign-ins.
    return await store.record_connector_credential(
        log,
        hushh_id=hushh_id,
        opened=opened,
        account_subject="",
        granted_scopes=(),
        refresh_token="",
    )


async def disconnect(
    log: Any, *, hushh_id: str, connector_id: str, post: Any = None
) -> Optional[bool]:
    """Clear local custody, then revoke at Google when no connector shares the grant.

    True or False when this was the grant's last login here (whether Google confirmed);
    None when the grant is still used by another connector (only cleared here) or the
    login is not a Google one. The agent stops using the login even when Google cannot
    be reached, and says so, so the app can tell the person to remove access in their
    Google account.
    """
    # Stop local use durably before awaiting a provider. Clearing after the revoke
    # could delete a new login that landed while Google was answering.
    credential = await store.clear_connector_credential(
        log, hushh_id=hushh_id, connector_id=connector_id
    )
    google_token_source().forget(connector_id)
    revoked: Optional[bool] = None
    if credential is not None and credential.provider == PROVIDER_GOOGLE:
        revoked = await _revoke_unless_shared(
            log,
            hushh_id=hushh_id,
            token=credential.refresh_token,
            client_id=credential.client_id,
            subject=credential.account_subject,
            post=post,
        )
    return revoked


REVOKE_UNAVAILABLE = "unavailable"
_MAX_ERASURE_CONNECTORS = 128
_REVOCATION_BUDGET_S = 15.0


async def revoke_fenced(
    log: Any, *, owner_id: str, attempt_id: str, hushh_id: str, post: Any = None
) -> dict[str, Any]:
    """Inventory and revoke behind the authenticated fence, without any log writes.

    The caller records these provider receipts before destroying the wrapped key.
    Local erasure and external revocation are independent outcomes. No credential
    or account identifier leaves this function; failures are explicit counts.
    """
    held: dict[str, store.ConnectorCredential] = {}
    seen: set[str] = set()

    def collect(record: dict[str, Any]) -> None:
        if record.get("kind") not in {store.RECORD_KIND, store.CLEARED_KIND}:
            return
        payload = record.get("payload")
        if not isinstance(payload, Mapping) or payload.get("hushh_id") != hushh_id:
            return
        name = payload.get("connectorId")
        if not isinstance(name, str) or not name:
            raise ValueError("connector inventory has an invalid id")
        if name in seen:
            return  # reverse traversal: the first record is the current state
        seen.add(name)
        if len(seen) > _MAX_ERASURE_CONNECTORS:
            raise ValueError("connector inventory exceeds its bound")
        if record["kind"] == store.CLEARED_KIND:
            return
        credential = store._from_payload(payload)
        if credential is None:
            raise ValueError("connector inventory has an invalid record")
        held[name] = credential

    try:
        if not hushh_id or owner_id != hushh_id:
            raise ValueError("connector owner mismatch")
        await log.fold_fenced(owner_id=owner_id, attempt_id=attempt_id, visit_reverse=collect)
    except Exception as exc:  # noqa: BLE001 - erasure receipts never expose sealed history
        logger.warning(
            "pod_connector_connect.erasure_inventory_unavailable reason=%s", type(exc).__name__
        )
        return {"revoked": 0, "unrevoked": 0, "unavailable": 1, "receipts": []}
    grants: dict[tuple[str, str, str], list[str]] = {}
    for credential in held.values():
        google_token_source().forget(credential.connector_id)
        if not credential.refresh_token:
            continue
        project = google.oauth_project_id(credential.client_id) or credential.client_id
        grants.setdefault((credential.provider, project, credential.account_subject), []).append(
            credential.refresh_token
        )
    semaphore = asyncio.Semaphore(4)
    deadline = time.monotonic() + _REVOCATION_BUDGET_S
    results = await asyncio.gather(
        *(
            _revoke_bounded(tokens, post, deadline, semaphore)
            if key[0] == PROVIDER_GOOGLE
            else _unconfirmed()
            for key, tokens in grants.items()
        )
    )
    receipts = [
        {
            "provider": "google" if key[0] == PROVIDER_GOOGLE else "mcp",
            "grantDigest": hashlib.sha256("\0".join(key).encode()).hexdigest(),
            "outcome": "confirmed" if confirmed else "unconfirmed",
        }
        for key, confirmed in zip(grants, results, strict=True)
    ]
    revoked = sum(results)
    return {
        "revoked": revoked,
        "unrevoked": len(results) - revoked,
        "unavailable": 0,
        "receipts": receipts,
    }


async def _unconfirmed() -> bool:
    return False


async def _revoke_bounded(
    tokens: list[str], post: Any, deadline: float, semaphore: asyncio.Semaphore
) -> bool:
    """Provider outages consume at most one shared budget before local key erasure."""
    async with semaphore:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        try:
            return await asyncio.wait_for(_revoke_first(tokens, post), timeout=remaining)
        except TimeoutError:
            return False


async def revoke_all(post: Any = None) -> dict[str, int]:
    """Erasure's pre-step: revoke every Google grant this agent holds, once per grant.

    ``{"revoked", "unrevoked", "unavailable"}``: ``unavailable`` is 1 when the logins
    could not be read at all, so the caller records that grants may still be live
    instead of reading two zeros as "nothing to revoke".
    """
    try:
        held = [store.active_connector_credential(name) for name in store.held_connector_ids()]
    except store.ConnectorCredentialsUnavailable:
        logger.warning("pod_connector_connect.revoke_all_unavailable")
        return {"revoked": 0, "unrevoked": 0, REVOKE_UNAVAILABLE: 1}
    grants: dict[tuple[str, str], list[str]] = {}
    for credential in held:
        if credential is None or credential.provider != PROVIDER_GOOGLE:
            continue
        google_token_source().forget(credential.connector_id)
        if credential.refresh_token:
            key = (
                google.oauth_project_id(credential.client_id) or credential.client_id,
                credential.account_subject,
            )
            grants.setdefault(key, []).append(credential.refresh_token)
    revoked = unrevoked = 0
    for tokens in grants.values():
        if await _revoke_first(tokens, post):
            revoked += 1
        else:
            unrevoked += 1
    return {"revoked": revoked, "unrevoked": unrevoked, REVOKE_UNAVAILABLE: 0}


async def _revoke_first(tokens: list[str], post: Any) -> bool:
    """One grant: any token revokes it, so stop at the first Google confirms."""
    for token in dict.fromkeys(tokens):
        if await google.revoke(token, post=post):
            return True
    return False


__all__ = [
    "ACCOUNT_UNVERIFIED",
    "CODE_REFUSED",
    "OWNER_CLIENT_MISSING",
    "PROVIDER_UNREACHABLE",
    "REVOKE_UNAVAILABLE",
    "SCOPE_NOT_GRANTED",
    "ConnectRefused",
    "connect",
    "disconnect",
    "revoke_all",
    "revoke_fenced",
]
