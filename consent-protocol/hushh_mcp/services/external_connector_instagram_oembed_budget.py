"""Shared, app-wide Instagram oEmbed request budget for production.

Production already has Cloud SQL but no shared Redis. Reserve before every
provider request so Cloud Run workers and instances cannot multiply Meta's
1,000 request/hour allowance. Production's 12/minute and UAT's 4/minute
allow at most 976 combined in any rolling 60-minute span, even across a
fixed-minute boundary.
"""

from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db


class InstagramOEmbedBudgetUnavailable(RuntimeError):
    """The shared quota cannot be enforced; no provider request may proceed."""


class InstagramOEmbedBudget:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def reserve(self) -> bool:
        """Atomically reserve one request in the current database-clock minute."""

        def transact() -> bool:
            try:
                with self.db.engine.begin() as connection:
                    connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                    connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                    # Opportunistic bounded retention. The table contains only
                    # aggregate counts, with no account or post identifiers.
                    connection.execute(
                        text("""
                        WITH stale AS (
                          SELECT bucket_start
                          FROM instagram_oembed_request_budgets
                          WHERE bucket_start < NOW() - INTERVAL '2 hours'
                          ORDER BY bucket_start
                          LIMIT 100
                          FOR UPDATE SKIP LOCKED
                        )
                        DELETE FROM instagram_oembed_request_budgets AS budget
                        USING stale
                        WHERE budget.bucket_start = stale.bucket_start
                        """)
                    )
                    row = connection.execute(
                        text("""
                        INSERT INTO instagram_oembed_request_budgets (
                          bucket_start, request_count
                        ) VALUES (date_trunc('minute', NOW()), 1)
                        ON CONFLICT (bucket_start) DO UPDATE SET
                          request_count = instagram_oembed_request_budgets.request_count + 1
                        WHERE instagram_oembed_request_budgets.request_count < 12
                        RETURNING request_count
                        """)
                    ).first()
                    return row is not None
            except SQLAlchemyError:
                raise InstagramOEmbedBudgetUnavailable("oembed_quota_unavailable") from None

        return await asyncio.to_thread(transact)
