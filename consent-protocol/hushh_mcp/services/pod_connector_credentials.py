"""The owner's connector logins, held by their own agent and nowhere else.

The agent redeems a sealed sign-in (``pod_connector_credential_seal``) with the
provider itself and appends record kind ``pod_connector_credential_v1`` to its own
commit log, the same log ``pod_memory_service._resolve_log`` returns, sealed under the
person's own KMS or Key Vault key. The hub never holds the refresh token; access
tokens are never written anywhere (``pod_connector_tokens`` keeps them in memory).

Reading is "the newest record per connector for this owner", exactly as
``pod_ai_selection`` reads its record. ``pod_connector_credential_cleared_v1`` removes
a connector and carries the newest ``issuedAtMs`` forward, so an old envelope replayed
after a disconnect is still a rollback. Each credential has a ``generation``: a
refresh-token rotation or a ``needs_reauth`` mark appends the next generation, and
every write is a compare-and-set against the log head it read.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Optional

from hushh_mcp.services.pod_connector_credential_seal import (
    GOOGLE_CONNECTORS,
    STALE_CREDENTIAL,
    ConnectorCredentialRefused,
    OpenedConnectorCredential,
)

logger = logging.getLogger(__name__)

RECORD_KIND = "pod_connector_credential_v1"
CLEARED_KIND = "pod_connector_credential_cleared_v1"
RECORD_VERSION = 1
STATUS_CONNECTED = "connected"
STATUS_NEEDS_REAUTH = "needs_reauth"
STATUS_ABSENT = "absent"
_APPEND_ATTEMPTS = 3


class ConnectorCredentialsUnavailable(RuntimeError):
    """This pod could not read its owner's connector logins."""


class ConnectorStoreMissing(RuntimeError):
    """This pod has no durable store, so it holds no connector login."""


@dataclass(frozen=True)
class ConnectorCredential:
    """One connector's login. Secrets never appear in a repr."""

    credential_id: str
    connector_id: str
    provider: str
    account_subject: str
    granted_scopes: tuple[str, ...]
    client_profile: str
    client_id: str
    generation: int
    status: str
    connected_at_ms: int
    issued_at_ms: int
    refresh_token: str = field(default="", repr=False)
    client_secret: Optional[str] = field(default=None, repr=False)
    mcp: Optional[dict[str, Any]] = field(default=None, repr=False)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _from_payload(payload: Mapping[str, Any]) -> Optional[ConnectorCredential]:
    """A stored record as a credential; a malformed one is ignored, never half-used."""
    try:
        status = str(payload["status"])
        if status not in {STATUS_CONNECTED, STATUS_NEEDS_REAUTH}:
            return None
        return ConnectorCredential(
            credential_id=str(payload["credentialId"]),
            connector_id=str(payload["connectorId"]),
            provider=str(payload["provider"]),
            account_subject=str(payload.get("accountSubject") or ""),
            granted_scopes=tuple(str(s) for s in payload.get("grantedScopes") or ()),
            client_profile=str(payload.get("clientProfile") or ""),
            client_id=str(payload.get("clientId") or ""),
            generation=int(payload["generation"]),
            status=status,
            connected_at_ms=int(payload["connectedAtMs"]),
            issued_at_ms=int(payload["issuedAtMs"]),
            refresh_token=str(payload.get("refreshToken") or ""),
            client_secret=payload.get("clientSecret") or None,
            mcp=dict(payload["mcp"]) if isinstance(payload.get("mcp"), Mapping) else None,
        )
    except (KeyError, TypeError, ValueError):
        logger.warning("pod_connector_credentials.stored_record_ignored")
        return None


def credentials_from_records(
    records: Any, *, hushh_id: str
) -> tuple[dict[str, ConnectorCredential], dict[str, int]]:
    """(newest credential per connector, newest ``issuedAtMs`` per connector)."""
    current: dict[str, ConnectorCredential] = {}
    floors: dict[str, int] = {}
    for record in records or []:
        kind = str((record or {}).get("kind") or "")
        if kind not in {RECORD_KIND, CLEARED_KIND}:
            continue
        payload = (record or {}).get("payload") or {}
        if not isinstance(payload, Mapping) or str(payload.get("hushh_id") or "") != hushh_id:
            continue
        connector = str(payload.get("connectorId") or "")
        issued = payload.get("issuedAtMs")
        if type(issued) is int:
            floors[connector] = max(floors.get(connector, 0), issued)
        credential = _from_payload(payload) if kind == RECORD_KIND else None
        if credential is None:
            current.pop(connector, None)
        else:
            current[connector] = credential
    return current, floors


async def _snapshot(log: Any, *, hushh_id: str) -> tuple[dict, dict, int]:
    records = await log.replay()
    current, floors = credentials_from_records(records, hushh_id=hushh_id)
    return current, floors, int(records[-1]["seq"]) if records else 0


async def read_connector_credentials(
    log: Any, *, hushh_id: str
) -> tuple[dict[str, ConnectorCredential], dict[str, int]]:
    if log is None:
        return {}, {}
    return credentials_from_records(await log.replay(), hushh_id=hushh_id)


Build = Callable[[dict, dict], tuple[Optional[str], Optional[dict], Any]]


async def _append_against_snapshot(log: Any, *, hushh_id: str, build: Build) -> Any:
    """Append ``build(current, floors)`` only onto the head it was computed from."""
    from hushh_mcp.services.pod_commit_log import PodLogConflict  # noqa: PLC0415

    if log is None:
        raise ConnectorStoreMissing("this pod has no durable store for connector logins")
    for _ in range(_APPEND_ATTEMPTS):
        current, floors, last_seq = await _snapshot(log, hushh_id=hushh_id)
        kind, payload, result = build(current, floors)
        if kind is None or payload is None:
            return result
        try:
            await log.append(kind, payload, expected_seq=last_seq)
        except PodLogConflict:
            continue
        _refresh_active(connector=str(payload["connectorId"]), credential=result)
        return result
    raise PodLogConflict("the connector login could not be recorded against a stable head")


def _payload(hushh_id: str, credential: ConnectorCredential) -> dict[str, Any]:
    return {
        "hushh_id": hushh_id,
        "version": RECORD_VERSION,
        "credentialId": credential.credential_id,
        "connectorId": credential.connector_id,
        "provider": credential.provider,
        "accountSubject": credential.account_subject,
        "grantedScopes": list(credential.granted_scopes),
        "refreshToken": credential.refresh_token,
        "clientProfile": credential.client_profile,
        "clientId": credential.client_id,
        "clientSecret": credential.client_secret,
        "mcp": credential.mcp,
        "generation": credential.generation,
        "status": credential.status,
        "connectedAtMs": credential.connected_at_ms,
        "issuedAtMs": credential.issued_at_ms,
    }


async def record_connector_credential(
    log: Any,
    *,
    hushh_id: str,
    opened: OpenedConnectorCredential,
    account_subject: str,
    granted_scopes: tuple[str, ...],
    refresh_token: str,
    now_ms: Optional[int] = None,
) -> ConnectorCredential:
    """Make ``opened`` this connector's login. Refuses one that is not strictly newer."""

    def build(current: dict, floors: dict) -> tuple[str, dict, ConnectorCredential]:
        if opened.issued_at_ms <= floors.get(opened.connector_id, 0):
            raise ConnectorCredentialRefused(STALE_CREDENTIAL)
        previous = current.get(opened.connector_id)
        credential = ConnectorCredential(
            credential_id=opened.credential_id,
            connector_id=opened.connector_id,
            provider=opened.provider,
            account_subject=account_subject,
            granted_scopes=tuple(granted_scopes),
            client_profile=opened.client_profile or "",
            client_id=opened.client_id or "",
            generation=(previous.generation + 1) if previous else 1,
            status=STATUS_CONNECTED,
            connected_at_ms=now_ms if now_ms is not None else _now_ms(),
            issued_at_ms=opened.issued_at_ms,
            refresh_token=refresh_token,
            client_secret=opened.client_secret,
            mcp=opened.mcp,
        )
        return RECORD_KIND, _payload(hushh_id, credential), credential

    recorded: ConnectorCredential = await _append_against_snapshot(
        log, hushh_id=hushh_id, build=build
    )
    return recorded


async def advance_credential(
    log: Any,
    *,
    hushh_id: str,
    connector_id: str,
    expected_generation: int,
    expected_credential_id: Optional[str] = None,
    refresh_token: Optional[str] = None,
    needs_reauth: bool = False,
) -> Optional[ConnectorCredential]:
    """Rotate the refresh token or mark ``needs_reauth``, as the next generation.

    Only from ``expected_generation``: when another write already moved the
    credential on, nothing is written and the newer credential is returned.
    """

    def build(current: dict, _floors: dict) -> tuple[Optional[str], Optional[dict], Any]:
        held: Optional[ConnectorCredential] = current.get(connector_id)
        if (
            held is None
            or held.generation != expected_generation
            or (expected_credential_id is not None and held.credential_id != expected_credential_id)
        ):
            return None, None, held
        changes: dict[str, Any] = {"generation": held.generation + 1}
        if needs_reauth:
            changes.update(status=STATUS_NEEDS_REAUTH, refresh_token="")
        elif refresh_token:
            changes["refresh_token"] = refresh_token
        nxt = replace(held, **changes)
        return RECORD_KIND, _payload(hushh_id, nxt), nxt

    advanced: Optional[ConnectorCredential] = await _append_against_snapshot(
        log, hushh_id=hushh_id, build=build
    )
    return advanced


async def clear_connector_credential(
    log: Any,
    *,
    hushh_id: str,
    connector_id: str,
    reason: str = "owner",
    expected_credential_id: Optional[str] = None,
) -> Optional[ConnectorCredential]:
    """Remove a connector; idempotent. Returns what was held, for revocation."""

    removed: list[ConnectorCredential] = []

    def build(current: dict, floors: dict) -> tuple[Optional[str], Optional[dict], Any]:
        removed.clear()
        held = current.get(connector_id)
        if held is None or (
            expected_credential_id is not None and held.credential_id != expected_credential_id
        ):
            return None, None, None
        removed.append(held)
        return (
            CLEARED_KIND,
            {
                "hushh_id": hushh_id,
                "version": RECORD_VERSION,
                "connectorId": connector_id,
                "credentialId": held.credential_id,
                "generation": held.generation + 1,
                "issuedAtMs": floors.get(connector_id, held.issued_at_ms),
                "clearedAtMs": _now_ms(),
                "reason": reason,
            },
            None,
        )

    await _append_against_snapshot(log, hushh_id=hushh_id, build=build)
    return removed[0] if removed else None


# -- process-wide active copy --------------------------------------------------------

_ACTIVE: dict[str, ConnectorCredential] = {}
_KNOWN_CONNECTORS: set[str] = set()
_LOAD_FAILED = True


def _refresh_active(*, connector: str, credential: Optional[ConnectorCredential]) -> None:
    _KNOWN_CONNECTORS.add(connector)
    if credential is None:
        _ACTIVE.pop(connector, None)
    else:
        _ACTIVE[connector] = credential


def set_active_connector_credentials(
    credentials: Mapping[str, ConnectorCredential], *, known_connector_ids: Iterable[str] = ()
) -> None:
    global _LOAD_FAILED
    _ACTIVE.clear()
    _ACTIVE.update(credentials)
    _KNOWN_CONNECTORS.clear()
    _KNOWN_CONNECTORS.update(credentials)
    _KNOWN_CONNECTORS.update(known_connector_ids)
    _LOAD_FAILED = False


def active_connector_credential(connector_id: str) -> Optional[ConnectorCredential]:
    """The login a connector uses now, or None. Raises when the logins could not be read."""
    if _LOAD_FAILED:
        raise ConnectorCredentialsUnavailable("this pod could not read its connector logins")
    return _ACTIVE.get(connector_id)


def held_connector_ids() -> tuple[str, ...]:
    """Every connector this agent holds a login for, from the in-memory copy."""
    if _LOAD_FAILED:
        raise ConnectorCredentialsUnavailable("this pod could not read its connector logins")
    return tuple(_ACTIVE)


def known_connector_ids() -> tuple[str, ...]:
    """IDs reserved by this owner's log, including disconnected credentials."""
    if _LOAD_FAILED:
        raise ConnectorCredentialsUnavailable("this pod could not read its connector logins")
    return tuple(_KNOWN_CONNECTORS)


def connector_states() -> Optional[dict[str, str]]:
    """``connected|needs_reauth|absent`` per Google connector; None while unreadable."""
    if _LOAD_FAILED:
        return None
    return {
        name: (_ACTIVE[name].status if name in _ACTIVE else STATUS_ABSENT)
        for name in GOOGLE_CONNECTORS
    }


def connector_permissions(credential: Optional[ConnectorCredential]) -> dict[str, Any]:
    """Owner-visible capabilities from the actual live grant, without exposing scopes."""
    from hushh_mcp.services.pod_connector_tokens import (  # noqa: PLC0415
        ConnectorTokenError,
        required_scopes,
    )

    capabilities = {"read": False, "manage": False}
    if (
        credential is not None
        and credential.status == STATUS_CONNECTED
        and credential.refresh_token
    ):
        for level in capabilities:
            try:
                required_scopes(credential.connector_id, level, credential.granted_scopes)
            except ConnectorTokenError:
                continue
            capabilities[level] = True
    access_level = "manage" if capabilities["manage"] else "read" if capabilities["read"] else None
    return {"accessLevel": access_level, "capabilities": capabilities}


async def load_connector_credentials(log: Any = None) -> None:
    """Startup (and self-heal): load this owner's logins from the pod's own log. Never raises."""
    global _LOAD_FAILED
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    try:
        if log is None:
            from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

            log = _resolve_log()
        if log is None or not hushh_id:
            raise ConnectorStoreMissing("connector custody is not initialized")
        current, floors = await read_connector_credentials(log, hushh_id=hushh_id)
    except Exception as exc:  # noqa: BLE001 - startup must never fail on this read
        logger.warning("pod_connector_credentials.load_failed reason=%s", type(exc).__name__)
        _LOAD_FAILED = True
        return
    set_active_connector_credentials(current, known_connector_ids=floors)
    logger.info("pod_connector_credentials.loaded count=%d", len(current))


__all__ = [
    "CLEARED_KIND",
    "RECORD_KIND",
    "STATUS_ABSENT",
    "STATUS_CONNECTED",
    "STATUS_NEEDS_REAUTH",
    "ConnectorCredential",
    "ConnectorCredentialsUnavailable",
    "ConnectorStoreMissing",
    "active_connector_credential",
    "advance_credential",
    "clear_connector_credential",
    "connector_states",
    "connector_permissions",
    "credentials_from_records",
    "held_connector_ids",
    "known_connector_ids",
    "load_connector_credentials",
    "read_connector_credentials",
    "record_connector_credential",
    "set_active_connector_credentials",
]
