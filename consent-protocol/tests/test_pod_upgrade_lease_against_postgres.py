"""The single-flight upgrade lease, run against a real PostgreSQL.

WHY THIS FILE EXISTS

The lease is the only thing standing between two gunicorn workers and a double
upgrade. The reconcile loop runs in every worker, and on 2026-09-02 both replaced the
founder's pod within thirty seconds of each other and each counted the other's copy
failure, so the three-attempt cap was reached in two passes.

WHAT THE EXISTING TESTS DO AND DO NOT COVER, measured rather than assumed

`test_the_registry_lease_is_one_conditional_write` and
`test_the_lease_claim_parses_only_the_timestamp_half` pin the statement's TEXT against a
fake `_Db`. They are stronger than they look: three defects were reintroduced here on
purpose -- the historical `9fc41c180` cast, an invalid `json_set`, and an inverted
staleness comparison -- and a substring test caught all three, because the pins cover
most of the statement.

What they cannot do is EXECUTE it, and that leaves two gaps.

The statement is never checked against a live schema, so a column renamed by a migration
would keep every pinned substring and break production. That is not hypothetical in this
repo: `f2518d602` records a migration-contract test that sat five columns behind the real
contract while staying green.

And a text pin cannot say which text is RIGHT. When the inverted comparison was injected
above, the substring test failed only because the characters changed -- it reports "the
SQL is not what was written down", never "the lease boundary is now backwards". The
honest response to that failure is to re-pin whatever is now written, which is exactly
how a wrong statement becomes the new baseline. These tests fail only when the BEHAVIOUR
changes, so they survive a legitimate rewrite and still assert the same property.

WHAT MAKES THIS HONEST

The statement under test is the SHIPPED one. `claim_image_upgrade` is called with a
capturing client so the exact SQL and parameters the repository sends in production are
what get executed here -- not a transcription that could drift from it the moment
somebody edits the method.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import pytest

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="no PostgreSQL binaries on this host")

_REGISTRY_SCHEMA = (
    Path(__file__).resolve().parents[1]
    / "db"
    / "migrations"
    / "parked"
    / "900_personal_agent_registry.sql"
)

_USER = "uid-lease"
_TARGET = "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-331a11456"


class _CapturingClient:
    """Not a fake database -- a tap. It records what the repository actually sends."""

    def __init__(self) -> None:
        self.sql: Optional[str] = None
        self.params: Optional[dict] = None

    def execute_raw(self, sql: str, params: Optional[dict] = None) -> Any:
        self.sql = sql
        self.params = params

        class _Empty:
            data: list = []

        return _Empty()


def _shipped_claim(target_image: str = _TARGET) -> tuple[str, dict]:
    """The statement and binds `claim_image_upgrade` sends in production."""
    tap = _CapturingClient()
    repo = PersonalAgentRegistryRepo(client=tap)
    asyncio.run(repo.claim_image_upgrade(user_id=_USER, target_image=target_image))
    assert tap.sql and tap.params is not None, "the repository sent no statement"
    return tap.sql, dict(tap.params)


@pytest.fixture(scope="module")
def pg():
    """A disposable server carrying only the registry schema.

    The harness's PKM migration list is irrelevant here and slow, so it is emptied for
    this module; the prelude still runs because the schema file depends on it.
    """
    original = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = TempPostgres()
    try:
        server.start()
        server.apply_file(_REGISTRY_SCHEMA)
        yield server
    finally:
        postgres_harness.MIGRATIONS = original
        server.stop()


@pytest.fixture
def engine(pg):
    """SQLAlchemy, because that is what `execute_raw` uses.

    The binds are `:name`, which psycopg2 alone does not speak. Running them through
    any other binding style would be testing a translation this repository never
    performs.
    """
    from sqlalchemy import create_engine

    return create_engine(
        f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}",
        future=True,
    )


def _row(pg, *, status: str = "provisioned", lease: Optional[str] = None) -> None:
    pg.execute("DELETE FROM personal_agent_registry WHERE user_id = %s", (_USER,))
    metadata = "{}" if lease is None else f'{{"upgradeLease": "{lease}"}}'
    pg.execute(
        """
        INSERT INTO personal_agent_registry (user_id, hushh_id, status, backend_metadata)
        VALUES (%s, %s, %s, %s::jsonb)
        """,
        (_USER, "ha1_lease", status, metadata),
    )


def _claim(engine, target_image: str = _TARGET) -> list:
    from sqlalchemy import text

    sql, params = _shipped_claim(target_image)
    with engine.begin() as conn:
        return list(conn.execute(text(sql), params))


def test_the_shipped_claim_statement_is_accepted_by_postgres(pg, engine):
    """The statement is valid against the schema it will actually run on.

    Not a claim that the existing pins would miss THIS -- they would, because they name
    most of the statement's text. It is the check that survives a legitimate rewrite and
    the one that notices a column renamed underneath it, neither of which a substring
    can do.
    """
    _row(pg)
    assert _claim(engine), "the statement ran but claimed nothing on a free lease"


def test_the_second_worker_is_refused_while_the_lease_is_held(pg, engine):
    """The property the lease exists for: exactly one winner.

    Two reconcile loops in two gunicorn workers reach this within seconds of each
    other. If both claim, both upgrade, and each records the other's failure against
    the same three-attempt cap.
    """
    _row(pg)
    assert _claim(engine), "the first worker did not get the lease"
    assert _claim(engine) == [], "a second worker won a lease that was already held"


def test_a_contested_claim_does_not_raise_on_the_lease_value(pg, engine):
    """THE regression, and the reason a real database is the only witness.

    The stored lease is `<iso timestamp>|<image ref>`. The original claim cast that
    whole string to `timestamptz`, so the moment a lease existed -- which is precisely
    the contested case the guard is for -- PostgreSQL raised instead of returning no
    rows. `split_part(..., '|', 1)` takes only the timestamp half.

    A fake database returns whatever it is told to. This asserts PostgreSQL parses it.
    """
    held = f"{datetime.now(timezone.utc).isoformat()}|{_TARGET}"
    _row(pg, lease=held)
    assert _claim(engine) == [], "a held lease was either claimable or unparseable"


def test_a_lease_older_than_the_ttl_is_reclaimable(pg, engine):
    """A worker that died holding the lease must not freeze the pod forever."""
    stale = f"{(datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()}|{_TARGET}"
    _row(pg, lease=stale)
    assert _claim(engine), "a lease abandoned half an hour ago was never released"


def test_a_lease_inside_the_ttl_is_not_reclaimable(pg, engine):
    """The other side of the same boundary, or the TTL would be decoration."""
    recent = f"{(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}|{_TARGET}"
    _row(pg, lease=recent)
    assert _claim(engine) == [], "a lease taken a minute ago was treated as abandoned"


def test_only_a_provisioned_row_can_be_claimed(pg, engine):
    """An upgrade is not a create. A row mid-provision must not be swept into one."""
    _row(pg, status="connecting")
    assert _claim(engine) == [], "a row that is not provisioned was claimed for upgrade"


def test_the_claim_writes_the_lease_it_says_it_writes(pg, engine):
    """The lease must land in `backend_metadata`, or the next claim reads nothing."""
    _row(pg)
    assert _claim(engine)
    stored = pg.execute(
        "SELECT backend_metadata->>'upgradeLease' FROM personal_agent_registry WHERE user_id = %s",
        (_USER,),
    )
    value = stored[0][0]
    assert value and value.endswith(f"|{_TARGET}"), (
        "the lease value is the half the cooldown and the target check both read"
    )
