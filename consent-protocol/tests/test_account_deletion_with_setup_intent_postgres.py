"""A person who pressed Connect and left can still delete their account (real PostgreSQL).

Since 2026-10-06 the own-cloud begin routes write a ``consent_pending`` row into
``byoc_setup_jobs`` before the cloud's sign-in. Account deletion refused any setup
row, so a person who began and never finished could no longer erase. An untouched
intent (no project, no authorization attempt) holds no resource and must read as
absent, and the erasure transaction must remove it. Any other row still refuses.
Migrations 900-950 run verbatim, so the 928 authorization-attempts trigger judges
the DELETE.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.account_service import (
    AccountService,
    PersonalAgentDeprovisioningRequiredError,
)
from hushh_mcp.services.byoc_setup_intent import is_untouched_intent, record_intent
from tests import standby_postgres_support as support
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.standby_postgres_support import OWNER, Db, run

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


@pytest.fixture(scope="module")
def server():
    yield from support.start_server()


@pytest.fixture
def pg(server):
    support.reset(server)
    server.execute("DELETE FROM byoc_setup_jobs")
    return server


def _begin(pg: TempPostgres, provider: str = "gcp") -> None:
    assert run(record_intent(OWNER, provider=provider, project="typed-name", client=Db(pg)))


def _job(pg: TempPostgres) -> dict | None:
    rows = pg.execute("SELECT to_jsonb(j) FROM byoc_setup_jobs AS j WHERE user_id=%s", (OWNER,))
    return rows[0][0] if rows else None


def _erase(pg: TempPostgres) -> dict[str, bool]:
    from sqlalchemy import text

    results: dict[str, bool] = {}
    with Db(pg).engine.begin() as conn:
        conn.execute(text("SELECT 1"))
        AccountService()._delete_personal_agent_state(
            conn, params={"user_id": OWNER}, results=results
        )
    return results


@pytest.mark.parametrize("provider", ["gcp", "azure"])
def test_an_untouched_intent_does_not_block_deletion_and_is_erased(pg, provider):
    _begin(pg, provider)
    assert is_untouched_intent(_job(pg))

    results = _erase(pg)

    assert results["personal_agent_external_resources_absent"] is True
    assert _job(pg) is None


@pytest.mark.parametrize(
    "touch",
    [
        "UPDATE byoc_setup_jobs SET project_id='owner-project'",
        "UPDATE byoc_setup_jobs SET status='running', stage='deploying'",
        "UPDATE byoc_setup_jobs SET status='succeeded', stage='recorded'",
    ],
)
def test_any_row_beyond_an_untouched_intent_still_refuses(pg, touch):
    _begin(pg)
    pg.execute(touch)
    assert not is_untouched_intent(_job(pg))

    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        _erase(pg)
    assert _job(pg) is not None


def test_a_row_with_an_authorization_attempt_is_never_untouched():
    job = {
        "stage": "consent_pending",
        "status": "pending",
        "project_id": "",
        "authorization_attempts": {"a1": {"state": "issued"}},
    }
    assert not is_untouched_intent(job)
    # A database before migration 928 has no such column: that reads as no attempt.
    assert is_untouched_intent({k: v for k, v in job.items() if k != "authorization_attempts"})
    assert not is_untouched_intent(None)
