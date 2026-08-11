"""Deploy-config contract for the Kai analyze ("debate") durable run store.

Regression guard for the multi-instance prod-parity incident
([[hushh-research-debate-prod-parity]]): Kai analyze is two requests —
``POST /api/kai/analyze/run/start`` creates an in-memory run on one Cloud Run
instance, and ``GET /api/kai/analyze/run/{id}/stream`` may land on a *different*
instance and 404 with ``ANALYZE_RUN_NOT_FOUND``. Migration 125 +
``KAI_ANALYZE_DURABLE_RUN_STORE`` fix it durably by persisting a coarse terminal
checkpoint so the stream request can replay the DecisionCard from Postgres.

The original bug hid in production because UAT and prod diverged: a fix can pass
every UAT check while prod silently runs the broken path. These tests make the
enable-state an explicit, reviewed contract so the durable store cannot be
silently disabled in prod (reintroducing the 404) or enabled without its table.

Rollback note — this contract intentionally pins the *steady-state* prod value.
Emergency rollback is a Cloud Run revision rollback (handled by the deploy
pipeline's auto-rollback; it touches no files and this test does not block it).
A *deliberate* long-term disable is a reviewed act: flip
``deploy-production.yml`` **and** ``PROD_DURABLE_RUN_STORE_EXPECTED`` below to
``"false"`` in the same PR.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Steady-state expectation for the production durable run store. See the
# module docstring for the deliberate-rollback procedure.
PROD_DURABLE_RUN_STORE_EXPECTED = "true"

_FLAG = "_KAI_ANALYZE_DURABLE_RUN_STORE"
_FLAG_VALUE_RE = re.compile(rf"{re.escape(_FLAG)}=([A-Za-z0-9_]+)")

_MIGRATION_FILENAME = "125_kai_analyze_run_store.sql"


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _flag_values(workflow_text: str) -> list[str]:
    return _FLAG_VALUE_RE.findall(workflow_text)


def test_uat_exercises_durable_run_store() -> None:
    """UAT is the canary: it must always run the durable path so the
    cross-instance regression surfaces in UAT before it can reach prod."""
    values = _flag_values(_read(".github/workflows/deploy-uat.yml"))
    assert values, f"{_FLAG} missing from deploy-uat.yml"
    assert all(v == "true" for v in values), (
        f"UAT must keep {_FLAG}=true so the durable run store is continuously "
        f"exercised; found {values}"
    )


def test_prod_declares_durable_run_store_flag_explicitly() -> None:
    """The flag must be present with an explicit boolean literal. An empty or
    missing value silently defaults OFF in runtime_settings
    (``_bool_from_value(..., default=False)``), which is exactly the invisible
    failure mode this guard exists to prevent."""
    values = _flag_values(_read(".github/workflows/deploy-production.yml"))
    assert len(values) == 1, (
        f"expected exactly one {_FLAG}=<value> in deploy-production.yml, found {values}"
    )
    assert values[0] in {"true", "false"}, (
        f"{_FLAG} must be an explicit boolean literal, got {values[0]!r}"
    )


def test_prod_enables_durable_run_store() -> None:
    """Prod steady state is ON. If a bad merge or edit flips this back to
    ``false`` while UAT stays ``true`` the multi-instance 404 returns in
    production only — the precise divergence that caused the original
    incident. Change requires editing both the workflow and the expectation
    constant above (see module docstring)."""
    values = _flag_values(_read(".github/workflows/deploy-production.yml"))
    assert values == [PROD_DURABLE_RUN_STORE_EXPECTED], (
        f"production {_FLAG} must equal {PROD_DURABLE_RUN_STORE_EXPECTED!r}; found {values}"
    )


def test_durable_run_store_migration_present_when_enabled() -> None:
    """Whenever the durable store is enabled, its table migration must ship in
    the canonical release manifest. Enabling reads/writes without the
    ``kai_analyze_runs`` table would degrade to a silent no-op (the store is
    fail-safe and never raises), masking a broken deploy as healthy."""
    if PROD_DURABLE_RUN_STORE_EXPECTED != "true":
        return
    manifest = json.loads(_read("consent-protocol/db/release_migration_manifest.json"))
    ordered = manifest.get("ordered_migrations", [])
    assert _MIGRATION_FILENAME in ordered, (
        f"{_MIGRATION_FILENAME} must be in release_migration_manifest.json "
        f"while the durable run store is enabled"
    )
    migration_path = REPO_ROOT / "consent-protocol/db/migrations" / _MIGRATION_FILENAME
    assert migration_path.is_file(), f"missing migration file {migration_path}"


def test_backend_cloudbuild_plumbs_flag_to_runtime() -> None:
    """The substitution set in the deploy workflows only takes effect if the
    Cloud Build backend config plumbs it into the Cloud Run runtime env. Guard
    both the wiring and the empty default (empty => runtime default OFF)."""
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    assert f'add_env "{_FLAG.lstrip("_")}" "${{{_FLAG}}}"' in backend_build, (
        f"{_FLAG} not plumbed into Cloud Run env in backend.cloudbuild.yaml"
    )
    assert f'{_FLAG}: ""' in backend_build, (
        f"{_FLAG} default substitution missing from backend.cloudbuild.yaml"
    )
