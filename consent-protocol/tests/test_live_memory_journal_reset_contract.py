"""Golden reset vectors shared by the backend journal and both web journal clients.

The web clients once rejected the backend's in-range reset, so a missing
sequence inside the retained range stalled replay until a periodic scan.
These vectors are the backend's real ``reset()`` output on a fake engine; the
web test reads the same file, so the two layers cannot drift apart again.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from hushh_mcp.services.source_journal_service import SourceJournalService

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "live_memory_journal_reset_vectors.json").read_text(
        encoding="utf-8"
    )
)
FAMILIES = (("events", "source_in_range_gap"), ("connector_events", "connector_in_range_gap"))


class _Result:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def mappings(self) -> _Result:
        return self

    def first(self) -> dict | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[dict]:
        return list(self._rows)


class _Connection:
    """Answers the journal's stream and event reads like Postgres would."""

    def __init__(self, stream: dict, rows: list[dict]) -> None:
        self._stream = stream
        self._rows = rows

    def execute(self, statement, params: dict | None = None) -> _Result:
        sql = str(statement)
        if sql.startswith("SET "):
            return _Result([])
        if "_streams" in sql:
            return _Result([self._stream])
        if "_events" in sql:
            assert params is not None
            selected = sorted(
                (row for row in self._rows if params["after"] < row["sequence"] <= params["head"]),
                key=lambda row: row["sequence"],
            )
            return _Result(selected[: params["limit"]])
        raise AssertionError(f"unexpected journal statement: {sql}")


class _Engine:
    def __init__(self, stream: dict, rows: list[dict]) -> None:
        self._stream = stream
        self._rows = rows

    @contextmanager
    def begin(self):
        yield _Connection(self._stream, self._rows)


def _row(sequence: int) -> dict:
    return {
        "sequence": sequence,
        "event_id": f"event-{sequence}",
        "source_kind": "consent",
        "source_id": "google_drive",
        "operation": "changed",
        "schema_version": 1,
        "occurred_at": datetime(2026, 10, 14, 0, 0, sequence, tzinfo=timezone.utc),
    }


def _journal(*, first_retained: int, sequences: list[int]) -> SourceJournalService:
    stream = {"last_sequence": 6, "first_retained_sequence": first_retained}
    engine = _Engine(stream, [_row(sequence) for sequence in sequences])
    return SourceJournalService(SimpleNamespace(engine=engine))


def _read(journal: SourceJournalService, family: str, after: int) -> dict:
    return asyncio.run(getattr(journal, family)(user_id="o", after=after))


def test_backend_reset_output_is_the_golden_vector():
    # Stream head 6, nothing trimmed, but sequence 5 is missing inside the range.
    gap = _journal(first_retained=1, sequences=[6])
    for family, name in FAMILIES:
        vector = VECTORS[name]
        assert _read(gap, family, vector["after"]) == vector["response"]

    # Retention trimmed sequences 1 and 2, so cursor 1 is below the floor.
    retained = _journal(first_retained=3, sequences=[3, 4, 5, 6])
    for family, _name in FAMILIES:
        vector = VECTORS["retention_reset"]
        assert _read(retained, family, vector["after"]) == vector["response"]


def test_contiguous_rows_replay_instead_of_resetting():
    # Negative control: the same cursor over contiguous rows is a normal page,
    # so the golden vectors cannot pass merely because every read resets.
    contiguous = _journal(first_retained=1, sequences=[5, 6])
    for family, _name in FAMILIES:
        page = _read(contiguous, family, 4)
        assert page["resetRequired"] is False
        assert [event["sequence"] for event in page["events"]] == ["5", "6"]
        assert page["nextCursor"] == "6"
        assert page["hasMore"] is False
