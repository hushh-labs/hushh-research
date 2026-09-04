import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"

_STATUS_MIGRATION = "095_one_kyc_needs_confirm_status.sql"


def _status_constraint_values(migration_name: str) -> set[str] | None:
    sql = (MIGRATIONS_DIR / migration_name).read_text(encoding="utf-8")
    match = re.search(
        r"ADD\s+CONSTRAINT\s+one_kyc_workflows_status_check\s+CHECK\s*"
        r"\(\s*status\s+IN\s*\((?P<body>.*?)\)\s*\)",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if match is None:
        return None
    return set(re.findall(r"'([^']+)'", match.group("body")))


def test_migration_095_allows_needs_confirm():
    values = _status_constraint_values(_STATUS_MIGRATION)
    assert values is not None, "095 must (re)define one_kyc_workflows_status_check"
    assert "needs_confirm" in values


def test_migration_095_keeps_all_prior_statuses():
    # The status CHECK is replayed as a whole; 095 must not drop any status the
    # workflow state machine still uses.
    values = _status_constraint_values(_STATUS_MIGRATION)
    assert values is not None
    assert {
        "needs_client_connector",
        "needs_scope",
        "needs_confirm",
        "needs_documents",
        "drafting",
        "waiting_on_user",
        "waiting_on_counterparty",
        "completed",
        "blocked",
    } <= values


def test_migration_095_is_in_release_manifest():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assert _STATUS_MIGRATION in manifest["ordered_migrations"]
    assert _STATUS_MIGRATION in manifest["groups"]["iam"]


def test_every_replayed_status_check_allows_needs_confirm():
    # The release lane REPLAYS every migration in order on each deploy. Any file
    # that (re)defines one_kyc_workflows_status_check must allow the full current
    # status set — otherwise replaying it re-validates existing rows and fails
    # once a newer status (e.g. needs_confirm) is in use, before a later
    # migration can widen the constraint again. Regression guard for the UAT
    # deploy break caused by migration 050 omitting 'needs_confirm'.
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    offenders = []
    for name in manifest["ordered_migrations"]:
        values = _status_constraint_values(name)
        if values is None:
            continue
        if "needs_confirm" not in values:
            offenders.append(name)
    assert not offenders, (
        "these replayed migrations re-add one_kyc_workflows_status_check without "
        f"'needs_confirm' and will break deploys: {offenders}"
    )
