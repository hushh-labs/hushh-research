"""PostgreSQL coverage for provider-account transition journal fencing."""

from tests.hosted_provider_transition_journal import run_transition_journal_scenario
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pilot_admission_postgres import pytestmark as pytestmark


def test_provider_account_transition_journal_is_cas_fenced_and_archived(pg, monkeypatch, tmp_path):
    run_transition_journal_scenario(pg, monkeypatch, tmp_path)
