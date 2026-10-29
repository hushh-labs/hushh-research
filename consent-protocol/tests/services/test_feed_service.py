import base64
import itertools
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

import hushh_mcp.services.feed_service as feed_service_module
from hushh_mcp.services.direct_messages_service import DirectMessagesError
from hushh_mcp.services.feed_drive_fold import (
    drive_rows_revealed_by_removal,
    hidden_drive_item_ids,
)
from hushh_mcp.services.feed_service import (
    POSTGRES_BIGINT_MAX,
    FeedService,
    _safe_photo_url,
)


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
        if "AS history_revision" in sql:
            data = [{"history_revision": "fixture-history-revision"}]
        elif sql.startswith("\nWITH keyed"):
            query = self.queries.pop(0)
            data = (
                [{"unread_count": query.count}]
                if "SELECT count(*) AS unread_count" in sql
                else query.data
            )
        else:
            data = self.raw_results.pop(0) if self.raw_results else []
        return SimpleNamespace(data=data)


_DIRECT_MESSAGE_ID = "11111111-1111-4111-8111-111111111111"
_DIRECT_MESSAGE_CONVERSATION_ID = "22222222-2222-4222-8222-222222222222"


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


def test_profile_discovery_feed_projection_accepts_only_generic_status_metadata() -> None:
    db = _Db()
    service = FeedService()
    service._db = db

    service.record_event(
        user_id="user-1",
        source_domain="profile_discovery",
        event_type="profile_discovery_ready",
        metadata={
            "user_facing_status": "ready",
            "claim": "private public-web finding",
            "source_url": "https://example.invalid/person",
        },
        source_row_id="opaque-job:3",
    )

    assert len(db.raw_calls) == 1
    _, params = db.raw_calls[0]
    assert params["source_domain"] == "profile_discovery"
    assert params["metadata_json"] == '{"user_facing_status": "ready"}'


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
    assert result["history_revision"] == "fixture-history-revision"
    assert service._db.raw_calls[0][1] == {"user_id": "user-1"}
    sql, params = service._db.raw_calls[1]
    assert params == {"user_id": "user-1", "cursor": 11, "page_size": 3}
    assert "FROM grouped WHERE" in sql
    assert "row_number() OVER (PARTITION BY thread_key ORDER BY id DESC)" in sql
    assert "LIMIT :page_size" in sql
    assert "COALESCE(f.metadata->>'pwm_outcome', '') NOT IN ('ready', 'partial')" in sql
    assert (
        "COALESCE(f.metadata->>'pwm_outcome', '') NOT IN ('ready', 'partial')"
        in service._db.raw_calls[-1][0]
    )
    assert service._db.raw_calls[-1][1] == {"user_id": "user-1"}


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


def test_feed_mutations_only_touch_the_owner_and_snapshot() -> None:
    db = _Db()
    service = FeedService()
    service._db = db

    assert service.dismiss("owner-a", item_id=42) == {
        "status": "ok",
        "dismissal_token": None,
        "dismissed_ids": [],
    }
    expected_token = "11111111-1111-4111-8111-111111111111"
    assert service.restore("owner-a", item_id=42, dismissal_token=expected_token) == {
        "status": "ok",
        "restored": False,
    }
    assert service.clear("owner-a", up_to_id=99) == {"status": "ok"}

    # Every read and write is bound to the owner and the requested row/snapshot.
    params = [values for _, values in db.raw_calls]
    assert [
        {key: value for key, value in entry.items() if key != "dismissal_token"} for entry in params
    ] == [
        {"user_id": "owner-a", "item_id": 42},
        {"user_id": "owner-a", "item_id": 42, "surfacing_ids": []},
        {"user_id": "owner-a", "item_id": 42},
        {"user_id": "owner-a", "up_to_id": 99},
        {"user_id": "owner-a", "up_to_id": 99, "surfacing_ids": []},
    ]
    assert str(UUID(params[1]["dismissal_token"])) == params[1]["dismissal_token"]
    assert params[2]["dismissal_token"] == expected_token
    assert str(UUID(params[4]["dismissal_token"])) == params[4]["dismissal_token"]
    _, dismiss_sql, restore_sql, _, clear_sql = [sql for sql, _ in db.raw_calls]
    assert "WHERE user_id = :user_id AND id = :item_id" in dismiss_sql
    assert "WHERE user_id = :user_id AND id = :item_id" in restore_sql
    assert "item.user_id = :user_id" in dismiss_sql
    assert "item.user_id = :user_id" in restore_sql
    assert "item.metadata->>'bundle_id' = target.bundle_id" in dismiss_sql
    assert "item.id <= :item_id" in dismiss_sql
    assert "WHERE user_id = :user_id AND (id <= :up_to_id" in clear_sql
    assert "read_at = COALESCE(item.read_at, now())" in dismiss_sql
    assert "RETURNING id, dismissal_token" in dismiss_sql
    assert "item.dismissal_token = :dismissal_token" in restore_sql
    assert "read_at = COALESCE(read_at, now())" in clear_sql
    assert "SET dismissed_at = NULL" in restore_sql
    assert "dismissal_token = :dismissal_token" in clear_sql


def test_grouped_feed_hides_latest_dismissed_thread_until_new_activity() -> None:
    sql = FeedService()._grouped_feed_sql(count=False)
    assert "row_number() OVER (PARTITION BY thread_key ORDER BY id DESC)" in sql
    assert "thread_rank = 1 AND dismissed_at IS NULL" in sql
    assert "last_dismissed_id IS NULL OR id > last_dismissed_id" in sql


class _SqliteFeedDb:
    """Runs FeedService's own mutation SQL on sqlite, as psycopg2 runs it on Postgres.

    sqlite has no array type, so only the ``= ANY(CAST(:ids AS BIGINT[]))``
    membership test is mapped to ``json_each``; everything else in each
    statement runs verbatim. JSON metadata is decoded on read, as psycopg2
    decodes JSONB. tests/test_feed_account_session_postgres.py runs the same
    statements on PostgreSQL.
    """

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def execute_raw(self, sql: str, params: dict):
        params = dict(params)
        for name, value in list(params.items()):
            marker = f"= ANY(CAST(:{name} AS BIGINT[]))"
            if marker in sql:
                sql = sql.replace(marker, f"IN (SELECT value FROM json_each(:{name}))")
                params[name] = json.dumps(value)
        cursor = self.connection.execute(sql, params)
        data = (
            [
                dict(zip([column[0] for column in cursor.description], row, strict=True))
                for row in cursor.fetchall()
            ]
            if cursor.description
            else []
        )
        for row in data:
            if isinstance(row.get("metadata"), str):
                row["metadata"] = json.loads(row["metadata"])
        self.connection.commit()
        return SimpleNamespace(data=data)


def _sqlite_feed(
    rows: list[tuple[int, str, str, str, dict]],
    *,
    stamp: list[str],
    payment_status: dict[str, str] | None = None,
) -> tuple[sqlite3.Connection, FeedService]:
    connection = sqlite3.connect(":memory:")
    connection.create_function("now", 0, lambda: stamp[0])
    connection.execute(
        "CREATE TABLE feed_events(id INTEGER PRIMARY KEY,user_id TEXT,source_domain TEXT,"
        "event_type TEXT,metadata TEXT,dismissed_at TEXT,dismissal_token TEXT,read_at TEXT)"
    )
    connection.executemany(
        "INSERT INTO feed_events(id,user_id,source_domain,event_type,metadata) VALUES(?,?,?,?,?)",
        [(*row[:4], json.dumps(row[4])) for row in rows],
    )
    service = FeedService()
    service._db = _SqliteFeedDb(connection)
    statuses = payment_status or {}

    def current_payment_status(_user_id: str, feed_rows: list[dict]) -> list[dict]:
        # Stands in for the read-time order status the Feed list puts on Pay rows.
        return [
            {
                **row,
                "metadata": {
                    **row["metadata"],
                    "current_payment_status": statuses.get(
                        row["metadata"].get("request_id"), "unavailable"
                    ),
                },
            }
            if row.get("event_type") == "document_share_payment_ready"
            else row
            for row in feed_rows
        ]

    service._with_drive_payment_status = current_payment_status  # type: ignore[method-assign]
    return connection, service


def _dismissed_with(connection: sqlite3.Connection, stamp: str) -> list[int]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE dismissed_at = ? ORDER BY id", (stamp,)
        )
    ]


def _live_ids(connection: sqlite3.Connection, user_id: str) -> list[int]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE user_id = ? AND dismissed_at IS NULL ORDER BY id",
            (user_id,),
        )
    ]


def test_dismissal_sql_persists_owner_scoped_groups_and_snapshot() -> None:
    stamp = ["first-dismiss"]
    connection, service = _sqlite_feed(
        [
            (1, "owner", "consent", "consent_requested", {"bundle_id": "bundle-a"}),
            (2, "owner", "consent", "consent_requested", {"bundle_id": "bundle-a"}),
            (3, "other", "consent", "consent_requested", {"bundle_id": "bundle-a"}),
            (4, "owner", "consent", "consent_requested", {"bundle_id": "bundle-b"}),
            (5, "owner", "connected_systems", "document_share_decided", {"request_id": "req-a"}),
            (6, "owner", "connected_systems", "document_share_outcome", {"request_id": "req-a"}),
            (7, "owner", "connected_systems", "document_share_outcome", {"request_id": "req-a"}),
            (8, "owner", "connected_systems", "document_share_outcome", {"request_id": "req-b"}),
            (9, "owner", "kai", "kai_analysis_completed", {}),
            (10, "owner", "consent", "consent_requested", {"bundle_id": "bundle-a"}),
            (11, "owner", "connected_systems", "document_share_outcome", {"request_id": "req-a"}),
        ],
        stamp=stamp,
    )
    first_token = service.dismiss("owner", item_id=2)["dismissal_token"]
    assert first_token is not None
    assert [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE dismissed_at IS NOT NULL ORDER BY id"
        )
    ] == [1, 2]
    # An independent earlier dismissal must not be undone with a later bundle.
    stamp[0] = "second-dismiss"
    second_token = service.dismiss("owner", item_id=10)["dismissal_token"]
    assert second_token is not None
    assert service.restore("owner", item_id=10, dismissal_token=second_token)["restored"] is True
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=1").fetchone()[0]
        == "first-dismiss"
    )
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=10").fetchone()[0] is None
    )
    stamp[0] = "drive-dismiss"
    drive_token = service.dismiss("owner", item_id=7)["dismissal_token"]
    assert drive_token is not None
    assert [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE dismissed_at='drive-dismiss' ORDER BY id"
        )
    ] == [6, 7]
    # The earlier suppressed outcome stays hidden, but a valid Drive decision
    # and a later outcome remain independent Feed rows.
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=5").fetchone()[0] is None
    )
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=11").fetchone()[0] is None
    )
    assert service.restore("owner", item_id=7, dismissal_token=drive_token)["restored"] is True
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=6").fetchone()[0] is None
    )
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=5").fetchone()[0] is None
    )
    assert (
        connection.execute("SELECT read_at FROM feed_events WHERE id=7").fetchone()[0] is not None
    )

    stamp[0] = "clear"
    service.clear("owner", up_to_id=9)
    assert (
        connection.execute("SELECT dismissal_token FROM feed_events WHERE id=2").fetchone()[0]
        != first_token
    )
    assert service.restore("owner", item_id=2, dismissal_token=first_token)["restored"] is False
    assert service.dismiss("owner", item_id=2)["dismissal_token"] is None
    assert [
        row[0]
        for row in connection.execute(
            "SELECT id FROM feed_events WHERE user_id='owner' AND dismissed_at IS NULL ORDER BY id"
        )
    ] == [10, 11]
    assert (
        connection.execute("SELECT dismissed_at FROM feed_events WHERE id=3").fetchone()[0] is None
    )


_DRIVE_FOLD_CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "feed_drive_fold_cases.json").read_text(
        encoding="utf-8"
    )
)["cases"]


def _drive_item(
    row_id: str, event_type: str, request_id: str, status: str, payment: str | None = None
) -> dict:
    metadata = {"request_id": request_id, "user_facing_status": status}
    if payment is not None:
        metadata["current_payment_status"] = payment
    return {
        "id": row_id,
        "source_domain": "connected_systems",
        "event_type": event_type,
        "metadata": metadata,
    }


@pytest.mark.parametrize("case", _DRIVE_FOLD_CASES, ids=lambda case: case["name"])
def test_server_drive_fold_matches_the_web_fold(case: dict) -> None:
    items = [
        _drive_item(
            row["id"],
            row["event_type"],
            row["request_id"],
            row["status"],
            row.get("current_payment_status"),
        )
        for row in case["rows"]
    ]
    hidden = hidden_drive_item_ids(items)
    assert [item["id"] for item in items if item["id"] not in hidden] == case["visible"]


# Every row kind the fold reads, including a Pay row whose checkout expired
# (never hidden) and an outcome that is neither a success nor empty.
_DRIVE_ROW_KINDS = (
    ("document_share_decided", "pending", None),
    ("document_share_outcome", "no_files_shared", None),
    ("document_share_outcome", "completed", None),
    ("document_share_outcome", "failed", None),
    ("document_share_payment_ready", "pending", None),
    ("document_share_payment_ready", "pending", "expired"),
    ("document_share_payment_confirmed", "paid", None),
    ("document_share_payment_refunded", "refunded", None),
)


def test_removing_any_visible_drive_row_never_surfaces_a_row_it_hid() -> None:
    # Another request whose Pay row is hidden by its own payment. No removal
    # in request-1 may touch it.
    bystanders = [
        _drive_item("100", "document_share_payment_ready", "request-2", "pending"),
        _drive_item("101", "document_share_payment_confirmed", "request-2", "paid"),
    ]
    checked = 0
    for size in range(1, 5):
        # Every combination in every id order, so a stale row that arrived
        # after the row contradicting it is covered too.
        for kinds in itertools.product(_DRIVE_ROW_KINDS, repeat=size):
            items = [
                _drive_item(str(position), event_type, "request-1", status, payment)
                for position, (event_type, status, payment) in enumerate(kinds, start=1)
            ] + bystanders
            hidden_before = hidden_drive_item_ids(items)
            visible_before = {item["id"] for item in items} - hidden_before
            for target in items[:size]:
                if target["id"] in hidden_before:
                    continue
                removed = {target["id"]}
                if target["event_type"] == "document_share_outcome":
                    # The server's existing rule: older outcomes leave too.
                    removed |= {
                        item["id"]
                        for item in items[:size]
                        if item["event_type"] == "document_share_outcome"
                        and int(item["id"]) <= int(target["id"])
                    }
                revealed = drive_rows_revealed_by_removal(items, removed)
                remaining = [item for item in items if item["id"] not in removed | revealed]
                visible_after = {item["id"] for item in remaining} - hidden_drive_item_ids(
                    remaining
                )
                assert visible_after <= visible_before - {target["id"]}, (kinds, target["id"])
                # Precise: only rows the Feed was already hiding, in this request.
                assert revealed <= hidden_before - {"100", "101"}, (kinds, target["id"])
                checked += 1
    assert checked > 4000


def test_removing_no_files_outcome_also_removes_the_rows_it_was_hiding() -> None:
    stamp = ["removed"]
    no_files = {"request_id": "req-a", "user_facing_status": "no_files_shared"}
    available = {"request_id": "req-a", "user_facing_status": "pending"}
    connection, service = _sqlite_feed(
        [
            (8, "owner", "connected_systems", "document_share_payment_ready", available),
            (9, "owner", "connected_systems", "document_share_decided", available),
            (10, "owner", "connected_systems", "document_share_outcome", no_files),
            (11, "other", "connected_systems", "document_share_decided", available),
            (12, "other", "connected_systems", "document_share_outcome", no_files),
            (13, "owner", "connected_systems", "document_share_decided", {"request_id": "req-b"}),
            (14, "owner", "kai", "kai_analysis_completed", {}),
        ],
        stamp=stamp,
    )

    result = service.dismiss("owner", item_id=10)

    # "No files were shared" leaves with the "Files are available" decision
    # and the Pay row it was hiding, so neither can take its place.
    assert _dismissed_with(connection, "removed") == [8, 9, 10]
    assert result["dismissed_ids"] == ["8", "9", "10"]
    assert _live_ids(connection, "owner") == [13, 14]
    assert _live_ids(connection, "other") == [11, 12]
    # Undo brings back exactly that set.
    token = result["dismissal_token"]
    assert service.restore("owner", item_id=10, dismissal_token=token)["restored"] is True
    assert _live_ids(connection, "owner") == [8, 9, 10, 13, 14]


@pytest.mark.parametrize(
    ("rows", "target", "expected", "payment_status"),
    [
        pytest.param(
            [
                (20, "document_share_payment_ready", "pending"),
                (21, "document_share_outcome", "completed"),
            ],
            21,
            [20, 21],
            {},
            id="success outcome",
        ),
        pytest.param(
            [
                (30, "document_share_payment_ready", "pending"),
                (31, "document_share_payment_confirmed", "paid"),
            ],
            31,
            [30, 31],
            {},
            id="payment confirmation",
        ),
        pytest.param(
            [
                (80, "document_share_payment_ready", "pending"),
                (81, "document_share_payment_refunded", "refunded"),
            ],
            81,
            [80, 81],
            {},
            id="payment refund",
        ),
        pytest.param(
            [
                (39, "document_share_decided", "pending"),
                (40, "document_share_payment_ready", "pending"),
                (41, "document_share_outcome", "completed"),
                (42, "document_share_outcome", "no_match"),
            ],
            41,
            [40, 41, 42],
            {},
            id="stale no-match outcome stored after the success",
        ),
        pytest.param(
            [
                (50, "document_share_payment_ready", "pending"),
                (51, "document_share_outcome", "completed"),
            ],
            51,
            [51],
            {"req": "expired"},
            id="expired checkout stays visible",
        ),
    ],
)
def test_removing_a_payment_or_outcome_never_surfaces_an_old_pay_row(
    rows: list[tuple[int, str, str]],
    target: int,
    expected: list[int],
    payment_status: dict[str, str],
) -> None:
    stamp = ["removed"]
    connection, service = _sqlite_feed(
        [
            (
                row_id,
                "owner",
                "connected_systems",
                event_type,
                {"request_id": "req", "user_facing_status": status},
            )
            for row_id, event_type, status in rows
        ],
        stamp=stamp,
        payment_status=payment_status,
    )

    result = service.dismiss("owner", item_id=target)

    assert _dismissed_with(connection, "removed") == expected
    assert result["dismissed_ids"] == [str(row_id) for row_id in expected]


def test_pay_row_leaves_with_the_last_row_that_was_hiding_it() -> None:
    stamp = ["payment"]
    connection, service = _sqlite_feed(
        [
            (
                60,
                "owner",
                "connected_systems",
                "document_share_payment_ready",
                {"request_id": "req"},
            ),
            (
                61,
                "owner",
                "connected_systems",
                "document_share_payment_confirmed",
                {"request_id": "req"},
            ),
            (
                62,
                "owner",
                "connected_systems",
                "document_share_outcome",
                {"request_id": "req", "user_facing_status": "completed"},
            ),
        ],
        stamp=stamp,
    )

    # The outcome still hides Pay, so only the confirmation leaves.
    service.dismiss("owner", item_id=61)
    assert _dismissed_with(connection, "payment") == [61]
    stamp[0] = "outcome"
    service.dismiss("owner", item_id=62)
    assert _dismissed_with(connection, "outcome") == [60, 62]


def test_clear_also_removes_a_newer_stale_row_it_would_surface() -> None:
    stamp = ["clear"]
    connection, service = _sqlite_feed(
        [
            (
                70,
                "owner",
                "connected_systems",
                "document_share_outcome",
                {"request_id": "req", "user_facing_status": "completed"},
            ),
            # Stored after the success it contradicts, so it sits above the
            # Clear watermark while the Feed folds it away.
            (
                71,
                "owner",
                "connected_systems",
                "document_share_outcome",
                {"request_id": "req", "user_facing_status": "no_match"},
            ),
            (
                72,
                "owner",
                "connected_systems",
                "document_share_outcome",
                {"request_id": "req-new", "user_facing_status": "no_match"},
            ),
            (
                73,
                "other",
                "connected_systems",
                "document_share_outcome",
                {"request_id": "req", "user_facing_status": "no_match"},
            ),
        ],
        stamp=stamp,
    )

    assert service.clear("owner", up_to_id=70) == {"status": "ok"}

    assert _dismissed_with(connection, "clear") == [70, 71]
    # Later activity for another request stays visible.
    assert _live_ids(connection, "owner") == [72]
    assert _live_ids(connection, "other") == [73]


def test_feed_projection_allows_only_bounded_renderer_metadata() -> None:
    row = {
        "id": 1,
        "source_domain": "location",
        "event_type": "location_access_request",
        "actor_label": f"  {'A' * 200}  ",
        "metadata": {
            "counterpart_label": f"  {'B' * 300}  ",
            "counterpart_photo_url": f"  https://cdn.example.test/{'p' * 999}  ",
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
        "counterpart_photo_url": "https://cdn.example.test/" + "p" * 999,
        "requested_duration_hours": 3,
        "is_extension": True,
    }


@pytest.mark.parametrize("authoritative", [True, False, None, "true", 1])
def test_nocharge_feed_receipt_survives_wire_sanitation_without_trusting_snapshot(authoritative):
    request_id = "11111111-2222-4333-8444-555555555555"
    service = FeedService()
    service._db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "current_existing_access_nocharge": authoritative,
                    "provider_secret": "must-not-cross",
                }
            ]
        ]
    )
    rows = service._with_drive_payment_status(
        "requester",
        [
            {
                "id": 1,
                "event_type": "document_share_outcome",
                "metadata": {
                    "request_id": request_id,
                    "current_existing_access_nocharge": True,
                    "file_name": "private.pdf",
                },
            }
        ],
    )
    item = service._to_item(rows[0], "requester")
    assert item["metadata"].get("current_existing_access_nocharge") is (
        True if authoritative is True else None
    )
    assert "provider_secret" not in str(item)
    assert "private.pdf" not in str(item)
    assert (
        "current_existing_access_nocharge"
        not in service._to_item(
            {
                "id": 2,
                "event_type": "document_share_outcome",
                "metadata": {"current_existing_access_nocharge": True},
            }
        )["metadata"]
    )


def test_historical_drive_payment_reads_current_requester_scoped_status() -> None:
    request_id = "11111111-2222-4333-8444-555555555555"
    db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "current_request_status": "pending",
                    "current_request_expires_at": "2026-10-10T00:00:00Z",
                    "current_request_expired": False,
                    "current_access_stopped": False,
                    "current_payment_status": "paid",
                    "current_checkout_expires_at": "2026-10-09T00:00:00Z",
                    "current_checkout_expired": True,
                    "provider_secret": "never-send-this",
                }
            ]
        ]
    )
    service = FeedService()
    service._db = db
    rows = service._with_drive_payment_status(
        "requester",
        [
            {
                "event_type": "document_share_payment_ready",
                "metadata": {"request_id": request_id, "file_name": "private.pdf"},
            },
        ],
    )
    sql, params = db.raw_calls[0]
    assert "r.recipient_user_id=:user_id" in sql
    assert params["user_id"] == "requester"
    metadata = FeedService._to_item({"id": 1, **rows[0]})["metadata"]
    assert metadata["current_payment_status"] == "paid"
    assert metadata["current_checkout_expired"] is True
    assert "provider_secret" not in str(metadata)
    assert "private.pdf" not in str(metadata)


@pytest.mark.parametrize("viewer", ["owner", "requester"])
def test_historical_partial_feed_uses_current_delivery_receipts(viewer) -> None:
    request_id = "11111111-2222-4333-8444-555555555555"
    service = FeedService()
    db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "current_request_status": "partial",
                    "current_delivery_total_count": 20,
                    "current_delivery_confirmed_count": 20,
                    "current_delivery_pending_count": 0,
                    "file_name": "private.pdf",
                    "semantic_outcome_counts": {"unavailable:unsupported_format": 27},
                }
            ]
        ]
    )
    service._db = db
    rows = service._with_drive_payment_status(
        viewer,
        [
            {
                "event_type": "document_share_outcome",
                "metadata": {"request_id": request_id, "user_facing_status": "partial"},
            }
        ],
    )
    metadata = FeedService._to_item({"id": 1, **rows[0]})["metadata"]
    assert metadata["user_facing_status"] == "partial"
    assert metadata["current_delivery_total_count"] == 20
    assert metadata["current_delivery_confirmed_count"] == 20
    assert metadata["current_delivery_pending_count"] == 0
    assert "private.pdf" not in str(metadata)
    assert "unsupported_format" not in str(metadata)
    sql, params = db.raw_calls[0]
    assert params["user_id"] == viewer
    assert "r.recipient_user_id=:user_id OR r.user_id=:user_id" in sql


def test_missing_delivery_lookup_does_not_reuse_snapshot_counts() -> None:
    service = FeedService()
    service._db = _QueuedDb(raw_results=[[]])
    rows = service._with_drive_payment_status(
        "unrelated",
        [
            {
                "event_type": "document_share_outcome",
                "metadata": {
                    "request_id": "11111111-2222-4333-8444-555555555555",
                    "user_facing_status": "partial",
                    "current_delivery_total_count": 20,
                    "current_delivery_confirmed_count": 20,
                    "current_delivery_pending_count": 0,
                },
            }
        ],
    )
    metadata = FeedService._to_item({"id": 1, **rows[0]})["metadata"]
    assert not any(key.startswith("current_delivery_") for key in metadata)


def test_document_feed_projects_owner_setup_and_exact_partial_refund_only_to_each_party() -> None:
    request_id = "11111111-2222-4333-8444-555555555555"
    owner_db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "viewer_is_owner": True,
                    "owner_payout_status": "awaiting_delivery",
                    "owner_payout_account_ready": False,
                    "owner_earning_cents": None,
                    "current_refund_amount_cents": 500,
                    "current_payment_amount_cents": 1000,
                }
            ]
        ]
    )
    owner = FeedService()
    owner._db = owner_db
    row = {"event_type": "document_share_request", "metadata": {"request_id": request_id}}
    owner_metadata = FeedService._to_item(
        {"id": 1, **owner._with_drive_payment_status("owner", [row])[0]}
    )["metadata"]
    assert owner_metadata["owner_payout_status"] == "awaiting_delivery"
    assert owner_metadata["owner_payout_account_ready"] is False
    assert "current_refund_amount_cents" not in owner_metadata

    requester_db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "viewer_is_owner": False,
                    "owner_payout_status": "transferred",
                    "owner_earning_cents": 411,
                    "current_refund_amount_cents": 500,
                    "current_payment_amount_cents": 1000,
                }
            ]
        ]
    )
    requester = FeedService()
    requester._db = requester_db
    row = {"event_type": "document_share_payment_refunded", "metadata": {"request_id": request_id}}
    requester_metadata = FeedService._to_item(
        {"id": 2, **requester._with_drive_payment_status("requester", [row])[0]}
    )["metadata"]
    assert requester_metadata["current_refund_amount_cents"] == 500
    assert requester_metadata["current_payment_amount_cents"] == 1000
    assert "owner_payout_status" not in requester_metadata


def test_document_feed_projects_setup_before_payout_order_and_waiting_to_requester(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    request_id = "11111111-2222-4333-8444-555555555555"
    owner_db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "viewer_is_owner": True,
                    "owner_payout_status": None,
                    "owner_payout_account_ready": False,
                }
            ]
        ]
    )
    owner = FeedService()
    owner._db = owner_db
    owner_row = {"event_type": "document_share_request", "metadata": {"request_id": request_id}}
    owner_metadata = FeedService._to_item(
        {"id": 1, **owner._with_drive_payment_status("owner", [owner_row])[0]}
    )["metadata"]
    assert owner_metadata["owner_payout_account_ready"] is False
    assert "owner_payout_status" not in owner_metadata
    assert owner_db.raw_calls[0][1]["payout_rollout"] is True

    requester_db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "viewer_is_owner": False,
                    "current_owner_payout_account_ready": False,
                }
            ]
        ]
    )
    requester = FeedService()
    requester._db = requester_db
    requester_row = {
        "event_type": "document_share_payment_ready",
        "metadata": {"request_id": request_id},
    }
    requester_metadata = FeedService._to_item(
        {"id": 2, **requester._with_drive_payment_status("requester", [requester_row])[0]}
    )["metadata"]
    assert requester_metadata["current_owner_payout_account_ready"] is False
    assert "owner_payout_account_ready" not in requester_metadata


def test_recipient_share_outcome_hides_owner_zero_match_result() -> None:
    recipient = FeedService._to_item(
        {
            "id": 1,
            "event_type": "document_share_outcome",
            "metadata": {"feed_audience": "recipient", "user_facing_status": "no_match"},
        }
    )
    owner = FeedService._to_item(
        {
            "id": 2,
            "event_type": "document_share_outcome",
            "metadata": {"feed_audience": "owner", "user_facing_status": "no_match"},
        }
    )
    assert recipient["metadata"]["user_facing_status"] == "no_files_shared"
    assert owner["metadata"]["user_facing_status"] == "no_match"


def test_direct_message_feed_body_is_only_a_recipient_scoped_transient_preview(
    monkeypatch,
) -> None:
    class _Cipher:
        def open(self, row: dict) -> str:
            assert row["id"] == _DIRECT_MESSAGE_ID
            assert row["sender_user_id"] == "sender-user"
            return "  hi\nthere  "

    monkeypatch.setattr(feed_service_module, "DirectMessageCipher", lambda: _Cipher())
    list_query = _Query(
        data=[
            {
                "id": 10,
                "source_domain": "connections",
                "event_type": "direct_message_received",
                "actor_label": None,
                "metadata": {},
                "source_row_id": _DIRECT_MESSAGE_ID,
                "read_at": None,
                "created_at": "2026-10-04T10:00:00Z",
            }
        ]
    )
    count_query = _Query(count=1)
    service = FeedService()
    service._durable_counterpart_photos = lambda *_: {}
    service._db = _QueuedDb(
        list_query,
        count_query,
        raw_results=[
            [
                {
                    "source_row_id": _DIRECT_MESSAGE_ID,
                    "id": _DIRECT_MESSAGE_ID,
                    "conversation_id": _DIRECT_MESSAGE_CONVERSATION_ID,
                    "sender_user_id": "sender-user",
                    "content_ciphertext": "opaque",
                    "content_iv": "opaque",
                    "content_algorithm": "aes-256-gcm-aad-v1",
                    "user_id": "sender-user",
                    "display_name": "Rohan",
                    "email": "rohan@example.test",
                }
            ]
        ],
    )

    result = service.list_feed("recipient-user", limit=20)

    assert result["items"] == [
        {
            "id": "10",
            "source_domain": "connections",
            "event_type": "direct_message_received",
            "actor_label": None,
            "metadata": {
                "counterpart_label": "Rohan",
                "direct_message_conversation_id": _DIRECT_MESSAGE_CONVERSATION_ID,
                "message_preview": "hi there",
            },
            "read": False,
            "created_at": "2026-10-04T10:00:00Z",
        }
    ]
    # The Feed row itself remains plaintext-free; only the authenticated DTO
    # acquires the result of opening the message envelope.
    assert list_query.data[0]["metadata"] == {}
    sql, params = service._db.raw_calls[2]
    assert "feed.user_id = :viewer_user_id" in sql
    assert "conversation.participant_a_user_id = message.sender_user_id" in sql
    assert "conversation.participant_b_user_id = message.sender_user_id" in sql
    assert params == {
        "viewer_user_id": "recipient-user",
        "message_ids_json": f'["{_DIRECT_MESSAGE_ID}"]',
    }


def test_direct_message_feed_never_promotes_persisted_body_or_route_metadata() -> None:
    item = FeedService._to_item(
        {
            "id": 11,
            "event_type": "direct_message_received",
            "metadata": {
                "message_preview": "must not come from feed storage",
                "direct_message_conversation_id": _DIRECT_MESSAGE_CONVERSATION_ID,
                "content": "hi",
                "ciphertext": "opaque",
            },
        }
    )

    assert item["metadata"] == {}


def test_unavailable_direct_message_body_keeps_a_generic_feed_item(monkeypatch) -> None:
    class _UnavailableCipher:
        def open(self, _row: dict) -> str:
            raise DirectMessagesError(
                "DIRECT_MESSAGE_CONTENT_UNAVAILABLE",
                "unavailable",
                status_code=503,
            )

    monkeypatch.setattr(
        feed_service_module,
        "DirectMessageCipher",
        lambda: _UnavailableCipher(),
    )
    service = FeedService()
    service._db = _QueuedDb(
        raw_results=[
            [
                {
                    "source_row_id": _DIRECT_MESSAGE_ID,
                    "conversation_id": _DIRECT_MESSAGE_CONVERSATION_ID,
                    "sender_user_id": "sender-user",
                    "content_ciphertext": "opaque",
                    "content_iv": "opaque",
                    "content_algorithm": "aes-256-gcm-aad-v1",
                    "user_id": "sender-user",
                    "display_name": "Rohan",
                }
            ]
        ]
    )

    enriched = service._with_direct_message_previews(
        "recipient-user",
        [
            {
                "id": 10,
                "source_domain": "connections",
                "event_type": "direct_message_received",
                "metadata": {},
                "source_row_id": _DIRECT_MESSAGE_ID,
            }
        ],
    )

    item = FeedService._to_item(enriched[0])
    assert item["metadata"] == {
        "counterpart_label": "Rohan",
        "direct_message_conversation_id": _DIRECT_MESSAGE_CONVERSATION_ID,
    }
    assert "message_preview" not in item["metadata"]


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
    service._durable_counterpart_photos = lambda *_: None
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
    assert "connection_requests" in service._db.raw_calls[2][0]
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
    service._durable_counterpart_photos = lambda *_: None
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
    assert "one_location_share_grants" in service._db.raw_calls[2][0]


def test_durable_identity_gives_same_person_photo_to_mixed_feed_events() -> None:
    photo = "https://cdn.example.test/current-person.jpg"
    service = FeedService()
    service._db = _QueuedDb(
        raw_results=[
            [
                {"feed_id": "41", "counterpart_photo_url": photo},
                {"feed_id": "42", "counterpart_photo_url": photo},
                {"feed_id": "43", "counterpart_photo_url": photo},
            ]
        ]
    )
    rows = [
        {
            "id": 41,
            "source_domain": "location",
            "event_type": "location_share_viewed",
            "source_row_id": "old-view-source",
            "metadata": {"counterpart_label": "Kushal Trivedi"},
        },
        {
            "id": 42,
            "source_domain": "location",
            "event_type": "location_sms_contact_added",
            "source_row_id": "old-sms-source",
            "metadata": {"counterpart_label": "Kushal Trivedi"},
        },
        {
            "id": 43,
            "source_domain": "location",
            "event_type": "circle_member_added",
            "source_row_id": "old-circle-source",
            "metadata": {"counterpart_label": "Kushal Trivedi"},
        },
    ]

    enriched = service._with_counterpart_photos("viewer-user", rows)

    assert [row["metadata"]["counterpart_photo_url"] for row in enriched] == [
        photo,
        photo,
        photo,
    ]
    sql, params = service._db.raw_calls[0]
    assert "feed_event_counterparts" in sql
    assert "WHERE f.user_id = :user_id" in sql
    assert params == {
        "user_id": "viewer-user",
        "feed_ids_json": '["41", "42", "43"]',
    }
    assert all("counterpart_user_id" not in row for row in enriched)
    assert all("counterpart_user_id" not in row["metadata"] for row in enriched)


def test_feed_profile_reference_is_current_public_identity_not_internal_id() -> None:
    service = FeedService()
    service._db = _QueuedDb(
        raw_results=[
            [
                {
                    "feed_id": "41",
                    "counterpart_photo_url": None,
                    "counterpart_person_ref": "11111111-1111-4111-8111-111111111111",
                },
                {"feed_id": "42", "counterpart_photo_url": None},
            ]
        ]
    )
    rows = [
        {
            "id": item_id,
            "metadata": {"counterpart_person_ref": "stale", "counterpart_user_id": "private-uid"},
        }
        for item_id in (41, 42)
    ]
    items = [FeedService._to_item(row) for row in service._with_counterpart_photos("viewer", rows)]
    assert items[0]["metadata"]["counterpart_person_ref"] == "11111111-1111-4111-8111-111111111111"
    assert not items[1]["metadata"].get("counterpart_person_ref")
    assert all("counterpart_user_id" not in item["metadata"] for item in items)
    sql, params = service._db.raw_calls[0]
    assert "WHERE f.user_id = :user_id" in sql
    assert params["user_id"] == "viewer"


def test_uploaded_avatar_is_never_truncated_by_either_feed_boundary() -> None:
    photo = "data:image/png;base64," + base64.b64encode(b"synthetic-image" * 150).decode()
    service = FeedService()
    service._db = _QueuedDb(
        raw_results=[[{"source_row_id": "grant", "counterpart_photo_url": photo}]]
    )

    resolved = service._photo_rows("SELECT synthetic", {})[0]["counterpart_photo_url"]

    assert resolved == photo
    assert (
        FeedService._to_item({"id": 1, "metadata": {"counterpart_photo_url": resolved}})[
            "metadata"
        ]["counterpart_photo_url"]
        == photo
    )


@pytest.mark.parametrize(
    "photo",
    [
        "javascript:alert(1)",
        "data:image/svg+xml;base64,PHN2Zy8+",
        "data:image/png;base64,not-base64!",
        "data:image/png;base64,",
        "https://example.test/" + "a" * 1100,
        "data:image/png;base64," + base64.b64encode(b"a" * (300 * 1024 + 1)).decode(),
    ],
    ids=[
        "script",
        "svg",
        "invalid-base64",
        "empty",
        "long-url",
        "oversized-raster",
    ],
)
def test_invalid_avatar_is_rejected_not_partially_returned(photo: str) -> None:
    assert _safe_photo_url(photo) is None


@pytest.mark.parametrize("photo", ["https://example.test/new.png", None, ""])
def test_durable_photo_read_follows_current_identity_including_removal(
    photo: str | None,
) -> None:
    service = FeedService()
    service._db = _QueuedDb(raw_results=[[{"feed_id": "42", "counterpart_photo_url": photo}]])
    row = {
        "id": 42,
        "source_domain": "location",
        "event_type": "location_share_expired",
        "metadata": {"counterpart_photo_url": "https://example.test/old.png"},
    }

    item = FeedService._to_item(service._with_counterpart_photos("viewer", [row])[0])

    assert item["metadata"].get("counterpart_photo_url") == (photo or None)
    assert "counterpart_user_id" not in item
    assert "counterpart_user_id" not in item["metadata"]


def test_old_schema_wrapped_error_keeps_legacy_photo_enrichment_available() -> None:
    class MissingTable(Exception):
        pgcode = "42P01"

    class OldSchemaDb:
        def execute_raw(self, *_args, **_kwargs):
            raise RuntimeError("wrapped driver error") from MissingTable()

    service = FeedService()
    service._db = OldSchemaDb()

    assert service._durable_counterpart_photos("viewer", [{"id": 1}]) is None


@pytest.mark.parametrize("outcome", ["removed", "missing", "unavailable"])
def test_legacy_photo_lookup_never_resurrects_a_snapshot(outcome: str) -> None:
    request_id = "11111111-1111-4111-8111-111111111111"

    class UnavailableDb:
        def execute_raw(self, *_args, **_kwargs):
            raise RuntimeError("synthetic unavailable identity lookup")

    service = FeedService()
    service._durable_counterpart_photos = lambda *_: None
    service._db = (
        UnavailableDb()
        if outcome == "unavailable"
        else _QueuedDb(
            raw_results=[
                [{"source_row_id": request_id, "counterpart_photo_url": None}]
                if outcome == "removed"
                else []
            ]
        )
    )
    original = {
        "id": 42,
        "source_domain": "connections",
        "event_type": "connection_accepted",
        "source_row_id": request_id,
        "metadata": {
            "counterpart_label": "Current Person",
            "counterpart_photo_url": "https://example.test/old.png",
        },
    }

    row = service._with_counterpart_photos("viewer", [original])[0]

    assert row["metadata"] == {"counterpart_label": "Current Person"}
    assert "counterpart_photo_url" in original["metadata"]


def test_legacy_duration_event_prefers_its_authoritative_grant_id() -> None:
    grant_id = "22222222-2222-4222-8222-222222222222"
    service = FeedService()
    service._durable_counterpart_photos = lambda *_: None
    service._db = _QueuedDb(
        raw_results=[
            [
                {
                    "source_row_id": grant_id,
                    "counterpart_photo_url": "https://example.test/person.png",
                }
            ]
        ]
    )

    rows = service._with_counterpart_photos(
        "viewer",
        [
            {
                "id": 42,
                "source_domain": "location",
                "event_type": "location_share_duration_changed",
                "source_row_id": "999",
                "metadata": {"grant_id": grant_id},
            }
        ],
    )

    assert rows[0]["metadata"]["counterpart_photo_url"] == "https://example.test/person.png"
    assert grant_id in service._db.raw_calls[0][1]["grant_ids_json"]


def test_grouped_chat_metadata_is_computed_and_not_copied_from_storage():
    item = FeedService._to_item(
        {
            "id": 21,
            "event_type": "location_circle_message",
            "metadata": {"chat_unread_count": 9999, "circle_name": "Family"},
            "thread_key": "circle:c1",
            "thread_message_count": 12,
            "thread_unread_count": 3,
        }
    )

    assert item["metadata"]["chat_thread_key"] == "circle:c1"
    assert item["metadata"]["chat_message_count"] == 12
    assert item["metadata"]["chat_unread_count"] == 3
    assert (
        FeedService._to_item(
            {"id": 1, "metadata": {"chat_thread_key": "direct:foreign", "chat_unread_count": 99}}
        )["metadata"]
        == {}
    )


def test_card_share_notice_requires_authoritative_recipient_grant():
    grant_id = "22222222-2222-4222-8222-222222222222"
    row = {
        "id": 22,
        "event_type": "direct_message_received",
        "actor_label": "Test sender",
        "_direct_message_preview": f"[wallet-access:{grant_id}]",
        "metadata": {"wallet_card_grant_id": grant_id},
    }
    assert "wallet_card_grant_id" not in FeedService._to_item(row)["metadata"]
    verified = FeedService._to_item({**row, "_wallet_card_grant_id": grant_id})
    assert verified["metadata"]["wallet_card_grant_id"] == grant_id
    assert verified["metadata"]["message_preview"] == "Test sender shared their card with you"
    assert (
        feed_service_module._direct_message_preview(f"[wallet-access:{grant_id}]")
        == "Shared payment card"
    )
    assert feed_service_module._direct_message_preview("Ordinary message") == "Ordinary message"


@pytest.mark.parametrize(
    "matched,blocked,state,incomplete,reason",
    [
        (12, 12, "completed", False, "matching_files_unshareable"),
        (0, 0, "completed", False, "no_matching_files"),
        (12, 12, "running", False, None),
        (12, 12, "completed", True, None),
        (12, 11, "completed", False, None),
        (None, None, None, None, None),
    ],
)
def test_terminal_drive_outcome_uses_live_counts_not_forged_snapshot(
    matched, blocked, state, incomplete, reason
):
    request_id = "11111111-2222-4333-8444-555555555555"
    service = FeedService()
    service._db = _QueuedDb(
        raw_results=[
            [
                {
                    "request_id": request_id,
                    "current_request_status": "no_match",
                    "outcome_search_status": state,
                    "outcome_search_incomplete": incomplete,
                    "outcome_search_matched": matched,
                    "outcome_search_unshareable": blocked,
                }
            ]
        ]
    )
    row = {
        "id": 1,
        "event_type": "document_share_outcome",
        "metadata": {
            "request_id": request_id,
            "current_outcome_reason": "matching_files_unshareable",
        },
    }
    hydrated = service._with_drive_payment_status("requester", [row])[0]
    item = service._to_item(hydrated, "requester")
    assert item["metadata"].get("current_outcome_reason") == reason
    assert "outcome_search_matched" not in str(item)
    assert "current_outcome_reason" not in service._to_item(row)["metadata"]
