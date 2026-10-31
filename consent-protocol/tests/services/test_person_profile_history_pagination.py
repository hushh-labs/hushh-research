"""Bundle-level history pagination for a viewer-relative person profile."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)

SUBJECT_REF = "11111111-1111-4111-8111-111111111111"
OTHER_REF = "22222222-2222-4222-8222-222222222222"


class _BundleHistoryDB:
    def __init__(self) -> None:
        self.bundles = [
            {
                "bundle_id": f"00000000-0000-4000-8000-{number:012d}",
                "purpose": f"Request {number}",
                "duration_seconds": 3600,
                "created_at": datetime.fromisoformat(created_at),
                "cancelled_at": None,
                "item_count": item_count,
                "viewer": "viewer",
                "subject": "subject",
            }
            for number, created_at, item_count in [
                (1, "2026-09-20T10:00:00+00:00", 150),
                (2, "2026-09-20T10:00:00+00:00", 2),
                (3, "2026-09-19T10:00:00+00:00", 1),
            ]
        ]
        self.history_queries: list[tuple[str, dict]] = []

    def execute_raw(self, sql: str, params: dict):
        if "FROM actor_profiles profile" in sql:
            if params["public_person_ref"] not in {SUBJECT_REF, OTHER_REF}:
                return SimpleNamespace(data=[])
            return SimpleNamespace(
                data=[
                    {
                        "user_id": "subject",
                        "public_person_ref": params["public_person_ref"],
                    }
                ]
            )
        assert "FROM one_information_request_bundles bundle" in sql
        self.history_queries.append((sql, params.copy()))
        rows = [
            row
            for row in self.bundles
            if row["viewer"] == params["viewer"] and row["subject"] == params["subject"]
        ]
        if "cursor_created_at" in params:
            rows = [
                row
                for row in rows
                if (row["created_at"], row["bundle_id"])
                < (params["cursor_created_at"], params["cursor_bundle_id"])
            ]
        rows.sort(key=lambda row: (row["created_at"], row["bundle_id"]), reverse=True)
        return SimpleNamespace(data=rows[: params["fetch_limit"]])


def _service() -> PersonProfileService:
    return PersonProfileService(connections=object(), consent_db=object())


@pytest.mark.asyncio
async def test_history_pages_whole_bundles_with_ties_and_more_than_100_items() -> None:
    db = _BundleHistoryDB()
    service = _service()
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        first = await service.get_request_history_page(
            viewer_user_id="viewer", public_person_ref=SUBJECT_REF, limit=1
        )
        second = await service.get_request_history_page(
            viewer_user_id="viewer",
            public_person_ref=SUBJECT_REF,
            limit=1,
            cursor=first["nextCursor"],
        )
        third = await service.get_request_history_page(
            viewer_user_id="viewer",
            public_person_ref=SUBJECT_REF,
            limit=1,
            cursor=second["nextCursor"],
        )
    assert [page["bundles"][0]["bundleId"] for page in (first, second, third)] == [
        db.bundles[1]["bundle_id"],
        db.bundles[0]["bundle_id"],
        db.bundles[2]["bundle_id"],
    ]
    assert [page["bundles"][0]["itemCount"] for page in (first, second, third)] == [2, 150, 1]
    assert third["nextCursor"] is None
    assert all(params["fetch_limit"] == 2 for _, params in db.history_queries)
    assert all("JOIN one_information_request_items" not in sql for sql, _ in db.history_queries)
    assert all(
        "COUNT(*) FROM one_information_request_items" in sql for sql, _ in db.history_queries
    )
    assert all("bundle.requester_user_id = :viewer" in sql for sql, _ in db.history_queries)
    assert all("bundle.subject_user_id = :subject" in sql for sql, _ in db.history_queries)
    assert "(bundle.created_at, bundle.bundle_id) <" in db.history_queries[1][0]


@pytest.mark.asyncio
async def test_history_rejects_foreign_viewer_self_and_invalid_cursors() -> None:
    db = _BundleHistoryDB()
    service = _service()
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        first = await service.get_request_history_page(
            viewer_user_id="viewer", public_person_ref=SUBJECT_REF, limit=1
        )
        foreign = await service.get_request_history_page(
            viewer_user_id="stranger", public_person_ref=SUBJECT_REF
        )
        assert foreign == {"bundles": [], "nextCursor": None}
        for person_ref, cursor in [(OTHER_REF, first["nextCursor"]), (SUBJECT_REF, "invalid!")]:
            with pytest.raises(ValueError, match="cursor"):
                await service.get_request_history_page(
                    viewer_user_id="viewer", public_person_ref=person_ref, cursor=cursor
                )
        with pytest.raises(ValueError, match="limit"):
            await service.get_request_history_page(
                viewer_user_id="viewer", public_person_ref=SUBJECT_REF, limit=51
            )
        with pytest.raises(PersonProfileNotFoundError):
            await service.get_request_history_page(
                viewer_user_id="subject", public_person_ref=SUBJECT_REF
            )
        with pytest.raises(PersonProfileNotFoundError):
            await service.get_request_history_page(
                viewer_user_id="viewer", public_person_ref="33333333-3333-4333-8333-333333333333"
            )
    assert all(params["viewer"] in {"viewer", "stranger"} for _, params in db.history_queries)
