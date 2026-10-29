"""The core mirror must refuse ambiguous or unrelated PostgreSQL targets."""

import pytest
from sqlalchemy.engine import make_url

from tests.helpers import isolated_postgres


@pytest.mark.parametrize(
    "value",
    [
        "postgresql://command_test@localhost:5432/command_test?host=/tmp",
        "postgresql://command_test@localhost:5432/command_test?port=25432",
        "postgresql://command_test@127.0.0.1:25432/command_test",
        "postgresql://command_test@example.test:5432/command_test",
        "postgresql://command_test@localhost:5432/other_database",
    ],
)
def test_disposable_database_guard_refuses_unattested_targets(value, monkeypatch):
    monkeypatch.delenv("ONE_COMMAND_TEST_PG_MANIFEST", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv("CI", raising=False)
    assert not isolated_postgres.is_isolated_command_url(make_url(value))
    ci_url = make_url("postgresql://command_test@127.0.0.1:5432/command_test")
    assert not isolated_postgres.is_isolated_command_url(ci_url)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("CI", "true")
    assert isolated_postgres.is_isolated_command_url(ci_url)
    monkeypatch.setenv("PGPORT", "25432")
    assert not isolated_postgres.is_isolated_command_url(ci_url)


def test_core_preflight_refuses_other_database_overrides_before_connecting(monkeypatch):
    monkeypatch.setenv("ONE_COMMAND_TEST_PG_MANIFEST", "/nonexistent/identity.json")
    monkeypatch.setenv("REFERRAL_TEST_DATABASE_URL", "postgresql://untrusted")
    monkeypatch.setattr(
        isolated_postgres.psycopg2,
        "connect",
        lambda *args, **kwargs: pytest.fail("Unexpected database connection"),
    )
    with pytest.raises(ValueError, match="Separate database overrides"):
        isolated_postgres.preflight()
