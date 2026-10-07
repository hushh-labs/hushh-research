"""MCP OAuth connectors inside the owner's own agent, only on credentials it holds.

On the hub a curated connector (an operator-registered provider) is resolved by
``resolve_registered_connection``: the hub's registry row and the hub's stored OAuth
grant. Inside a pod that resolver is never reached (the pod's turn scope is
``vault_only``), and it must stay that way: a curated connector may run in the agent
only when every credential it uses is in the agent's own custody.

The agent builds the connector's turn configuration itself, from a login
sealed to it (``pod_connector_credentials``, connector id ``mcp_<name>``, kind
``mcp_oauth``):

* the access token is minted here, by refreshing at the issuer's own token endpoint
  (found from ``<issuer>/.well-known/oauth-authorization-server`` and required to be
  on the issuer's own origin), and kept in memory only;
* a rotated refresh token is recorded as the next generation, or the connector is
  left out of the turn; ``invalid_grant`` marks the login ``needs_reauth``;
* a login that is not connected, has no endpoint, or cannot mint a token is left out:
  never substituted from the hub, never half-built.

:func:`custody_configurations` returns records in exactly the shape
``validate_mcp_turn_configurations`` admits, under a stable ``custom_`` id derived
from the custody connector id; :func:`merge_turn_configurations` adds them to the
owner's device-supplied ones and refuses a device record that claims a custody id.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_google_oauth as oauth

logger = logging.getLogger(__name__)

_PREFIX = "mcp_"
_SKEW_S = 60
_MAX_CONNECTORS = 16
Get = Callable[[str], Any]


def custody_connector_id(connector_id: str) -> str:
    """The turn id for a custody connector: stable, and never a device's own id."""
    digest = hashlib.sha256(f"pod-custody:{connector_id}".encode()).hexdigest()[:32]
    return f"custom_{digest}"


def _same_origin(a: str, b: str) -> bool:
    left, right = urlsplit(a), urlsplit(b)
    return left.scheme == right.scheme == "https" and left.netloc == right.netloc


async def _http_get_json(url: str) -> tuple[int, dict]:
    import httpx  # noqa: PLC0415

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
        response = await client.get(url)
    try:
        body = response.json()
    except ValueError:
        body = {}
    return response.status_code, body if isinstance(body, dict) else {}


class CustodyMcpTokens:
    """Access tokens for custody MCP logins, minted by the agent itself."""

    def __init__(
        self,
        *,
        get: Optional[Get] = None,
        post: Optional[oauth.Post] = None,
        log_resolver: Optional[Callable[[], Any]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._get = get
        self._post = post
        self._log_resolver = log_resolver
        self._clock = clock
        self._cache: dict[tuple[str, str, int], tuple[str, int]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _log(self) -> Any:
        if self._log_resolver is not None:
            return self._log_resolver()
        from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

        return _resolve_log()

    async def _token_endpoint(self, issuer: str) -> Optional[str]:
        base = issuer.rstrip("/")
        status, body = await (self._get or _http_get_json)(
            f"{base}/.well-known/oauth-authorization-server"
        )
        endpoint = str(body.get("token_endpoint") or "") if status == 200 else ""
        return endpoint if endpoint and _same_origin(endpoint, base) else None

    async def token(self, credential: store.ConnectorCredential) -> Optional[tuple[str, int]]:
        """(access token, expires at epoch seconds), or None when it cannot be minted here."""
        async with self._locks.setdefault(credential.connector_id, asyncio.Lock()):
            try:
                current = store.active_connector_credential(credential.connector_id)
                if current is None or current.credential_id != credential.credential_id:
                    return None
                return await self._token(current)
            except Exception as exc:  # noqa: BLE001 - never expose discovery/provider credentials
                logger.info("pod_custody_mcp.unavailable reason=%s", type(exc).__name__)
                return None

    async def _token(self, credential: store.ConnectorCredential) -> Optional[tuple[str, int]]:
        from hushh_mcp.services.pod_connector_tokens import _advance_or_false  # noqa: PLC0415

        mcp = credential.mcp or {}
        issuer, client_id = str(mcp.get("issuer") or ""), str(mcp.get("clientId") or "")
        if (
            not issuer
            or not client_id
            or not credential.refresh_token
            or credential.status != store.STATUS_CONNECTED
        ):
            return None
        key = (credential.connector_id, credential.credential_id, credential.generation)
        now = int(self._clock())
        cached = self._cache.get(key)
        if cached and cached[1] - _SKEW_S > now:
            return cached
        endpoint = await self._token_endpoint(issuer)
        if endpoint is None or not _credential_current(credential):
            return None
        form = {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": credential.refresh_token,
        }
        if mcp.get("clientSecret"):
            form["client_secret"] = str(mcp["clientSecret"])
        try:
            grant = oauth._grant(*await oauth._call(self._post, endpoint, form))
        except oauth.GoogleOAuthError as exc:
            if exc.code == oauth.INVALID_GRANT:
                await _advance_or_false(
                    self._log, credential, credential.connector_id, needs_reauth=True
                )
            return None
        generation = credential.generation
        if grant.refresh_token and grant.refresh_token != credential.refresh_token:
            if not await _advance_or_false(
                self._log, credential, credential.connector_id, refresh_token=grant.refresh_token
            ):
                return None
            generation += 1
        if not _credential_current(credential, generation=generation) or grant.expires_in_s <= 0:
            return None
        minted = (grant.access_token, now + grant.expires_in_s)
        key = (credential.connector_id, credential.credential_id, generation)
        self._cache[key] = minted
        return minted


def _credential_current(
    credential: store.ConnectorCredential, *, generation: Optional[int] = None
) -> bool:
    current = store.active_connector_credential(credential.connector_id)
    return bool(
        current is not None
        and current.status == store.STATUS_CONNECTED
        and current.credential_id == credential.credential_id
        and current.generation == (credential.generation if generation is None else generation)
    )


def _held_custody() -> list[store.ConnectorCredential]:
    try:
        names = store.held_connector_ids()
    except store.ConnectorCredentialsUnavailable:
        return []
    held = []
    for name in sorted(names):
        credential = store.active_connector_credential(name) if name.startswith(_PREFIX) else None
        if credential is not None and credential.status == store.STATUS_CONNECTED:
            held.append(credential)
    return held[:_MAX_CONNECTORS]


async def custody_configurations(tokens: Optional[CustodyMcpTokens] = None) -> list[dict]:
    """Turn configurations for every curated connector whose login this agent holds."""
    from hushh_mcp.one_adk.mcp_turn_scope import validate_mcp_turn_configurations  # noqa: PLC0415
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent  # noqa: PLC0415

    if not owner_cloud_agent():
        return []
    minter = tokens or _shared_tokens()
    records: list[dict] = []
    for credential in _held_custody():
        endpoint = str((credential.mcp or {}).get("endpoint") or "")
        minted = await minter.token(credential) if endpoint else None
        if minted is None:
            logger.info("pod_custody_mcp.left_out connector=%s", credential.connector_id)
            continue
        current = store.active_connector_credential(credential.connector_id)
        if current is None or current.credential_id != credential.credential_id:
            continue
        record = {
            "version": 1,
            "connectorId": custody_connector_id(credential.connector_id),
            "revision": str(
                uuid.uuid5(uuid.NAMESPACE_URL, f"{current.credential_id}:{current.generation}")
            ),
            "displayName": credential.connector_id.removeprefix(_PREFIX).replace("_", " ")[:100]
            or "Connector",
            "endpoint": endpoint,
            "enabled": True,
            "authentication": {"kind": "oauth", "accessToken": minted[0], "expiresAt": minted[1]},
        }
        try:
            validate_mcp_turn_configurations([record])
        except Exception:  # noqa: BLE001 - an unadmittable record is left out, never relaxed
            logger.info("pod_custody_mcp.refused connector=%s", credential.connector_id)
            continue
        records.append(record)
    return records


def merge_turn_configurations(device: list[dict], custody: list[dict]) -> list[dict]:
    """The owner's device records plus custody records; a device may not claim a custody id."""
    claimed = {record["connectorId"] for record in custody}
    try:
        claimed.update(
            custody_connector_id(name)
            for name in store.known_connector_ids()
            if name.startswith(_PREFIX)
        )
    except store.ConnectorCredentialsUnavailable:
        # The caller cannot trust a partial custody inventory as a device override.
        raise RuntimeError("Connector custody unavailable") from None
    kept = [record for record in device or [] if record.get("connectorId") not in claimed]
    if len(kept) != len(device or []):
        logger.warning("pod_custody_mcp.device_claimed_custody_id")
    return [*kept, *custody]


def custody_configuration_admissions(records: list[dict]) -> dict[str, Callable[[dict], None]]:
    """Per-call fences for server-minted records; their IDs survive a disconnect.

    These callbacks belong to the runtime, never to browser configuration. No
    canonical curated catalog is inferred from an OAuth login. The turn scope
    requires exact-call review whenever one of these callbacks applies.
    """
    held = {custody_connector_id(c.connector_id): c for c in _held_custody()}
    callbacks = {}
    for record in records:
        credential = held.get(record["connectorId"])
        if credential is None:
            raise RuntimeError("Connector custody changed")
        callbacks[record["connectorId"]] = _configuration_admission(record, credential)
    return callbacks


def _configuration_admission(
    record: dict, credential: store.ConnectorCredential
) -> Callable[[dict], None]:
    import json  # noqa: PLC0415

    from hushh_mcp.services.external_mcp_client import ExternalMcpError  # noqa: PLC0415

    fingerprint = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).digest()
    connector, identifier, generation = (
        credential.connector_id,
        credential.credential_id,
        credential.generation,
    )
    if record["revision"] != str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"{identifier}:{generation}")
    ) or record["endpoint"] != (credential.mcp or {}).get("endpoint"):
        raise ExternalMcpError("Connector connection changed.", code="MCP_CONNECTION_CHANGED")

    def require_current(candidate: dict) -> None:
        try:
            same_record = (
                hashlib.sha256(json.dumps(candidate, sort_keys=True).encode()).digest()
                == fingerprint
            )
            held = store.active_connector_credential(connector)
            current = bool(
                held is not None
                and held.status == store.STATUS_CONNECTED
                and held.credential_id == identifier
                and held.generation == generation
            )
        except Exception:  # noqa: BLE001 - a missing or unreadable custody is unavailable
            same_record = current = False
        if not same_record or not current:
            raise ExternalMcpError("Connector connection changed.", code="MCP_CONNECTION_CHANGED")

    require_current(record)
    return require_current


_TOKENS: Optional[CustodyMcpTokens] = None


def _shared_tokens() -> CustodyMcpTokens:
    global _TOKENS
    if _TOKENS is None:
        _TOKENS = CustodyMcpTokens()
    return _TOKENS


__all__ = [
    "CustodyMcpTokens",
    "custody_configurations",
    "custody_connector_id",
    "custody_configuration_admissions",
    "merge_turn_configurations",
]
