"""Owner-scoped activity retrieval over the canonical Feed projection.

The ports reuse Feed's existing source authorization and presentation adapters.
No workflow, payment or vault authority is stored by this reader.
"""

from __future__ import annotations

from typing import Any, Callable, Unpack

from db.db_client import DatabaseClient
from hushh_mcp.services.feed_search_contract import FeedSearchCriteria

Row = dict[str, Any]
Presenter = Callable[[str, list[Row]], list[Row]]


class FeedActivityReader:
    def __init__(
        self,
        *,
        cte: str,
        db: DatabaseClient,
        present: Presenter,
        photos: Presenter,
        item: Callable[[Row, str], Row],
        max_limit: int,
        has_counterparts: bool = False,
    ):
        self._cte, self._db = cte, db
        self._present, self._photos, self._item = present, photos, item
        self._max_limit = max_limit
        self._has_counterparts = has_counterparts

    def search_activity(
        self, user_id: str, **criteria: Unpack[FeedSearchCriteria]
    ) -> dict[str, Any]:
        from hushh_mcp.services.feed_search_reader import search_history

        return search_history(self, user_id, **criteria)

    def operation_detail(
        self, user_id: str, *, item_id: int, before_id: int | None = None
    ) -> dict[str, Any] | None:
        """The exact owner's operation and its recorded milestones, without action authority."""
        cte = self._cte
        rows = (
            self._db.execute_raw(
                cte
                + """
            SELECT milestone.* FROM keyed target
            JOIN grouped current ON current.thread_key = target.thread_key
            JOIN keyed milestone ON milestone.thread_key = current.thread_key
            WHERE target.id = :item_id AND target.dismissed_at IS NULL
              AND milestone.dismissed_at IS NULL
              AND (current.last_dismissed_id IS NULL OR
                (target.id > current.last_dismissed_id AND milestone.id > current.last_dismissed_id))
              AND (CAST(:before_id AS bigint) IS NULL OR (milestone.created_at,milestone.id) < (
                SELECT created_at,id FROM keyed anchor WHERE anchor.id=:before_id
                  AND anchor.thread_key=current.thread_key AND anchor.dismissed_at IS NULL))
            ORDER BY milestone.created_at DESC, milestone.id DESC LIMIT 101
        """,
                {"user_id": user_id, "item_id": item_id, "before_id": before_id},
            ).data
            or []
        )
        if not rows:
            return None
        # Group ranking, not a new interpretation of source prose, owns the headline.
        current = (
            self._db.execute_raw(
                cte
                + """
            SELECT current.* FROM keyed target JOIN grouped current ON current.thread_key = target.thread_key
            WHERE target.id = :item_id AND target.dismissed_at IS NULL
              AND (current.last_dismissed_id IS NULL OR target.id > current.last_dismissed_id)
        """,
                {"user_id": user_id, "item_id": item_id},
            ).data
            or []
        )
        if not current:
            return None
        shown = self._present(user_id, current)[0]
        milestones = [self._item(row, user_id) for row in self._photos(user_id, rows[:100])]
        return {
            "item": self._item(shown, user_id),
            "milestones": milestones,
            "more_milestones": len(rows) > 100,
            "next_cursor": str(rows[99]["id"]) if len(rows) > 100 else None,
            "state_source": "recorded_domain_outcomes",
        }

    def attention_items(self, user_id: str, item_ids: list[int]) -> dict[str, dict[str, Any]]:
        """Only currently admitted unread representatives may produce attention.

        Read bounded Feed metadata without decrypting source content or invoking
        presentation adapters. Dedicated emergency pushes remain separate.
        """
        if not item_ids:
            return {}
        cte = self._cte
        rows = (
            self._db.execute_raw(
                cte
                + """
            SELECT * FROM grouped WHERE id=ANY(CAST(:item_ids AS bigint[]))
              AND displayed_unread_count>0
        """,
                {"user_id": user_id, "item_ids": item_ids[:200]},
            ).data
            or []
        )
        return {str(row["id"]): self._item(row, user_id) for row in rows}

    def _operation_rows_for_dismissal(self, user_id: str, item_id: int) -> list[int]:
        # Older schemas without domain references retain their existing reader.
        cte = self._cte
        rows = (
            self._db.execute_raw(
                cte
                + """
            SELECT member.id FROM keyed target
            JOIN grouped shown ON shown.thread_key=target.thread_key
            JOIN keyed member ON member.thread_key=target.thread_key
            WHERE target.id=:item_id AND target.dismissed_at IS NULL
              AND member.dismissed_at IS NULL AND member.id<=:item_id
        """,
                {"user_id": user_id, "item_id": item_id},
            ).data
            or []
        )
        return [int(row["id"]) for row in rows]
