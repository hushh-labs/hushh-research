"""Actual PostgreSQL claim/publication checks for the existing image-upgrade lease."""

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


def _shipped_claim(target_image: str, observed: dict) -> tuple[Optional[str], dict]:
    """The statement and binds `claim_image_upgrade` sends in production."""
    tap = _CapturingClient()
    repo = PersonalAgentRegistryRepo(client=tap)
    asyncio.run(
        repo.claim_image_upgrade(user_id=_USER, target_image=target_image, observed=observed)
    )
    return tap.sql, dict(tap.params or {})


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
        for name in (
            "905_personal_agent_liveness.sql",
            "906_personal_agent_user_cloud.sql",
            "914_personal_agent_billing_space_id.sql",
        ):
            server.apply_file(_REGISTRY_SCHEMA.parent / name)
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

    with engine.begin() as conn:
        observed = dict(
            conn.execute(
                text("SELECT * FROM personal_agent_registry WHERE user_id=:owner"), {"owner": _USER}
            )
            .mappings()
            .one()
        )
        sql, params = _shipped_claim(target_image, observed)
        return list(conn.execute(text(sql), params)) if sql is not None else []


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


@pytest.mark.asyncio
async def test_expired_worker_cannot_publish_over_new_claim(pg, engine):
    from db.db_client import DatabaseClient

    stale = f"{(datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()}|old|{_TARGET}"
    _row(pg, lease=stale)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    assert isinstance(lease, str) and lease != stale
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=stale,
        previous_metadata={},
        backend_metadata={"image": "old-worker"},
    )
    stored = pg.execute(
        "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
    )[0][0]
    assert stored == {"upgradeLease": lease}


@pytest.mark.asyncio
async def test_owner_claim_publishes_delta_without_dropping_new_heartbeat(pg, engine):
    import json

    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    previous = {"image": "old", "observed": {"imageTag": "old"}, "upgrade": {"attempts": 1}}
    current = {**previous, "observed": {"imageTag": "new"}, "extra": "keep", "upgradeLease": lease}
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(current), _USER),
    )
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=previous,
        backend_metadata={"image": "new"},
        liveness_mode="economy",
    )
    row = pg.execute(
        "SELECT backend_metadata, liveness_mode FROM personal_agent_registry WHERE user_id=%s",
        (_USER,),
    )[0]
    assert row == ({"image": "new", "observed": {"imageTag": "new"}, "extra": "keep"}, "economy")
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=previous,
        backend_metadata={"image": "replay"},
    )


@pytest.mark.asyncio
async def test_lifecycle_transition_refuses_old_upgrade_publication(pg, engine):
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    pg.execute("UPDATE personal_agent_registry SET status='migrating' WHERE user_id=%s", (_USER,))
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata={},
        backend_metadata={"image": "old-worker"},
    )
    assert pg.execute(
        "SELECT status, backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
    )[0] == ("migrating", {"upgradeLease": lease})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed_field",
    [
        "liveness_mode",
        "project",
        "region",
        "service",
        "serviceUid",
        "url",
        "runtime_service_account",
        "tenancy",
        "ingress",
        "substrateReceipt",
    ],
)
async def test_changed_host_refuses_claim_and_old_publication(pg, engine, changed_field):
    import json

    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    original = await repo.get(_USER)
    pg.execute(
        "UPDATE personal_agent_registry SET user_cloud_region='europe-west1' WHERE user_id=%s",
        (_USER,),
    )
    assert (
        await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=original)
        is None
    )
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    assert lease
    if changed_field == "liveness_mode":
        pg.execute(
            "UPDATE personal_agent_registry SET liveness_mode='economy' WHERE user_id=%s", (_USER,)
        )
    else:
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata || %s::jsonb WHERE user_id=%s",
            (
                json.dumps(
                    {
                        changed_field: {"owner": "replacement"}
                        if changed_field == "substrateReceipt"
                        else "replacement"
                    }
                ),
                _USER,
            ),
        )
    before = pg.execute(
        "SELECT liveness_mode, backend_metadata FROM personal_agent_registry WHERE user_id=%s",
        (_USER,),
    )[0]
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        expected_lease=lease,
        observed=observed,
        previous_metadata={},
        backend_metadata={"image": "stale"},
        liveness_mode="warm",
    )
    assert (
        pg.execute(
            "SELECT liveness_mode, backend_metadata FROM personal_agent_registry WHERE user_id=%s",
            (_USER,),
        )[0]
        == before
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata", [None, "null"])
async def test_claim_distinguishes_sql_null_from_json_null(pg, engine, metadata):
    from db.db_client import DatabaseClient

    _row(pg)
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb WHERE user_id=%s",
        (metadata, _USER),
    )
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    stored = pg.execute(
        "SELECT backend_metadata->>'upgradeLease' FROM personal_agent_registry WHERE user_id=%s",
        (_USER,),
    )[0][0]
    if metadata is None:
        assert lease and stored == lease
    else:
        assert lease is None and stored is None


@pytest.mark.asyncio
async def test_equivalent_timestamp_offsets_preserve_claim(pg, engine):
    from db.db_client import DatabaseClient

    _row(pg)
    pg.execute(
        "UPDATE personal_agent_registry SET user_cloud_authorized_at=updated_at WHERE user_id=%s",
        (_USER,),
    )
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    for key in ("updated_at", "user_cloud_authorized_at"):
        value = observed[key]
        instant = datetime.fromisoformat(value) if isinstance(value, str) else value
        observed[key] = instant.astimezone(timezone(timedelta(hours=-7))).isoformat()
    assert await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
