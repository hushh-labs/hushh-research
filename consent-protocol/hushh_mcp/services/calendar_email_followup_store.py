"""Durable owner/account-scoped follow-up store facade; no full email body is stored."""

from __future__ import annotations

from typing import Any

from db.db_client import get_db
from hushh_mcp.services.calendar_email_followup_crypto import FollowupCipher
from hushh_mcp.services.calendar_email_followup_store_due import _DueClaims, _DueQueue
from hushh_mcp.services.calendar_email_followup_store_ingest import _MessageIngest
from hushh_mcp.services.calendar_email_followup_store_monitor import _MonitorConfig, _MonitorState
from hushh_mcp.services.calendar_email_followup_store_outcomes import (
    ScannedState as ScannedState,
)
from hushh_mcp.services.calendar_email_followup_store_outcomes import _ScanOutcomes
from hushh_mcp.services.calendar_email_followup_store_requests import _RequestMutate, _RequestRead
from hushh_mcp.services.calendar_email_followup_store_types import (
    DueClaim as DueClaim,
)
from hushh_mcp.services.calendar_email_followup_store_types import (
    FollowupStateError as FollowupStateError,
)
from hushh_mcp.services.calendar_email_followup_store_types import (
    Monitor as Monitor,
)
from hushh_mcp.services.calendar_email_followup_store_types import (
    candidate_reminder_at as candidate_reminder_at,
)


class CalendarEmailFollowupStore(
    _MonitorState,
    _MonitorConfig,
    _RequestRead,
    _RequestMutate,
    _DueClaims,
    _DueQueue,
    _MessageIngest,
    _ScanOutcomes,
):
    def __init__(self, *, db: Any = None, cipher: FollowupCipher | None = None) -> None:
        self.db = db or get_db()
        self.cipher = cipher or FollowupCipher()

    def _seal(self, value: Any, monitor: Monitor, row: str, purpose: str) -> str:
        return self.cipher.seal(
            value, owner=monitor.user_id, account_id=monitor.account_id, row=row, purpose=purpose
        )

    def _open(self, value: str, monitor: Monitor, row: str, purpose: str) -> Any:
        return self.cipher.open(
            value, owner=monitor.user_id, account_id=monitor.account_id, row=row, purpose=purpose
        )
