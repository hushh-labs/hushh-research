from __future__ import annotations

import logging
from typing import TypedDict

from db.db_client import get_db

logger = logging.getLogger(__name__)


class InsightFeedbackAggregatesDict(TypedDict):
    thumbs_up_count: int
    thumbs_down_count: int
    total_count: int


class InsightFeedbackRecordDict(TypedDict):
    success: bool
    message: str
    aggregates: InsightFeedbackAggregatesDict


class InsightFeedbackServiceError(RuntimeError):
    status_code = 500


class InsightFeedbackDuplicateError(InsightFeedbackServiceError):
    status_code = 409


class InsightFeedbackPersistenceError(InsightFeedbackServiceError):
    status_code = 500


class InsightFeedbackService:
    """Persists and summarizes user feedback for AI-generated stock insights."""

    _DUPLICATE_WINDOW_SECONDS = 30

    def create_feedback(
        self,
        *,
        user_id: str,
        stock: str,
        insight: str,
        confidence: float,
        rating: str,
    ) -> InsightFeedbackRecordDict:
        db = get_db()

        duplicate_sql = """
            SELECT feedback_id::text AS feedback_id, created_at
            FROM ai_insight_feedback
            WHERE user_id = :user_id
              AND stock = :stock
              AND insight = :insight
                            AND created_at >= NOW() - make_interval(secs => :duplicate_window_seconds)
            ORDER BY created_at DESC
            LIMIT 1
        """

        duplicate_result = db.execute_raw(
            duplicate_sql,
            {
                "user_id": user_id,
                "stock": stock,
                "insight": insight,
                "duplicate_window_seconds": self._DUPLICATE_WINDOW_SECONDS,
            },
        )
        if duplicate_result.error:
            logger.error(
                "Insight feedback duplicate check failed for %s/%s: %s",
                user_id,
                stock,
                duplicate_result.error,
            )
            raise InsightFeedbackPersistenceError("Failed to validate recent feedback submissions")

        if duplicate_result.data:
            logger.info("Duplicate insight feedback blocked for user=%s stock=%s", user_id, stock)
            raise InsightFeedbackDuplicateError(
                "Feedback was already submitted recently for this insight. Please wait a moment and try again."
            )

        sql = """
            INSERT INTO ai_insight_feedback (
                user_id,
                stock,
                insight,
                confidence,
                rating,
                created_at,
                updated_at
            )
            VALUES (
                :user_id,
                :stock,
                :insight,
                :confidence,
                :rating,
                NOW(),
                NOW()
            )
            RETURNING feedback_id::text AS feedback_id, created_at
        """

        result = db.execute_raw(
            sql,
            {
                "user_id": user_id,
                "stock": stock,
                "insight": insight,
                "confidence": confidence,
                "rating": rating,
            },
        )

        if result.error:
            logger.error(
                "Insight feedback insert failed for %s/%s: %s",
                user_id,
                stock,
                result.error,
            )
            raise InsightFeedbackPersistenceError("Failed to store insight feedback")

        row = result.data[0] if result.data else None
        if not row or not row.get("feedback_id") or not row.get("created_at"):
            raise InsightFeedbackPersistenceError("Insight feedback insert did not return a persisted row")

        aggregates = self.get_feedback_aggregates(stock=stock)

        logger.info(
            "Insight feedback stored for user=%s stock=%s rating=%s feedback_id=%s",
            user_id,
            stock,
            rating,
            row["feedback_id"],
        )

        return {
            "success": True,
            "message": "Insight feedback recorded.",
            "aggregates": aggregates,
        }

    def get_feedback_aggregates(self, *, stock: str) -> InsightFeedbackAggregatesDict:
        db = get_db()

        sql = """
            SELECT
                COALESCE(COUNT(*) FILTER (WHERE rating = 'up'), 0)::integer AS thumbs_up_count,
                COALESCE(COUNT(*) FILTER (WHERE rating = 'down'), 0)::integer AS thumbs_down_count,
                COUNT(*)::integer AS total_count
            FROM ai_insight_feedback
            WHERE stock = :stock
        """

        result = db.execute_raw(sql, {"stock": stock})

        if result.error:
            logger.error("Insight feedback aggregate lookup failed for %s: %s", stock, result.error)
            raise InsightFeedbackPersistenceError("Failed to load insight feedback aggregates")

        row = result.data[0] if result.data else None
        return {
            "thumbs_up_count": int(row.get("thumbs_up_count") or 0) if row else 0,
            "thumbs_down_count": int(row.get("thumbs_down_count") or 0) if row else 0,
            "total_count": int(row.get("total_count") or 0) if row else 0,
        }

    def record_feedback(
        self,
        *,
        user_id: str,
        stock: str,
        insight: str,
        confidence: float,
        rating: str,
    ) -> InsightFeedbackRecordDict:
        return self.create_feedback(
            user_id=user_id,
            stock=stock,
            insight=insight,
            confidence=confidence,
            rating=rating,
        )


_insight_feedback_service: InsightFeedbackService | None = None


def get_insight_feedback_service() -> InsightFeedbackService:
    global _insight_feedback_service
    if _insight_feedback_service is None:
        _insight_feedback_service = InsightFeedbackService()
    return _insight_feedback_service
