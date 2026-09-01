"""Dev-only parked migration lane.

Guards the contract that lets the 900-band migrations apply in dev WITHOUT
touching the UAT/production schema contracts:

* the parked files stay under ``db/migrations/parked/`` and out of
  ``release_migration_manifest.json`` (so the repo migration head stays 131);
* the lane activates on the dev GCP project id and nowhere else;
* the release lane is unchanged when the dev lane is off.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# db/migrate.py resolves DB_* at import time and sys.exit(1)s when they are
# absent, so seed throwaway values before importing it. These never open a
# connection — every test below exercises pure manifest/path/gating logic.
os.environ.setdefault("DB_USER", "test-user")
os.environ.setdefault("DB_PASSWORD", "test-password")
os.environ.setdefault("DB_HOST", "127.0.0.1")

from db import migrate  # noqa: E402
from db.migration_authority import build_manifest_entries  # noqa: E402

DB_DIR = Path(migrate.__file__).resolve().parent
MIGRATIONS_DIR = DB_DIR / "migrations"
PARKED_DIR = MIGRATIONS_DIR / "parked"

EXPECTED_PARKED_MIGRATIONS = (
    "900_personal_agent_registry.sql",
    "901_agent_prompt_versions.sql",
    "902_personal_agent_tombstone_hushh_id_index.sql",
    "903_webauthn_credentials.sql",
    "904_consent_audit_receipts.sql",
    "905_personal_agent_liveness.sql",
    "906_personal_agent_user_cloud.sql",
    "907_pod_lifecycle_events.sql",
    "908_personal_agent_tombstone_metadata.sql",
    "909_byoc_setup_jobs.sql",
    "910_personal_agent_status_needs_reinit.sql",
    "911_pod_migration_jobs.sql",
    "912_personal_agent_status_migrating.sql",
    "913_consent_audit_receipts_ledger.sql",
)


def _migration_version(filename: str) -> int:
    return int(filename.split("_", 1)[0])


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def test_dev_manifest_lists_every_parked_file_and_nothing_else() -> None:
    """The manifest and the directory must agree in BOTH directions.

    Asserting a literal count here only ever restated the expected tuple, and it
    broke on every added migration without catching anything the tuple comparison
    missed. Comparing against the real directory is what has teeth: a file dropped
    into ``parked/`` but never manifested would silently never apply in dev, and a
    manifest entry with no file would fail the lane at deploy time instead of here.
    """
    ordered = migrate._load_dev_manifest(migrate.DEV_MANIFEST_PATH)

    assert ordered == EXPECTED_PARKED_MIGRATIONS
    on_disk = sorted(p.name for p in PARKED_DIR.glob("*.sql"))
    assert sorted(ordered) == on_disk, "db/migrations/parked/ and the dev manifest disagree"


def test_dev_manifest_is_in_numeric_order() -> None:
    """902 indexes a table 900 creates, so ordering is load-bearing."""
    versions = [_migration_version(name) for name in EXPECTED_PARKED_MIGRATIONS]

    assert versions == sorted(versions)
    assert len(set(versions)) == len(versions), "duplicate migration number in the parked band"
    # The band itself is the contract: staying in 900+ is what keeps these files
    # from colliding with main's fast-moving migration head on every branch sync.
    assert all(900 <= version < 1000 for version in versions)


def test_dev_manifest_declares_the_same_dev_project_as_the_gate() -> None:
    """Drift guard: the manifest's documented target must match the code gate."""
    payload = json.loads(migrate.DEV_MANIFEST_PATH.read_text(encoding="utf-8"))

    assert payload["target_gcp_project_id"] == migrate.DEV_GCP_PROJECT_ID
    assert payload["migrations_subdir"] == "parked"


def test_dev_manifest_rejects_overlap_with_the_release_manifest(tmp_path: Path) -> None:
    """Fail closed: the dev lane must never smuggle in a release migration."""
    smuggled = migrate.RELEASE_MIGRATION_FILES[0]
    bad = tmp_path / "dev_migration_manifest.json"
    bad.write_text(json.dumps({"ordered_migrations": [smuggled]}), encoding="utf-8")

    with pytest.raises(RuntimeError, match="must not repeat release migrations"):
        migrate._load_dev_manifest(bad)


def test_dev_manifest_rejects_an_empty_or_missing_manifest(tmp_path: Path) -> None:
    missing = tmp_path / "nope.json"
    with pytest.raises(FileNotFoundError):
        migrate._load_dev_manifest(missing)

    empty = tmp_path / "dev_migration_manifest.json"
    empty.write_text(json.dumps({"ordered_migrations": []}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="must define ordered_migrations"):
        migrate._load_dev_manifest(empty)


# ---------------------------------------------------------------------------
# Parked path resolution
# ---------------------------------------------------------------------------


def test_parked_dir_resolves_under_migrations_parked() -> None:
    assert migrate.PARKED_MIGRATIONS_DIR == MIGRATIONS_DIR / "parked"
    assert migrate.PARKED_MIGRATIONS_DIR.is_dir()
    assert migrate.PARKED_MIGRATIONS_DIR.name == "parked"


def test_parked_entries_build_from_the_parked_dir() -> None:
    """Bare filenames + the parked dir is the only resolution that works.

    ``build_manifest_entries`` derives the migration id from the start of the
    filename, so a ``parked/``-prefixed name would not parse.
    """
    ordered = migrate._load_dev_manifest(migrate.DEV_MANIFEST_PATH)
    entries = build_manifest_entries(migrate.PARKED_MIGRATIONS_DIR, ordered)

    expected_ids = [name.split("_", 1)[0] for name in EXPECTED_PARKED_MIGRATIONS]
    assert [entry.migration_id for entry in entries] == expected_ids
    assert [entry.filename for entry in entries] == list(EXPECTED_PARKED_MIGRATIONS)
    assert all(entry.sql.strip() for entry in entries)
    assert all(len(entry.checksum_sha256) == 64 for entry in entries)


def test_parked_files_are_not_resolvable_from_the_release_migrations_dir() -> None:
    """Proves the files really are parked, not sitting in the active sequence."""
    for filename in EXPECTED_PARKED_MIGRATIONS:
        assert not (MIGRATIONS_DIR / filename).exists()


def test_ledger_schema_path_exists() -> None:
    assert migrate.LEDGER_SCHEMA_PATH.is_file()
    assert "schema_migrations" in migrate.LEDGER_SCHEMA_PATH.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Environment gating
# ---------------------------------------------------------------------------


def test_dev_extra_activates_for_the_dev_project() -> None:
    assert migrate.dev_extra_active(project_id="hushh-pda-dev") is True


@pytest.mark.parametrize(
    "project_id",
    [
        "hushh-pda",  # production — also a PREFIX of hushh-pda-dev
        "hushh-pda-uat",  # uat
        "hushh-pda-dev-2",  # near miss
        "not-hushh-pda-dev",  # suffix match attempt
        "",
        "   ",
    ],
)
def test_dev_extra_does_not_activate_for_non_dev_projects(project_id: str) -> None:
    assert migrate.dev_extra_active(project_id=project_id) is False


def test_dev_extra_does_not_activate_when_project_is_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GCP_PROJECT_ID", raising=False)
    assert migrate.dev_extra_active() is False


def test_dev_extra_reads_gcp_project_id_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The dev workflow exports GCP_PROJECT_ID as a workflow-level env."""
    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda-dev")
    assert migrate.dev_extra_active() is True

    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda")
    assert migrate.dev_extra_active() is False

    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda-uat")
    assert migrate.dev_extra_active() is False


def test_explicit_flag_activates_regardless_of_project() -> None:
    """--dev-extra is the manual/local escape hatch."""
    assert migrate.dev_extra_active(explicit=True, project_id="hushh-pda") is True
    assert migrate.dev_extra_active(explicit=True, project_id="") is True


def test_dev_gcp_project_id_is_matched_exactly_not_by_prefix() -> None:
    """Regression guard for the prefix trap.

    Production's project id ("hushh-pda") is a prefix of the dev one, so any
    startswith/substring comparison would fire in production.
    """
    assert migrate.DEV_GCP_PROJECT_ID == "hushh-pda-dev"
    assert migrate.DEV_GCP_PROJECT_ID.startswith("hushh-pda")
    assert migrate.dev_extra_active(project_id="hushh-pda") is False


# ---------------------------------------------------------------------------
# The release lane is untouched
# ---------------------------------------------------------------------------


def test_release_manifest_excludes_every_parked_migration() -> None:
    release_set = set(migrate.RELEASE_MIGRATION_FILES)

    for filename in EXPECTED_PARKED_MIGRATIONS:
        assert filename not in release_set

    for group in (migrate.IAM_MIGRATION_FILES, migrate.PKM_MIGRATION_FILES):
        assert not set(group) & set(EXPECTED_PARKED_MIGRATIONS)


def test_release_manifest_still_matches_the_repo_migration_head() -> None:
    """Mirrors scripts/ops/verify_release_migration_contract.py.

    The gate scans db/migrations/ with is_file(), so the parked subdirectory is
    invisible to it. If the parked files were ever moved into the active
    sequence, the repo head would jump to 904 and this would fail.
    """
    repo_versions = sorted(
        _migration_version(path.name)
        for path in MIGRATIONS_DIR.iterdir()
        if path.is_file() and path.name[:3].isdigit() and path.suffix == ".sql"
    )
    # The release lane is the production-safe base PLUS every environment overlay
    # (e.g. the isolated UAT-only hushh_tech foundation at 170, which is not in the
    # base and never reaches production). Every active .sql under db/migrations/
    # must be accounted for by one of them, so the head is the max across all.
    release_versions = [_migration_version(name) for name in migrate.BASE_RELEASE_MIGRATION_FILES]
    for overlay in migrate.RELEASE_ENVIRONMENT_OVERLAYS.values():
        release_versions.extend(_migration_version(name) for name in overlay)

    assert max(release_versions) == max(repo_versions)
    assert max(repo_versions) < 900, "parked migrations leaked into the active sequence"


def test_uat_and_prod_contracts_still_match_the_manifest_head() -> None:
    """The dev lane must not move either environment's expected version.

    Each environment pins ITS release head: production stays on the base lane,
    while UAT additionally carries the isolated overlay (e.g. hushh_tech's 170).
    """
    contract_environments = {
        "uat_integrated_schema.json": "uat",
        "prod_core_schema.json": "production",
    }
    for contract_name, environment in contract_environments.items():
        environment_head = max(
            _migration_version(name) for name in migrate.release_migration_files(environment)
        )
        contract = json.loads((DB_DIR / "contracts" / contract_name).read_text(encoding="utf-8"))
        assert contract["migration_version_policy"] == "exact"
        assert contract["expected_migration_version"] == environment_head


def test_release_migration_files_are_exactly_the_release_manifest() -> None:
    """The dev lane adds nothing to the release lane's ordered set."""
    payload = json.loads((DB_DIR / "release_migration_manifest.json").read_text(encoding="utf-8"))

    assert list(migrate.RELEASE_MIGRATION_FILES) == payload["ordered_migrations"]
    assert all(
        (MIGRATIONS_DIR / filename).is_file() for filename in migrate.RELEASE_MIGRATION_FILES
    )


def test_apply_migration_files_still_defaults_to_the_release_migrations_dir() -> None:
    """The release applier was not repointed at the parked directory."""
    assert migrate.MIGRATIONS_DIR == MIGRATIONS_DIR
    assert migrate.MIGRATIONS_DIR != migrate.PARKED_MIGRATIONS_DIR
