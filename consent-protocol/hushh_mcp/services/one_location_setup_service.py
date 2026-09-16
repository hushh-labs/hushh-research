"""Voice-first Location setup progress (migration 223).

A strict forward state machine. Consent is recorded strictly before the OS
permission step (also enforced by a table constraint); the recipient key is
verified server-side in ``one_location_recipient_keys`` before ``done``;
``done`` turns owner-level sharing on through the account-settings transition
so the two rows can never disagree.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from db.db_client import get_db
from hushh_mcp.services.one_location_account_settings_service import (
    OneLocationAccountSettingsService,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError

STEPS: tuple[str, ...] = ("intro", "consent", "os_permission", "precision", "recipient_key", "done")
OS_PERMISSION_STATES = ("unknown", "prompt", "granted", "denied")
PRECISIONS = ("precise", "approximate")

_COLUMNS = """
    user_id, step, consent_version, consent_accepted_at, os_permission_state, precision,
    recipient_key_registered_at, started_at, completed_at, updated_at
"""


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value else None


@dataclass(frozen=True)
class SetupProgress:
    user_id: str
    step: str = "intro"
    consent_version: str | None = None
    consent_accepted_at: str | None = None
    os_permission_state: str = "unknown"
    precision: str | None = None
    recipient_key_registered_at: str | None = None
    started_at: str | None = None
    completed_at: str | None = None

    @property
    def started(self) -> bool:
        return self.started_at is not None

    @property
    def completed(self) -> bool:
        return self.step == "done" and self.completed_at is not None

    @property
    def next_step(self) -> str | None:
        index = STEPS.index(self.step)
        return STEPS[index + 1] if index + 1 < len(STEPS) else None

    def as_payload(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["started"] = self.started
        payload["completed"] = self.completed
        payload["next_step"] = self.next_step
        payload["steps"] = list(STEPS)
        return payload


def _row(user_id: str, row: dict[str, Any] | None) -> SetupProgress:
    if not row:
        return SetupProgress(user_id=user_id)
    return SetupProgress(
        user_id=user_id,
        step=str(row.get("step") or "intro"),
        consent_version=row.get("consent_version") or None,
        consent_accepted_at=_iso(row.get("consent_accepted_at")),
        os_permission_state=str(row.get("os_permission_state") or "unknown"),
        precision=row.get("precision") or None,
        recipient_key_registered_at=_iso(row.get("recipient_key_registered_at")),
        started_at=_iso(row.get("started_at")),
        completed_at=_iso(row.get("completed_at")),
    )


class OneLocationSetupService:
    def __init__(self, settings: OneLocationAccountSettingsService | None = None) -> None:
        self._settings = settings

    @property
    def settings(self) -> OneLocationAccountSettingsService:
        if self._settings is None:
            self._settings = OneLocationAccountSettingsService()
        return self._settings

    def _execute_one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params)
        return result.data[0] if result.data else None

    def get(self, *, user_id: str) -> SetupProgress:
        return _row(
            user_id,
            self._execute_one(
                f"SELECT {_COLUMNS} FROM one_location_setup_progress WHERE user_id = :user_id",  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
                {"user_id": user_id},
            ),
        )

    def start(self, *, user_id: str) -> SetupProgress:
        """Idempotent: an existing run is returned at its current step."""
        row = self._execute_one(
            f"""
            INSERT INTO one_location_setup_progress (user_id, step, started_at, updated_at)
            VALUES (:user_id, 'intro', NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"user_id": user_id},
        )
        return _row(user_id, row)

    def _require_started(self, user_id: str) -> SetupProgress:
        progress = self.get(user_id=user_id)
        if not progress.started:
            raise OneLocationAgentError(
                "LOCATION_SETUP_NOT_STARTED", "Start Location setup first.", status_code=409
            )
        return progress

    def _advance_to(
        self, *, user_id: str, step: str, assignments: str, params: dict[str, Any]
    ) -> SetupProgress:
        row = self._execute_one(
            f"""
            UPDATE one_location_setup_progress
            SET step = :step, {assignments}, updated_at = NOW()
            WHERE user_id = :user_id
            RETURNING {_COLUMNS}
            """,  # nosec B608 - static column/assignment fragments; every value is a bound parameter.
            {"user_id": user_id, "step": step, **params},
        )
        return _row(user_id, row)

    def accept_consent(self, *, user_id: str, consent_version: str) -> SetupProgress:
        """Step intro → consent. Records the version the person accepted."""
        version = str(consent_version or "").strip()
        if not version or len(version) > 80:
            raise OneLocationAgentError(
                "LOCATION_SETUP_CONSENT_INVALID", "Consent version is invalid.", status_code=422
            )
        progress = self._require_started(user_id)
        if progress.step not in {"intro", "consent"}:
            return progress
        self.settings.record_consent(user_id=user_id, consent_version=version)
        return self._advance_to(
            user_id=user_id,
            step="consent",
            assignments=(
                "consent_version = :version, "
                "consent_accepted_at = COALESCE(consent_accepted_at, NOW())"
            ),
            params={"version": version},
        )

    def record_os_permission(self, *, user_id: str, state: str) -> SetupProgress:
        """Step consent → os_permission. Refused before consent, by rule and by constraint."""
        if state not in OS_PERMISSION_STATES:
            raise OneLocationAgentError(
                "LOCATION_OS_PERMISSION_INVALID", "OS permission state is invalid.", status_code=422
            )
        progress = self._require_started(user_id)
        if progress.consent_accepted_at is None:
            raise OneLocationAgentError(
                "LOCATION_SETUP_CONSENT_REQUIRED",
                "Accept the Location consent before the device permission prompt.",
                status_code=409,
            )
        self.settings.record_os_permission(user_id=user_id, state=state)
        step = (
            "os_permission"
            if STEPS.index(progress.step) <= STEPS.index("os_permission")
            else progress.step
        )
        return self._advance_to(
            user_id=user_id,
            step=step,
            assignments="os_permission_state = :state",
            params={"state": state},
        )

    def set_precision(self, *, user_id: str, precision: str) -> SetupProgress:
        """Step os_permission → precision."""
        if precision not in PRECISIONS:
            raise OneLocationAgentError(
                "LOCATION_PRECISION_INVALID",
                "Precision must be precise or approximate.",
                status_code=422,
            )
        progress = self._require_started(user_id)
        if STEPS.index(progress.step) < STEPS.index("os_permission"):
            raise OneLocationAgentError(
                "LOCATION_SETUP_STEP_ORDER",
                "Finish the device permission step before choosing precision.",
                status_code=409,
            )
        self.settings.set_precision(user_id=user_id, precision=precision)
        step = (
            "precision" if STEPS.index(progress.step) <= STEPS.index("precision") else progress.step
        )
        return self._advance_to(
            user_id=user_id,
            step=step,
            assignments="precision = :precision",
            params={"precision": precision},
        )

    def confirm_recipient_key(self, *, user_id: str) -> SetupProgress:
        """Step precision → recipient_key. Verified against the real key table."""
        progress = self._require_started(user_id)
        if STEPS.index(progress.step) < STEPS.index("precision"):
            raise OneLocationAgentError(
                "LOCATION_SETUP_STEP_ORDER",
                "Choose precision before registering a key.",
                status_code=409,
            )
        key_row = self._execute_one(
            """
            SELECT key_id FROM one_location_recipient_keys
            WHERE user_id = :user_id
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        if not key_row:
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_KEY_MISSING",
                "This device has not registered a location key yet.",
                status_code=409,
            )
        return self._advance_to(
            user_id=user_id,
            step="recipient_key",
            assignments="recipient_key_registered_at = COALESCE(recipient_key_registered_at, NOW())",
            params={},
        )

    def complete(self, *, user_id: str) -> SetupProgress:
        """Step recipient_key → done; turns owner-level sharing on."""
        progress = self._require_started(user_id)
        if progress.step == "done":
            return progress
        if progress.step != "recipient_key":
            raise OneLocationAgentError(
                "LOCATION_SETUP_STEP_ORDER", "Finish every setup step first.", status_code=409
            )
        self.settings.set_sharing_state(
            user_id=user_id, state="on", consent_version=progress.consent_version
        )
        return self._advance_to(
            user_id=user_id,
            step="done",
            assignments="completed_at = COALESCE(completed_at, NOW())",
            params={},
        )
