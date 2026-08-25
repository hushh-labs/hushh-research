from types import SimpleNamespace

from hushh_mcp.services.feed_service import FeedService


class _Db:
    def __init__(self) -> None:
        self.raw_calls: list[tuple[str, dict]] = []
        self.inserted: list[dict] = []

    def execute_raw(self, sql: str, params: dict):
        self.raw_calls.append((sql, params))
        return SimpleNamespace(data=[])

    def table(self, _name: str):
        return self

    def insert(self, payload: dict):
        self.inserted.append(payload)
        return self

    def execute(self):
        return SimpleNamespace(data=[])


def test_source_backed_feed_event_uses_idempotent_projection_insert() -> None:
    db = _Db()
    service = FeedService()
    service._db = db

    service.record_event(
        user_id="user-1",
        source_domain="location",
        event_type="location_circle_code_joined",
        actor_label="Ankit",
        metadata={"circle_id": "circle-1"},
        source_row_id="circle_code:invite-1:user-2",
    )

    assert len(db.raw_calls) == 1
    sql, params = db.raw_calls[0]
    assert "ON CONFLICT" in sql
    assert "WHERE source_row_id IS NOT NULL DO NOTHING" in sql
    assert params["source_row_id"] == "circle_code:invite-1:user-2"
    assert params["metadata_json"] == '{"circle_id": "circle-1"}'
    assert db.inserted == []


def test_legacy_feed_event_without_source_id_keeps_append_only_insert() -> None:
    db = _Db()
    service = FeedService()
    service._db = db

    service.record_event(
        user_id="user-1",
        source_domain="kai",
        event_type="kai_analysis_completed",
    )

    assert db.raw_calls == []
    assert db.inserted == [
        {
            "user_id": "user-1",
            "source_domain": "kai",
            "event_type": "kai_analysis_completed",
            "actor_label": None,
            "metadata": {},
        }
    ]
