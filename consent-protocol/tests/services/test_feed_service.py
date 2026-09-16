from types import SimpleNamespace

from hushh_mcp.services.feed_service import POSTGRES_BIGINT_MAX, FeedService


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


class _Query:
    def __init__(self, *, data: list[dict] | None = None, count: int | None = None) -> None:
        self.data = data or []
        self.count = count
        self.calls: list[tuple] = []

    def _record(self, name: str, *args, **kwargs):
        self.calls.append((name, args, kwargs))
        return self

    def select(self, *args, **kwargs):
        return self._record("select", *args, **kwargs)

    def update(self, *args, **kwargs):
        return self._record("update", *args, **kwargs)

    def eq(self, *args, **kwargs):
        return self._record("eq", *args, **kwargs)

    def is_(self, *args, **kwargs):
        return self._record("is", *args, **kwargs)

    def lt(self, *args, **kwargs):
        return self._record("lt", *args, **kwargs)

    def lte(self, *args, **kwargs):
        return self._record("lte", *args, **kwargs)

    def order(self, *args, **kwargs):
        return self._record("order", *args, **kwargs)

    def limit(self, *args, **kwargs):
        return self._record("limit", *args, **kwargs)

    def execute(self):
        self.calls.append(("execute", (), {}))
        return SimpleNamespace(data=self.data, count=self.count)


class _QueuedDb:
    def __init__(self, *queries: _Query, raw_results: list[list[dict]] | None = None) -> None:
        self.queries = list(queries)
        self.raw_results = list(raw_results or [])
        self.opened: list[tuple[str, _Query]] = []
        self.raw_calls: list[tuple[str, dict]] = []

    def table(self, name: str) -> _Query:
        query = self.queries.pop(0)
        self.opened.append((name, query))
        return query

    def execute_raw(self, sql: str, params: dict):
        self.raw_calls.append((sql, params))
        data = self.raw_results.pop(0) if self.raw_results else []
        return SimpleNamespace(data=data)


def test_source_backed_feed_event_uses_idempotent_projection_insert() -> None:
    db = _Db()
    service = FeedService()
    service._db = db

    service.record_event(
        user_id="user-1",
        source_domain="location",
        event_type="location_circle_code_joined",
        actor_label="Ankit",
        metadata={
            "circle_id": "circle-1",
            "coordinates": {"latitude": 1.2, "longitude": 3.4},
            "access_token": "must-not-enter-feed",
        },
        source_row_id="circle_code:invite-1:user-2",
    )

    assert len(db.raw_calls) == 1
    sql, params = db.raw_calls[0]
    assert "ON CONFLICT DO NOTHING" in sql
    assert "ON CONFLICT (" not in sql
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


def test_list_feed_uses_bounded_keyset_pagination_and_exact_unread_count() -> None:
    list_query = _Query(
        data=[
            {"id": 10, "metadata": {}, "read_at": None},
            {"id": 9, "metadata": {}, "read_at": None},
            {"id": 8, "metadata": {}, "read_at": None},
        ]
    )
    count_query = _Query(count=41)
    service = FeedService()
    service._db = _QueuedDb(list_query, count_query)

    result = service.list_feed("user-1", cursor=11, limit=2)

    assert [item["id"] for item in result["items"]] == ["10", "9"]
    assert result["next_cursor"] == "9"
    assert result["unread_count"] == 41
    assert ("eq", ("user_id", "user-1"), {}) in list_query.calls
    assert (
        "select",
        ("id,source_domain,event_type,actor_label,metadata,source_row_id,read_at,created_at",),
        {},
    ) in list_query.calls
    assert ("lt", ("id", 11), {}) in list_query.calls
    assert ("order", ("id",), {"desc": True}) in list_query.calls
    assert ("limit", (3,), {}) in list_query.calls
    assert ("select", ("id",), {"count": "exact"}) in count_query.calls
    assert ("limit", (0,), {}) in count_query.calls


def test_mark_read_is_tenant_scoped_and_never_unbounded() -> None:
    update_query = _Query()
    service = FeedService()
    service._db = _QueuedDb(update_query)

    assert service.mark_read("user-1", up_to_id=POSTGRES_BIGINT_MAX) == {"status": "ok"}

    assert ("eq", ("user_id", "user-1"), {}) in update_query.calls
    assert ("is", ("read_at", None), {}) in update_query.calls
    assert (
        "lte",
        ("id", POSTGRES_BIGINT_MAX),
        {},
    ) in update_query.calls


def test_feed_projection_allows_only_bounded_renderer_metadata() -> None:
    row = {
        "id": 1,
        "source_domain": "location",
        "event_type": "location_access_request",
        "actor_label": f"  {'A' * 200}  ",
        "metadata": {
            "counterpart_label": f"  {'B' * 300}  ",
            "counterpart_photo_url": f"  https://cdn.example.test/{'p' * 1200}.jpg  ",
            "phone_number": "+1 555 010 1234",
            "requester_masked_phone": "***1234",
            "requested_duration_hours": 3,
            "is_extension": True,
            "coordinates": {"latitude": 1.2, "longitude": 3.4},
            "ciphertext": "secret",
            "access_token": "secret",
            "account_id": "sensitive-account",
            "counterpart_user_id": "private-user-id",
            "not_a_number": float("nan"),
        },
        "read_at": None,
        "created_at": "2026-08-26T00:00:00Z",
    }

    item = FeedService._to_item(row)

    assert item["actor_label"] == "A" * 160
    assert item["metadata"] == {
        "counterpart_label": "B" * 256,
        "counterpart_photo_url": f"https://cdn.example.test/{'p' * 999}",
        "requested_duration_hours": 3,
        "is_extension": True,
    }


def test_list_feed_enriches_connection_rows_with_counterpart_photo() -> None:
    list_query = _Query(
        data=[
            {
                "id": 10,
                "source_domain": "connections",
                "event_type": "connection_accepted",
                "actor_label": None,
                "metadata": {"counterpart_label": "Kushal Trivedi"},
                "source_row_id": "11111111-1111-4111-8111-111111111111",
                "read_at": None,
                "created_at": "2026-08-31T10:00:00Z",
            }
        ]
    )
    count_query = _Query(count=1)
    service = FeedService()
    service._db = _QueuedDb(
        list_query,
        count_query,
        raw_results=[
            [
                {
                    "source_row_id": "11111111-1111-4111-8111-111111111111",
                    "counterpart_photo_url": "https://cdn.example.test/kushal.jpg",
                }
            ]
        ],
    )

    result = service.list_feed("viewer-user", limit=20)

    assert result["items"][0]["metadata"]["counterpart_photo_url"] == (
        "https://cdn.example.test/kushal.jpg"
    )
    assert "connection_requests" in service._db.raw_calls[0][0]
    assert "counterpart_user_id" not in result["items"][0]["metadata"]


def test_list_feed_enriches_location_grant_rows_with_counterpart_photo() -> None:
    grant_id = "22222222-2222-4222-8222-222222222222"
    list_query = _Query(
        data=[
            {
                "id": 12,
                "source_domain": "location",
                "event_type": "location_share_expired",
                "actor_label": None,
                "metadata": {"counterpart_label": "Ankit Kumar Singh"},
                "source_row_id": f"{grant_id}:operation:client-op",
                "read_at": None,
                "created_at": "2026-08-31T11:00:00Z",
            }
        ]
    )
    count_query = _Query(count=1)
    service = FeedService()
    service._db = _QueuedDb(
        list_query,
        count_query,
        raw_results=[
            [
                {
                    "source_row_id": grant_id,
                    "counterpart_photo_url": "https://cdn.example.test/ankit.jpg",
                }
            ]
        ],
    )

    result = service.list_feed("viewer-user", limit=20)

    assert result["items"][0]["metadata"]["counterpart_photo_url"] == (
        "https://cdn.example.test/ankit.jpg"
    )
    assert "one_location_share_grants" in service._db.raw_calls[0][0]
