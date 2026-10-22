"""The oracle, proven against the KNOWN-GOOD engine first.

Boots a disposable Postgres 16 (initdb, unix socket, real migration files),
binds PostgresPkmWriteEngine to it through the same named-argument call shape
production uses, and runs every conformance scenario. This is the S2 gate the
port depends on: an oracle that has never passed against the genuine stored
procedures proves nothing about a replacement.

Skips -- loudly, with the reason -- only when no PostgreSQL binaries exist on
the host. The CI image carries them; a skip in CI is a regression to chase, not
a pass.
"""

from __future__ import annotations

from typing import Optional

import pytest

from hushh_mcp.services.pkm_write_engine import PostgresPkmWriteEngine
from tests.pkm_conformance import oracle
from tests.pkm_conformance.postgres_harness import REHEARSAL, TempPostgres, find_pg_bin

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="no PostgreSQL binaries on this host")


@pytest.fixture(scope="module")
def cluster():
    pg = TempPostgres()
    pg.start()
    yield pg
    pg.stop()


class _PostgresPeer:
    def __init__(self, pg: TempPostgres) -> None:
        self.pg = pg
        self.engine = PostgresPkmWriteEngine(pg.make_run_rpc())

    async def create_user(self, user_id: str) -> None:
        self.pg.execute(
            "INSERT INTO vault_keys (user_id, vault_status, primary_method, created_at, "
            "updated_at) VALUES (%s, 'placeholder', 'passphrase', 0, 0) "
            "ON CONFLICT (user_id) DO NOTHING",
            (user_id,),
        )

    async def read_domain_summary(self, user_id: str, domain: str) -> Optional[dict]:
        rows = self.pg.execute(
            "SELECT domain_summaries -> %s FROM pkm_index WHERE user_id = %s",
            (domain, user_id),
        )
        return rows[0][0] if rows and rows[0][0] is not None else None


@pytest.mark.asyncio
async def test_every_scenario_passes_against_the_real_stored_procedures(cluster):
    executed = await oracle.run_all(_PostgresPeer(cluster))
    # The count IS the assertion: a scenario that silently stopped running is a
    # hole in the oracle, and holes are how ports lose user data politely.
    assert executed == [s.__name__ for s in oracle.SCENARIOS]
    assert len(executed) == 9


def test_the_upstream_rehearsal_passes_on_the_harness_schema(cluster):
    """Anchor: the 509-line zero-loss rehearsal -- the engine's original
    executable spec -- runs to completion on prelude + MIGRATIONS. This pins the
    harness schema to the real one; if a migration the chain needs goes missing
    from the list, this fails before the oracle can mislead."""
    # The upstream rehearsal also checks confirmed Memory rewards. Install the
    # real referral dependency slice only here; the independent engine oracle
    # keeps its minimal PKM chain. Never synthesize reward settings or a ledger.
    cluster.execute("CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY)")
    cluster.execute("CREATE TABLE one_location_circles(id UUID PRIMARY KEY)")
    cluster.execute(
        "CREATE TABLE connections(id UUID PRIMARY KEY, user_a_id TEXT, user_b_id TEXT, status TEXT)"
    )
    migrations = REHEARSAL.parent.parent / "migrations"
    for number in (55, 165, 270, 271, 272, 289, 338, 347, 348, 349):
        cluster.apply_file(next(migrations.glob(f"{number:03d}_*.sql")))
    cluster.apply_file(REHEARSAL)
