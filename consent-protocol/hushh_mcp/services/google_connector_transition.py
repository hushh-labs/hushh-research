"""Owner-confirmed transfer of legacy Google custody through existing connectors.

The registry keeps bounded workflow metadata; credential envelopes stay in their
existing rows until the pod confirms a fresh login. Revocation happens before
authorization, and a confirmed snapshot is never revoked again on a retry.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import time
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from hushh_mcp.services.google_connector_transition_store import (
    LegacyCredential,
    TransitionRefused,
    _fence,
    _registry,
    _rows,
    _snapshots,
    _state,
    _write_state,
    admit_revocation_recovery,
    has_credential,
    settle_revocation_recovery,
)
from hushh_mcp.services.pod_request_signing import VerifiedPod

METADATA_KEY = "googleConnectorTransition"
COMPLETE_PATH = "/api/one/google/connect/transition/complete"
_TTL_MS = 10 * 60 * 1000
_PROVIDER_BUDGET_S = 15
_FAMILIES = ("google_provider_connections", "kai_gmail_connections")


class TransitionReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^gct_[a-f0-9]{32}$")
    nonce: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$", repr=False)


class TransitionMutation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal["admit", "complete"]
    transition: TransitionReceipt
    connectorId: Literal["gmail", "calendar", "drive", "contacts"]
    credentialId: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    clientProfile: Literal["hussh_ios", "hussh_android"]
    podKeyId: str = Field(min_length=1, max_length=128)
    issuedAtMs: int = Field(ge=1)
    epoch: int = Field(ge=0)


async def _revoke(records: list[LegacyCredential], post: Any = None) -> bool:
    from hushh_mcp.services import pod_google_oauth as oauth  # noqa: PLC0415

    try:
        tokens = [_legacy_token(record) for record in records if has_credential(record.row)]
        if not all(tokens):
            return False
        async with asyncio.timeout(_PROVIDER_BUDGET_S):
            return all(
                await asyncio.gather(*(oauth.revoke(token, post=post) for token in set(tokens)))
            )
    except Exception:  # noqa: BLE001 - provider diagnostics never carry to the owner
        return False


def _legacy_token(record: LegacyCredential) -> str:
    from hushh_mcp.services.gmail_receipts_service import (
        get_gmail_receipts_service,  # noqa: PLC0415
    )
    from hushh_mcp.services.google_connection_service import (
        get_google_connection_service,  # noqa: PLC0415
    )

    row = record.row
    if record.family == _FAMILIES[0]:
        service = get_google_connection_service()
        token = service.refresh_token_for_erasure(row, user_id=str(row["user_id"]))
        if not token and row.get("access_token_ciphertext"):
            token = service._decrypt(
                {"ciphertext": row["access_token_ciphertext"], "iv": row.get("access_token_iv")},
                aad=f"google-connection:{row['user_id']}",
            )
        return token or ""
    service = get_gmail_receipts_service()
    token = service._decrypt_token(
        row.get("refresh_token_ciphertext"),
        row.get("refresh_token_iv"),
        row.get("refresh_token_tag"),
    )
    return (
        token
        or service._decrypt_token(
            row.get("access_token_ciphertext"),
            row.get("access_token_iv"),
            row.get("access_token_tag"),
        )
        or ""
    )


def _affected_services(connection: Any, owner: str, records: list[LegacyCredential]) -> list[str]:
    services = {"gmail"} if any(r.family == _FAMILIES[1] for r in records) else set()
    if any(r.family == _FAMILIES[0] for r in records):
        grants = (
            connection.execute(
                text("SELECT service FROM google_service_grants WHERE user_id=:owner"),
                {"owner": owner},
            )
            .mappings()
            .all()
        )
        known = {str(g["service"]) for g in grants} & {"gmail", "calendar", "drive", "contacts"}
        services.update(known or {"gmail", "calendar", "drive", "contacts"})
    return sorted(services)


class GoogleConnectorTransitionService:
    def __init__(self, db: Any = None, *, clock: Callable[[], float] = time.time) -> None:
        self._db, self._clock = db, clock

    @property
    def db(self) -> Any:
        if self._db is None:
            from db.db_client import get_db  # noqa: PLC0415

            self._db = get_db()
        return self._db

    def _begin(self, owner: str, profile: str, confirmed: bool) -> tuple[dict, list, dict]:
        from hushh_mcp.services.pod_google_oauth import (  # noqa: PLC0415
            GoogleOAuthError,
            native_client_id,
            validate_native_client,
        )

        if not native_client_id(profile):
            raise TransitionRefused("CLIENT_PROFILE_UNSUPPORTED", 422)
        try:
            validate_native_client(profile, native_client_id(profile))
        except GoogleOAuthError:
            raise TransitionRefused("CLIENT_PROFILE_UNSUPPORTED", 422) from None
        now = int(self._clock() * 1000)
        with self.db.engine.begin() as connection:
            row = _registry(connection, owner)
            records = _rows(connection, owner)
            admit_revocation_recovery(row, records, now)
            previous = _state(row)
            snapshots = _snapshots(records)
            prior_confirmed = (
                previous.get("providerConfirmed") is True
                and previous.get("snapshots") == snapshots
                and previous.get("podKeyId") == row["pod_key_id"]
            )
            if previous.get("phase") == "preparing" and previous.get("expiresAtMs", 0) > now:
                raise TransitionRefused("GOOGLE_TRANSITION_BUSY")
            if previous.get("phase") in {"ready", "authorizing"} and not prior_confirmed:
                raise TransitionRefused("GOOGLE_TRANSITION_CONNECTION_CHANGED")
            has_grants = any(has_credential(record.row) for record in records)
            if has_grants and not prior_confirmed and confirmed is not True:
                return (
                    {
                        "status": "confirmation_required",
                        "services": _affected_services(connection, owner, records),
                        "scope": "all_google_project_grants",
                    },
                    [],
                    {},
                )
            receipt = TransitionReceipt(
                id="gct_" + secrets.token_hex(16), nonce=secrets.token_urlsafe(32)
            )
            state = {
                "version": 1,
                "id": receipt.id,
                "nonceHash": hashlib.sha256(receipt.nonce.encode()).hexdigest(),
                "phase": "preparing",
                "profile": profile,
                "podKeyId": row["pod_key_id"],
                "signingKeyId": row["pod_signing_key_id"],
                "epoch": row.get("placement_epoch", 0) or 0,
                "snapshots": snapshots,
                "preparedAtMs": now,
                "expiresAtMs": now + _TTL_MS,
                "providerConfirmed": not has_grants or prior_confirmed,
                "reauthAccounts": previous.get("reauthAccounts", [])
                if prior_confirmed
                else [
                    hashlib.sha256(
                        str(r.row.get("provider_subject") or r.row.get("google_sub")).encode()
                    ).hexdigest()
                    if str(r.row.get("provider_subject") or r.row.get("google_sub") or "").isdigit()
                    else None
                    for r in records
                    if has_credential(r.row)
                ],
                "revokedAtMs": previous.get("revokedAtMs", now) if prior_confirmed else now,
            }
            _fence(connection, owner)
            _write_state(connection, owner, state)
        return {"status": "ready", "transition": receipt.model_dump()}, records, state

    def _ready(self, owner: str, state: dict, confirmed: bool) -> None:
        with self.db.engine.begin() as connection:
            row = _registry(connection, owner)
            current = _state(row)
            if (
                current.get("id") != state["id"]
                or current.get("podKeyId") != row["pod_key_id"]
                or current.get("signingKeyId") != row["pod_signing_key_id"]
                or current.get("epoch") != (row.get("placement_epoch", 0) or 0)
                or _snapshots(_rows(connection, owner)) != state["snapshots"]
            ):
                raise TransitionRefused("GOOGLE_TRANSITION_CONNECTION_CHANGED")
            current.update(
                phase="ready" if confirmed else "blocked",
                providerConfirmed=confirmed,
                preparedAtMs=int(self._clock() * 1000),
            )
            if confirmed and not state["providerConfirmed"]:
                current["revokedAtMs"] = int(self._clock() * 1000)
            if confirmed:
                settle_revocation_recovery(connection, owner, row)
            _write_state(connection, owner, current)

    async def prepare(self, *, owner: str, profile: str, confirmed: bool, post: Any = None) -> dict:
        response, records, state = await asyncio.to_thread(self._begin, owner, profile, confirmed)
        if not state:
            return response
        provider_confirmed = state["providerConfirmed"] or await _revoke(records, post)
        await asyncio.to_thread(self._ready, owner, state, bool(provider_confirmed))
        if not provider_confirmed:
            raise TransitionRefused("GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED", 503)
        return response

    def _mutation(self, principal: VerifiedPod, body: TransitionMutation) -> dict:
        now = int(self._clock() * 1000)
        with self.db.engine.begin() as connection:
            observed = (
                connection.execute(
                    text("SELECT user_id FROM personal_agent_registry WHERE hushh_id=:hushh"),
                    {"hushh": principal.hushh_id},
                )
                .mappings()
                .first()
            )
            if not observed:
                raise TransitionRefused("GOOGLE_TRANSITION_POD_MISMATCH", 403)
            owner = observed["user_id"]
            row = _registry(connection, owner)
            state = _state(row)
            _validate_mutation(principal, body, row, state, now)
            return _apply_mutation(connection, owner, state, body, now)

    async def mutate(self, principal: VerifiedPod, body: TransitionMutation) -> dict:
        return dict(await asyncio.to_thread(self._mutation, principal, body))


def _validate_mutation(
    principal: VerifiedPod, body: TransitionMutation, row: dict, state: dict, now: int
) -> None:
    from hushh_mcp.services.pod_placement_fence import row_epoch  # noqa: PLC0415

    if (
        not principal.signed
        or principal.standby
        or row.get("hushh_id") != principal.hushh_id
        or row["pod_signing_key_id"] != principal.key_id
        or row["pod_key_id"] != body.podKeyId
        or state.get("signingKeyId") != principal.key_id
        or state.get("podKeyId") != body.podKeyId
        or body.epoch != row_epoch(row)
        or state.get("epoch") != body.epoch
    ):
        raise TransitionRefused("GOOGLE_TRANSITION_POD_MISMATCH", 403)
    valid = (
        state.get("id") == body.transition.id
        and state.get("profile") == body.clientProfile
        and hmac.compare_digest(
            str(state.get("nonceHash") or ""),
            hashlib.sha256(body.transition.nonce.encode()).hexdigest(),
        )
    )
    if (
        not valid
        or state.get("providerConfirmed") is not True
        or state.get("expiresAtMs", 0) <= now
    ):
        raise TransitionRefused("GOOGLE_TRANSITION_EXPIRED")
    if not state.get("preparedAtMs", now + 1) <= body.issuedAtMs <= now + 30_000:
        raise TransitionRefused("GOOGLE_TRANSITION_STALE_CREDENTIAL")


def _apply_mutation(
    connection: Any, owner: str, state: dict, body: TransitionMutation, now: int
) -> dict:
    binding = {"credentialId": body.credentialId, "connectorId": body.connectorId}
    if (
        state.get("phase") == "completed"
        and state.get("binding") == binding
        and body.operation == "complete"
    ):
        return {"status": "completed"}
    if body.operation == "admit":
        if (
            state.get("phase") not in {"ready", "authorizing"}
            or state.get("binding", binding) != binding
        ):
            raise TransitionRefused("GOOGLE_TRANSITION_ALREADY_ADMITTED")
        state.update(phase="authorizing", binding=binding)
        _write_state(connection, owner, state)
        return {
            "status": "admitted",
            "preparedAtMs": state["preparedAtMs"],
            "expiresAtMs": state["expiresAtMs"],
            "reauthAccounts": state["reauthAccounts"],
            "revokedAtMs": state["revokedAtMs"],
        }
    if state.get("phase") != "authorizing" or state.get("binding") != binding:
        raise TransitionRefused("GOOGLE_TRANSITION_NOT_ADMITTED")
    current = _rows(connection, owner)
    if any(
        state["snapshots"].get(r.family) != r.revision or r.row.get("status") != "disconnected"
        for r in current
    ):
        raise TransitionRefused("GOOGLE_TRANSITION_CONNECTION_CHANGED")
    for statement in (
        "DELETE FROM google_provider_connections WHERE user_id=:owner AND status='disconnected'",
        "DELETE FROM kai_gmail_connections WHERE user_id=:owner AND status='disconnected'",
        "DELETE FROM google_service_grants WHERE user_id=:owner",
        "DELETE FROM google_oauth_attempts WHERE user_id=:owner",
        "DELETE FROM google_calendar_action_proposals WHERE user_id=:owner",
        "DELETE FROM kai_receipt_memory_artifacts WHERE user_id=:owner",
        "DELETE FROM kai_gmail_receipts WHERE user_id=:owner",
        "DELETE FROM kai_gmail_sync_runs WHERE user_id=:owner",
    ):
        connection.execute(text(statement), {"owner": owner})
    state.update(phase="completed", completedAtMs=now, snapshots={})
    _write_state(connection, owner, state)
    return {"status": "completed"}


_SERVICE: GoogleConnectorTransitionService | None = None


def get_google_connector_transition_service() -> GoogleConnectorTransitionService:
    global _SERVICE
    if _SERVICE is None:
        _SERVICE = GoogleConnectorTransitionService()
    return _SERVICE


async def pod_transition(
    operation: Literal["admit", "complete"],
    receipt: Any,
    opened: Any,
    *,
    pod_key_id: str,
    client: Any = None,
) -> dict:
    """Only metadata uses the signed control plane; no OAuth code or token goes there."""
    from hushh_mcp.services.pod_hub_client import PodHubClient  # noqa: PLC0415

    try:
        body = TransitionMutation(
            operation=operation,
            transition=TransitionReceipt.model_validate(receipt),
            connectorId=opened.connector_id,
            credentialId=opened.credential_id,
            clientProfile=opened.client_profile,
            podKeyId=pod_key_id,
            issuedAtMs=opened.issued_at_ms,
            epoch=_pod_epoch(),
        )
        response = await asyncio.to_thread(
            (client or PodHubClient()).post, COMPLETE_PATH, json=body.model_dump()
        )
        payload = response.json() if response.status_code == 200 else {}
        expected = "admitted" if operation == "admit" else "completed"
        if not isinstance(payload, dict) or payload.get("status") != expected:
            raise ValueError
        if operation == "admit":
            if (
                set(payload)
                != {"status", "preparedAtMs", "expiresAtMs", "revokedAtMs", "reauthAccounts"}
                or any(
                    type(payload.get(k)) is not int or payload[k] <= 0
                    for k in ("preparedAtMs", "expiresAtMs", "revokedAtMs")
                )
                or not isinstance(payload["reauthAccounts"], list)
                or len(payload["reauthAccounts"]) > 2
                or any(
                    value is not None
                    and (
                        not isinstance(value, str)
                        or len(value) != 64
                        or any(char not in "0123456789abcdef" for char in value)
                    )
                    for value in payload["reauthAccounts"]
                )
            ):
                raise ValueError
        return payload
    except Exception:  # noqa: BLE001 - receipt or transport diagnostics reveal nothing
        raise TransitionRefused("GOOGLE_TRANSITION_UNAVAILABLE", 503) from None


def _pod_epoch() -> int:
    from hushh_mcp.services.pod_role import signing_epoch  # noqa: PLC0415

    return signing_epoch() or 0


async def invalidate_pod_grants(log: Any, *, hushh_id: str, admission: dict) -> None:
    """Verify affected grants against Google; only invalid_grant retires an exact generation."""
    from hushh_mcp.services import pod_connector_credentials as credentials  # noqa: PLC0415
    from hushh_mcp.services.pod_connector_tokens import (  # noqa: PLC0415
        NEEDS_REAUTH,
        ConnectorTokenError,
        google_token_source,
    )

    accounts = admission["reauthAccounts"]
    held, _ = await credentials.read_connector_credentials(log, hushh_id=hushh_id)
    source = google_token_source()
    affected = []
    for name, credential in held.items():
        account = hashlib.sha256(credential.account_subject.encode()).hexdigest()
        if (
            name not in credentials.GOOGLE_CONNECTORS
            or credential.status != credentials.STATUS_CONNECTED
            or not accounts
            or (None not in accounts and account not in accounts)
        ):
            continue
        source.forget(name)
        affected.append(credential)
    try:
        async with asyncio.timeout(_PROVIDER_BUDGET_S):
            for credential in affected:
                try:
                    await source.validate_current(credential)
                except ConnectorTokenError as exc:
                    if exc.code != NEEDS_REAUTH:
                        raise TransitionRefused("GOOGLE_TRANSITION_UNAVAILABLE", 503) from None
    except TimeoutError:
        raise TransitionRefused("GOOGLE_TRANSITION_UNAVAILABLE", 503) from None
