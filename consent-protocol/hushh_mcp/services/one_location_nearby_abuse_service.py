"""Shared abuse budgets for production Nearby Check-In.

Postgres is the only shared platform tier today. This adapter is deliberately
small so it can move to Redis/Memorystore without changing route or service
contracts when that tier becomes available.
"""

from __future__ import annotations

from dataclasses import dataclass

from db.db_client import get_db


class NearbyAbuseLimitError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Nearby request limit reached.")
        self.code = "NEARBY_RATE_LIMITED"
        self.message = "Too many Nearby requests. Wait a moment and try again."
        self.status_code = 429


@dataclass(frozen=True)
class NearbyAbuseBudget:
    limit: int
    window_seconds: int


_BUDGETS = {
    "admission": NearbyAbuseBudget(limit=6, window_seconds=60),
    "check_in": NearbyAbuseBudget(limit=6, window_seconds=60),
    "roster": NearbyAbuseBudget(limit=12, window_seconds=60),
    "connect": NearbyAbuseBudget(limit=10, window_seconds=60),
    "block": NearbyAbuseBudget(limit=12, window_seconds=60),
    "report": NearbyAbuseBudget(limit=4, window_seconds=60 * 60),
}


class OneLocationNearbyAbuseService:
    def consume(self, *, user_id: str, action: str) -> None:
        principal = str(user_id or "").strip()
        budget = _BUDGETS.get(str(action or "").strip())
        if not principal or budget is None:
            raise ValueError("valid principal and action are required")
        result = get_db().execute_raw(
            """
            INSERT INTO one_location_nearby_abuse_windows (
              principal_user_id,
              action,
              window_started_at,
              request_count,
              expires_at
            )
            VALUES (
              :user_id,
              :action,
              to_timestamp(
                floor(extract(epoch FROM NOW()) / :window_seconds)
                * :window_seconds
              ),
              1,
              to_timestamp(
                floor(extract(epoch FROM NOW()) / :window_seconds)
                * :window_seconds
              ) + (:window_seconds * INTERVAL '1 second')
            )
            ON CONFLICT (principal_user_id, action, window_started_at)
            DO UPDATE SET
              request_count = one_location_nearby_abuse_windows.request_count + 1,
              expires_at = EXCLUDED.expires_at
            WHERE one_location_nearby_abuse_windows.request_count < :request_limit
            RETURNING request_count
            """,
            {
                "user_id": principal,
                "action": action,
                "window_seconds": budget.window_seconds,
                "request_limit": budget.limit,
            },
        )
        if not result.data:
            raise NearbyAbuseLimitError()
