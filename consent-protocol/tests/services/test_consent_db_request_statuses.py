from types import SimpleNamespace

import pytest

from hushh_mcp.services.consent_db import ConsentDBService


class _Query:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.calls: list[tuple[str, object]] = []

    def select(self, columns: str):
        self.calls.append(("select", columns))
        return self

    def eq(self, column: str, value: object):
        self.calls.append(("eq", (column, value)))
        return self

    def in_(self, column: str, values: list[str]):
        self.calls.append(("in", (column, values)))
        return self

    def neq(self, column: str, value: object):
        self.calls.append(("neq", (column, value)))
        return self

    def order(self, column: str, *, desc: bool):
        self.calls.append(("order", (column, desc)))
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class _DB:
    def __init__(self, rows: list[dict]) -> None:
        self.query = _Query(rows)

    def table(self, name: str):
        assert name == "consent_audit"
        return self.query


def _row(request_id: str, action: str, issued_at: int, *, agent_id: str = "one_person:viewer"):
    return {
        "id": issued_at,
        "token_id": None,
        "request_id": request_id,
        "action": action,
        "scope": "attr.professional.job",
        "agent_id": agent_id,
        "issued_at": issued_at,
        "scope_description": "Professional role",
        "metadata": {},
        "expires_at": None,
        "poll_timeout_at": None,
    }


@pytest.mark.asyncio
async def test_request_statuses_batches_owner_scoped_rows_and_preserves_latest_semantics():
    db = _DB(
        [
            _row("req-internal", "OPERATION_PERFORMED", 4, agent_id="self"),
            _row("req-internal", "REQUESTED", 3),
            _row("req-visible", "CONSENT_DENIED", 2),
        ]
    )
    service = ConsentDBService()
    service._get_db = lambda: db

    statuses = await service.get_request_statuses(
        "subject", ["req-visible", "req-visible", "req-internal", ""]
    )

    assert set(statuses) == {"req-visible"}
    assert statuses["req-visible"]["action"] == "CONSENT_DENIED"
    assert ("eq", ("user_id", "subject")) in db.query.calls
    assert ("in", ("request_id", ["req-visible", "req-internal"])) in db.query.calls
    assert ("neq", ("action", "EXPORT_READ")) in db.query.calls


@pytest.mark.asyncio
async def test_request_statuses_skips_empty_input_without_initializing_database():
    service = ConsentDBService()

    def unexpected_db():
        raise AssertionError("empty batch must not initialize the database")

    service._get_db = unexpected_db
    assert await service.get_request_statuses("subject", ["", "  "]) == {}


class _ProjectingQuery(_Query):
    """Returns only the selected columns, like the real client does."""

    def limit(self, count: int):
        self.calls.append(("limit", count))
        return self

    def execute(self):
        columns = next(value for name, value in self.calls if name == "select")
        selected = [column.strip() for column in str(columns).split(",")]
        return SimpleNamespace(
            data=[{key: row[key] for key in selected if key in row} for row in self.rows]
        )


def _owned_row(request_id: str) -> dict:
    # The person-export binding compares the status owner with the bundle
    # subject, so the owner must survive the projection (regression: it did not,
    # and every person-to-person export read back as unavailable).
    return {**_row(request_id, "CONSENT_GRANTED", 5), "user_id": "subject"}


@pytest.mark.asyncio
async def test_single_status_carries_the_owner_the_export_binding_checks():
    db = _DB([_owned_row("req-1")])
    db.query = _ProjectingQuery(db.query.rows)
    service = ConsentDBService()
    service._get_db = lambda: db

    status = await service.get_request_status("subject", "req-1")

    assert status is not None
    assert status["user_id"] == "subject"


@pytest.mark.asyncio
async def test_batched_statuses_carry_the_owner_the_export_binding_checks():
    db = _DB([_owned_row("req-1")])
    db.query = _ProjectingQuery(db.query.rows)
    service = ConsentDBService()
    service._get_db = lambda: db

    statuses = await service.get_request_statuses("subject", ["req-1"])

    assert statuses["req-1"]["user_id"] == "subject"
