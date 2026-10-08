"""Transactional legacy Google custody fences, using the existing credential rows."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.compute_backend import is_owner_cloud_target

METADATA_KEY = "googleConnectorTransition"
REVOCATIONS_KEY = "googleLegacyRevocations"
_FAMILIES = ("google_provider_connections", "kai_gmail_connections")
_SELECT_FAMILY = {
    "google_provider_connections": "SELECT * FROM google_provider_connections WHERE user_id=:owner FOR UPDATE",
    "kai_gmail_connections": "SELECT * FROM kai_gmail_connections WHERE user_id=:owner FOR UPDATE",
}
_CLEAR_FAMILY = {
    "google_provider_connections": """UPDATE google_provider_connections SET refresh_token_ciphertext=NULL,
        refresh_token_iv=NULL,refresh_token_tag=NULL,access_token_ciphertext=NULL,
        access_token_iv=NULL,access_token_tag=NULL,access_token_expires_at=NULL
        WHERE user_id=:owner AND status='disconnected'""",
    "kai_gmail_connections": """UPDATE kai_gmail_connections SET refresh_token_ciphertext=NULL,
        refresh_token_iv=NULL,refresh_token_tag=NULL,access_token_ciphertext=NULL,
        access_token_iv=NULL,access_token_tag=NULL,access_token_expires_at=NULL
        WHERE user_id=:owner AND status='disconnected'""",
}


class TransitionRefused(RuntimeError):
    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code, self.status = code, status


@dataclass(frozen=True)
class LegacyCredential:
    family: str
    revision: str
    row: dict[str, Any] = field(repr=False)


def _revision(row: dict) -> str:
    fields: tuple[str, ...] = (
        "refresh_token_ciphertext",
        "refresh_token_iv",
        "refresh_token_tag",
        "provider_subject",
        "google_sub",
        "connected_at",
    )
    if not row.get("refresh_token_ciphertext"):
        fields += ("access_token_ciphertext", "access_token_iv", "access_token_tag")
    bound = {name: str(row.get(name) or "") for name in fields}
    return hashlib.sha256(json.dumps(bound, sort_keys=True).encode()).hexdigest()


def _state(row: dict) -> dict:
    metadata = row.get("backend_metadata") or {}
    value = metadata.get(METADATA_KEY) if isinstance(metadata, dict) else None
    return dict(value) if isinstance(value, dict) else {}


def _rows(connection: Any, owner: str) -> list[LegacyCredential]:
    records = []
    for family in _FAMILIES:
        row = connection.execute(text(_SELECT_FAMILY[family]), {"owner": owner}).mappings().first()
        if row:
            records.append(LegacyCredential(family, _revision(dict(row)), dict(row)))
    return records


def _snapshots(records: list[LegacyCredential]) -> dict[str, str]:
    return {record.family: record.revision for record in records}


def has_credential(row: dict) -> bool:
    return bool(row.get("refresh_token_ciphertext") or row.get("access_token_ciphertext"))


def _private(row: dict | None) -> dict:
    if (
        not row
        or not is_owner_cloud_target(str(row.get("deployment_target") or ""))
        or not row.get("pod_key_id")
        or not row.get("pod_signing_key_id")
        or row.get("status") not in {"provisioned", "active"}
    ):
        raise TransitionRefused("GOOGLE_TRANSITION_PRIVATE_POD_REQUIRED")
    return dict(row)


def _registry(connection: Any, owner: str) -> dict:
    from hushh_mcp.services.google_connection_service import (
        GoogleConnectionService,  # noqa: PLC0415
    )

    GoogleConnectionService._lock_google_owner(connection, owner)
    row = (
        connection.execute(
            text("SELECT * FROM personal_agent_registry WHERE user_id=:owner FOR UPDATE"),
            {"owner": owner},
        )
        .mappings()
        .first()
    )
    return _private(dict(row) if row else None)


def _write_state(connection: Any, owner: str, state: dict) -> None:
    connection.execute(
        text("""UPDATE personal_agent_registry SET backend_metadata=jsonb_set(
        COALESCE(backend_metadata,'{}'::jsonb),'{googleConnectorTransition}',CAST(:state AS jsonb),true)
        WHERE user_id=:owner"""),
        {"owner": owner, "state": json.dumps(state)},
    )


def _fence(connection: Any, owner: str) -> None:
    params = {"owner": owner}
    connection.execute(
        text("""UPDATE google_service_grants SET status='disconnected',
        disconnected_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=:owner"""),
        params,
    )
    connection.execute(
        text("""UPDATE google_provider_connections SET status='disconnected',
        revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=:owner"""),
        params,
    )
    connection.execute(
        text("""UPDATE kai_gmail_connections SET status='disconnected',revoked=true,
        auto_sync_enabled=false,send_enabled=false,disconnected_at=clock_timestamp(),
        updated_at=clock_timestamp() WHERE user_id=:owner"""),
        params,
    )
    connection.execute(
        text("""UPDATE google_oauth_attempts SET consumed_at=COALESCE(consumed_at,clock_timestamp()),
        expires_at=clock_timestamp() WHERE user_id=:owner"""),
        params,
    )
    connection.execute(
        text("""UPDATE kai_gmail_sync_runs SET status='canceled',
        completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE user_id=:owner AND status IN ('queued','running')"""),
        params,
    )
    connection.execute(
        text("DELETE FROM google_calendar_action_proposals WHERE user_id=:owner"), params
    )


def publish_legacy_credential(db: Any, sql: str, params: dict, *, owner: str) -> Any:
    """Serialize publication with preparation, including callbacks that began earlier."""
    from hushh_mcp.services.google_connection_service import (  # noqa: PLC0415
        GoogleConnectionService,
    )

    with db.engine.begin() as connection:
        GoogleConnectionService._lock_google_owner(connection, owner)
        require_legacy_publication(connection, owner)
        rows = connection.execute(text(sql), params).mappings().all()
    from types import SimpleNamespace  # noqa: PLC0415

    return SimpleNamespace(data=[dict(row) for row in rows])


def require_legacy_publication(connection: Any, owner: str, *, revocation: bool = False) -> None:
    from hushh_mcp.services.google_connection_service import GoogleConnectionError  # noqa: PLC0415

    row = (
        connection.execute(
            text(
                "SELECT deployment_target,backend_metadata FROM personal_agent_registry WHERE user_id=:owner"
            ),
            {"owner": owner},
        )
        .mappings()
        .first()
    )
    if row and is_owner_cloud_target(str(row.get("deployment_target") or "")) and _state(dict(row)):
        raise GoogleConnectionError("Use your private agent to connect Google.", status_code=409)
    if not revocation and (
        (row and pending_revocations(dict(row)))
        or any(
            record.row.get("status") == "disconnected" and has_credential(record.row)
            for record in _rows(connection, owner)
        )
    ):
        raise GoogleConnectionError(
            "Finish the previous Google disconnect before signing in.", status_code=409
        )


def pending_revocations(row: dict) -> dict:
    metadata = row.get("backend_metadata") or {}
    claims = metadata.get(REVOCATIONS_KEY, {}) if isinstance(metadata, dict) else {}
    if not isinstance(claims, dict) or not set(claims) <= set(_FAMILIES):
        raise TransitionRefused("GOOGLE_TRANSITION_UNAVAILABLE", 503)
    for claim in claims.values():
        if (
            not isinstance(claim, dict)
            or set(claim) != {"id", "phase", "revision", "expiresAtMs"}
            or not isinstance(claim.get("id"), str)
            or not claim["id"].startswith("gcr_")
            or len(claim["id"]) != 36
            or claim.get("phase") not in {"pending", "unconfirmed"}
            or not isinstance(claim.get("revision"), str)
            or len(claim["revision"]) != 64
            or type(claim.get("expiresAtMs")) is not int
        ):
            raise TransitionRefused("GOOGLE_TRANSITION_UNAVAILABLE", 503)
    return dict(claims)


def _write_revocations(connection: Any, owner: str, claims: dict) -> None:
    connection.execute(
        text("""UPDATE personal_agent_registry SET backend_metadata=jsonb_set(
        COALESCE(backend_metadata,'{}'::jsonb),'{googleLegacyRevocations}',CAST(:state AS jsonb),true)
        WHERE user_id=:owner"""),
        {"owner": owner, "state": json.dumps(claims)},
    )


def _legacy_registry(connection: Any, owner: str) -> dict:
    row = (
        connection.execute(
            text("SELECT * FROM personal_agent_registry WHERE user_id=:owner FOR UPDATE"),
            {"owner": owner},
        )
        .mappings()
        .first()
    )
    return dict(row) if row else {}


def begin_legacy_revocation(connection: Any, *, owner: str, family: str, row: dict) -> dict | None:
    """Caller holds the owner lock. Keep the original envelope until provider confirmation."""
    if family not in _FAMILIES:
        raise ValueError("unsupported legacy credential family")
    if not has_credential(row):
        return None
    require_legacy_publication(connection, owner, revocation=True)
    registry = _legacy_registry(connection, owner)
    claims = pending_revocations(registry)
    previous = claims.get(family) or {}
    now = int(time.time() * 1000)
    if previous.get("phase") == "pending" and previous.get("expiresAtMs", 0) > now:
        raise TransitionRefused("GOOGLE_TRANSITION_BUSY")
    claim = {
        "id": "gcr_" + secrets.token_hex(16),
        "revision": _revision(row),
        "phase": "pending",
        "expiresAtMs": now + 30_000,
    }
    if registry:
        claims[family] = claim
        _write_revocations(connection, owner, claims)
    # An absent registry has no assignment to create: the retained exact row is recovery authority.
    return claim


def finish_legacy_revocation(
    db: Any, *, owner: str, family: str, claim: dict | None, confirmed: bool
) -> None:
    if family not in _FAMILIES:
        raise ValueError("unsupported legacy credential family")
    if claim is None:
        return
    from hushh_mcp.services.google_connection_service import (
        GoogleConnectionService,  # noqa: PLC0415
    )

    with db.engine.begin() as connection:
        GoogleConnectionService._lock_google_owner(connection, owner)
        registry = _legacy_registry(connection, owner)
        claims = pending_revocations(registry)
        current_claim = claims.get(family)
        if current_claim and current_claim.get("id") != claim["id"]:
            return
        if current_claim:
            if confirmed:
                claims.pop(family)
            else:
                claims[family] = {**claim, "phase": "unconfirmed"}
            _write_revocations(connection, owner, claims)
        row = connection.execute(text(_SELECT_FAMILY[family]), {"owner": owner}).mappings().first()
        if (
            not confirmed
            or not row
            or _revision(dict(row)) != claim["revision"]
            or row.get("status") != "disconnected"
            or _state(registry)
        ):
            return
        connection.execute(
            text(_CLEAR_FAMILY[family]),
            {"owner": owner},
        )


def begin_gmail_disconnect(db: Any, sql: str, params: dict, row: dict) -> dict | None:
    from hushh_mcp.services.google_connection_service import (
        GoogleConnectionService,  # noqa: PLC0415
    )

    owner = params["user_id"]
    with db.engine.begin() as connection:
        GoogleConnectionService._lock_google_owner(connection, owner)
        current = (
            connection.execute(
                text("SELECT * FROM kai_gmail_connections WHERE user_id=:owner FOR UPDATE"),
                {"owner": owner},
            )
            .mappings()
            .first()
        )
        if not current or _revision(dict(current)) != _revision(row):
            raise TransitionRefused("GOOGLE_TRANSITION_CONNECTION_CHANGED")
        claim = begin_legacy_revocation(
            connection, owner=owner, family=_FAMILIES[1], row=dict(current)
        )
        connection.execute(text(sql), params)
        return claim


def admit_revocation_recovery(row: dict, records: list[LegacyCredential], now: int) -> None:
    for family, claim in pending_revocations(row).items():
        if claim["phase"] == "pending" and claim["expiresAtMs"] > now:
            raise TransitionRefused("GOOGLE_TRANSITION_BUSY")
        record = next((r for r in records if r.family == family), None)
        if not record or not has_credential(record.row) or record.revision != claim["revision"]:
            raise TransitionRefused("GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED", 503)


def settle_revocation_recovery(connection: Any, owner: str, row: dict) -> None:
    """Only called after confirming every retained snapshot's provider revocation."""
    if pending_revocations(row):
        _write_revocations(connection, owner, {})
