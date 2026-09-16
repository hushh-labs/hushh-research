"""Owner-level Location sharing posture (migration 221).

One persisted answer to "is sharing on?" that the app enforces. ``unset`` is
the legacy state and changes nothing; ``off`` is enforced by
:meth:`OneLocationAgentService` write paths through :func:`assert_sharing_not_off`.
Turning sharing off revokes every active owner grant outside the SOS lane and
every active public link in the same transaction, so "off" is true the moment
the tool result says so.

``precision`` is a preference only: points are recipient-encrypted on the
device, so the server records the choice and rejects a mismatched envelope
tag, but cannot see or coarsen coordinates itself.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    _one_location_url,
    _share_lane_match_sql,
)

logger = logging.getLogger(__name__)

SHARING_STATES = ("unset", "on", "off")
PRECISIONS = ("precise", "approximate")
OS_PERMISSION_STATES = ("unknown", "prompt", "granted", "denied")

_SETTINGS_COLUMNS = """
    user_id, sharing_state, precision, sharing_consent_version, sharing_consent_accepted_at,
    sharing_enabled_at, sharing_disabled_at, os_permission_reported, os_permission_reported_at,
    created_at, updated_at
"""


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value else None


@dataclass(frozen=True)
class AccountSettings:
    user_id: str
    sharing_state: str = "unset"
    precision: str = "precise"
    sharing_consent_version: str | None = None
    sharing_consent_accepted_at: str | None = None
    sharing_enabled_at: str | None = None
    sharing_disabled_at: str | None = None
    os_permission_reported: str = "unknown"
    os_permission_reported_at: str | None = None

    @property
    def sharing_enabled(self) -> bool:
        return self.sharing_state == "on"

    def as_payload(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["sharing_enabled"] = self.sharing_enabled
        return payload


@dataclass(frozen=True)
class SharingTransition:
    settings: AccountSettings
    changed: bool
    revoked_grant_ids: tuple[str, ...] = ()
    revoked_link_ids: tuple[str, ...] = ()
    notified_recipients: int = 0

    def as_payload(self) -> dict[str, Any]:
        return {
            "settings": self.settings.as_payload(),
            "changed": self.changed,
            "revoked_grant_ids": list(self.revoked_grant_ids),
            "revoked_link_ids": list(self.revoked_link_ids),
            "notified_recipients": self.notified_recipients,
        }


def _row_to_settings(user_id: str, row: dict[str, Any] | None) -> AccountSettings:
    if not row:
        return AccountSettings(user_id=user_id)
    return AccountSettings(
        user_id=user_id,
        sharing_state=str(row.get("sharing_state") or "unset"),
        precision=str(row.get("precision") or "precise"),
        sharing_consent_version=row.get("sharing_consent_version") or None,
        sharing_consent_accepted_at=_iso(row.get("sharing_consent_accepted_at")),
        sharing_enabled_at=_iso(row.get("sharing_enabled_at")),
        sharing_disabled_at=_iso(row.get("sharing_disabled_at")),
        os_permission_reported=str(row.get("os_permission_reported") or "unknown"),
        os_permission_reported_at=_iso(row.get("os_permission_reported_at")),
    )


class OneLocationAccountSettingsService:
    """Sync SQLAlchemy service, same executor style as the Location family."""

    def __init__(self, agent_service: OneLocationAgentService | None = None) -> None:
        self._agent_service = agent_service

    # -- reads ---------------------------------------------------------------

    def _execute_one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params)
        return result.data[0] if result.data else None

    def get(self, *, user_id: str) -> AccountSettings:
        row = self._execute_one(
            f"SELECT {_SETTINGS_COLUMNS} FROM one_location_account_settings WHERE user_id = :user_id",  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"user_id": user_id},
        )
        return _row_to_settings(user_id, row)

    # -- simple preference writes -------------------------------------------

    def _upsert(self, *, user_id: str, assignments: str, params: dict[str, Any]) -> AccountSettings:
        row = self._execute_one(
            """
            INSERT INTO one_location_account_settings (user_id, created_at, updated_at)
            VALUES (:user_id, NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
            RETURNING user_id
            """,
            {"user_id": user_id},
        )
        if row is None:
            raise OneLocationAgentError(
                "LOCATION_ACCOUNT_SETTINGS_WRITE_FAILED",
                "Location settings could not be saved.",
                status_code=500,
            )
        updated = self._execute_one(
            f"""
            UPDATE one_location_account_settings
            SET {assignments}, updated_at = NOW()
            WHERE user_id = :user_id
            RETURNING {_SETTINGS_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"user_id": user_id, **params},
        )
        return _row_to_settings(user_id, updated)

    def set_precision(self, *, user_id: str, precision: str) -> AccountSettings:
        if precision not in PRECISIONS:
            raise OneLocationAgentError(
                "LOCATION_PRECISION_INVALID",
                "Precision must be precise or approximate.",
                status_code=422,
            )
        return self._upsert(
            user_id=user_id, assignments="precision = :precision", params={"precision": precision}
        )

    def record_os_permission(self, *, user_id: str, state: str) -> AccountSettings:
        if state not in OS_PERMISSION_STATES:
            raise OneLocationAgentError(
                "LOCATION_OS_PERMISSION_INVALID", "OS permission state is invalid.", status_code=422
            )
        return self._upsert(
            user_id=user_id,
            assignments="os_permission_reported = :state, os_permission_reported_at = NOW()",
            params={"state": state},
        )

    def record_consent(self, *, user_id: str, consent_version: str) -> AccountSettings:
        version = str(consent_version or "").strip()
        if not version or len(version) > 80:
            raise OneLocationAgentError(
                "LOCATION_SHARING_CONSENT_INVALID",
                "Sharing consent version is invalid.",
                status_code=422,
            )
        return self._upsert(
            user_id=user_id,
            assignments=(
                "sharing_consent_version = :version, "
                "sharing_consent_accepted_at = COALESCE(one_location_account_settings.sharing_consent_accepted_at, NOW())"
            ),
            params={"version": version},
        )

    # -- the enforced transition -------------------------------------------

    def set_sharing_state(
        self,
        *,
        user_id: str,
        state: str,
        include_sos: bool = False,
        consent_version: str | None = None,
    ) -> SharingTransition:
        """Persist ``on``/``off`` and, for ``off``, stop sharing in the same transaction.

        ``on`` requires recorded consent (either already stored or passed in).
        ``off`` revokes every active owner grant outside the SOS lane (or all
        of them with ``include_sos``), revokes active public links, and sets
        map presence to ghost. Recipient notifications go out after commit.
        """
        if state not in {"on", "off"}:
            raise OneLocationAgentError(
                "LOCATION_SHARING_STATE_INVALID",
                "Sharing state must be on or off.",
                status_code=422,
            )
        agent = self._agent_service or OneLocationAgentService()
        database = get_db()
        engine = getattr(database, "engine", None)
        if engine is None:
            raise OneLocationAgentError(
                "LOCATION_ACCOUNT_SETTINGS_UNAVAILABLE",
                "Location settings storage is unavailable.",
                status_code=503,
            )
        revoked: list[dict[str, Any]] = []
        revoked_links: list[str] = []
        with engine.begin() as connection:
            locked = (
                connection.execute(
                    text(
                        """
                    INSERT INTO one_location_account_settings (user_id, created_at, updated_at)
                    VALUES (:user_id, NOW(), NOW())
                    ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
                    RETURNING sharing_state, sharing_consent_accepted_at
                    """
                    ),
                    {"user_id": user_id},
                )
                .mappings()
                .first()
            )
            current_state = str((locked or {}).get("sharing_state") or "unset")
            if state == "on":
                has_consent = bool((locked or {}).get("sharing_consent_accepted_at")) or bool(
                    str(consent_version or "").strip()
                )
                if not has_consent:
                    raise OneLocationAgentError(
                        "LOCATION_SHARING_CONSENT_REQUIRED",
                        "Accept location sharing consent before turning sharing on.",
                        status_code=409,
                    )
                row = (
                    connection.execute(
                        text(
                            f"""
                        UPDATE one_location_account_settings
                        SET sharing_state = 'on',
                            sharing_enabled_at = NOW(),
                            sharing_consent_version = COALESCE(:consent_version, sharing_consent_version),
                            sharing_consent_accepted_at = COALESCE(sharing_consent_accepted_at, NOW()),
                            updated_at = NOW()
                        WHERE user_id = :user_id
                        RETURNING {_SETTINGS_COLUMNS}
                        """  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
                        ),
                        {
                            "user_id": user_id,
                            "consent_version": (consent_version or "").strip() or None,
                        },
                    )
                    .mappings()
                    .first()
                )
                return SharingTransition(
                    settings=_row_to_settings(user_id, dict(row) if row else None),
                    changed=current_state != "on",
                )

            # state == "off": stop everything first, inside the same transaction.
            active_sos = (
                connection.execute(
                    text(
                        f"""
                    SELECT id FROM one_location_share_grants
                    WHERE owner_user_id = :owner_user_id AND status = 'active'
                    {_share_lane_match_sql()}
                    """  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
                    ),
                    {"owner_user_id": user_id, "is_sos_lane": True},
                )
                .mappings()
                .all()
            )
            if active_sos and not include_sos:
                raise OneLocationAgentError(
                    "LOCATION_SOS_ACTIVE",
                    "Save My Soul is active. Stop it explicitly before turning sharing off.",
                    status_code=409,
                )
            grant_rows = (
                connection.execute(
                    text(
                        """
                    SELECT id FROM one_location_share_grants
                    WHERE owner_user_id = :owner_user_id AND status = 'active'
                    ORDER BY created_at
                    """
                    ),
                    {"owner_user_id": user_id},
                )
                .mappings()
                .all()
            )
            agent._key_writer_connection = connection  # type: ignore[attr-defined]
            try:
                for grant in grant_rows:
                    transition = agent._revoke_grant_transition(
                        owner_user_id=user_id, grant_id=str(grant["id"])
                    )
                    if transition.get("changed"):
                        revoked.append(transition)
            finally:
                del agent._key_writer_connection  # type: ignore[attr-defined]
            link_rows = (
                connection.execute(
                    text(
                        """
                    UPDATE one_location_public_invites
                    SET status = 'revoked', updated_at = NOW()
                    WHERE owner_user_id = :owner_user_id AND status = 'active'
                    RETURNING id
                    """
                    ),
                    {"owner_user_id": user_id},
                )
                .mappings()
                .all()
            )
            revoked_links = [str(link["id"]) for link in link_rows]
            connection.execute(
                text(
                    """
                    INSERT INTO one_location_map_preferences (
                      user_id, presence_mode, created_at, updated_at
                    ) VALUES (:user_id, 'ghost', NOW(), NOW())
                    ON CONFLICT (user_id) DO UPDATE SET presence_mode = 'ghost', updated_at = NOW()
                    """
                ),
                {"user_id": user_id},
            )
            row = (
                connection.execute(
                    text(
                        f"""
                    UPDATE one_location_account_settings
                    SET sharing_state = 'off', sharing_disabled_at = NOW(), updated_at = NOW()
                    WHERE user_id = :user_id
                    RETURNING {_SETTINGS_COLUMNS}
                    """  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
                    ),
                    {"user_id": user_id},
                )
                .mappings()
                .first()
            )
            settings = _row_to_settings(user_id, dict(row) if row else None)

        notified = 0
        for transition in revoked:
            recipient_user_id = str(transition.get("recipient_user_id") or "")
            if not recipient_user_id:
                continue
            grant_row = transition["row"]
            owner_label = str(transition.get("owner_label") or "")
            revoked_via_sms = bool(transition.get("revoked_via_sms"))
            try:
                if agent._send_metadata_notification(
                    user_id=recipient_user_id,
                    notification_type="location_share_revoked",
                    title="SMS location sharing stopped"
                    if revoked_via_sms
                    else "Location access revoked",
                    body=(
                        f"{owner_label} stopped sharing their location with you over SMS."
                        if revoked_via_sms
                        else f"{owner_label} turned location sharing off."
                    ),
                    notification_tag=f"one-location-revoked:{grant_row.get('id')}",
                    request_url=_one_location_url(
                        grantId=str(grant_row.get("id")), section="people"
                    ),
                    data={
                        "grant_id": str(grant_row.get("id")),
                        "owner_user_id": user_id,
                        "owner_display_label": owner_label,
                        "recipient_user_id": recipient_user_id,
                        "recipient_display_label": str(transition.get("recipient_label") or ""),
                        "share_kind": str(transition.get("revoked_share_kind") or "standard"),
                    },
                ):
                    notified += 1
            except Exception:  # noqa: BLE001 - best effort after commit
                logger.warning("location.account_settings.notify_failed")
        return SharingTransition(
            settings=settings,
            changed=current_state != "off",
            revoked_grant_ids=tuple(str(t["row"].get("id")) for t in revoked),
            revoked_link_ids=tuple(revoked_links),
            notified_recipients=notified,
        )


__all__ = [
    "AccountSettings",
    "OneLocationAccountSettingsService",
    "SharingTransition",
]
