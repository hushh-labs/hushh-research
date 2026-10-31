"""Static rollout contracts for hosted One Location read-only state."""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SYNC_SCRIPT = _REPO_ROOT / "scripts/ops/sync_backend_runtime_secrets.py"
_SERVICE = _REPO_ROOT / "consent-protocol/hushh_mcp/services/one_location_agent_service.py"
_WORKFLOWS = {
    lane: (_REPO_ROOT / f".github/workflows/deploy-{lane}.yml").read_text()
    for lane in ("dev", "production", "uat")
}


def test_hosted_sync_default_is_fail_closed_without_changing_service_semantics():
    sync_source = _SYNC_SCRIPT.read_text()
    service_source = _SERVICE.read_text()

    assert re.search(
        r'add_argument\("--one-location-read-only-state-enabled", default="false"\)',
        sync_source,
    )
    assert re.search(
        r'os\.getenv\("ONE_LOCATION_READ_ONLY_STATE_ENABLED"\) or "true"',
        service_source,
    )


def test_dev_and_production_pin_the_hosted_rollout_off():
    for lane in ("dev", "production"):
        assert '--one-location-read-only-state-enabled "false"' in _WORKFLOWS[lane]


def test_uat_defaults_off_and_verifies_scheduler_before_secret_sync():
    workflow = _WORKFLOWS["uat"]
    guard_name = "Verify One Location read-only rollout prerequisites"
    sync_name = "Sync canonical hosted runtime secrets"

    assert "vars.ONE_LOCATION_READ_ONLY_STATE_ENABLED || 'false'" in workflow
    assert workflow.index(guard_name) < workflow.index(sync_name)

    guard = workflow[workflow.index(guard_name) : workflow.index(sync_name)]
    sync = workflow[workflow.index(sync_name) :]
    assert "one-location-retention-purge-uat" in guard
    assert '--project="${GCP_PROJECT_ID}"' in guard
    assert '--location="${GCP_REGION}"' in guard
    assert "requested%%[![:space:]]*" in guard
    assert "requested##*[![:space:]]" in guard
    assert 'echo "enabled=${normalized_requested}" >> "${GITHUB_OUTPUT}"' in guard
    assert "ONE_LOCATION_READ_ONLY_STATE_ENABLED must be a recognized boolean" in guard
    assert "--format=json" in guard
    assert 'headers = target.get("headers") or {}' in guard
    assert '"true" if auth_present else "false"' in guard
    assert '"${scheduler_state}" != "ENABLED"' in guard
    assert '"${scheduler_method^^}" != "POST"' in guard
    assert "x-hushh-maintenance-token" in guard
    assert "/api/one/location/retention/purge?older_than_hours=12" in guard
    assert 'expected_uri="${CONSENT_API_RUNTIME_ORIGIN%/}${expected_target}"' in guard
    assert '"${scheduler_uri}" != "${expected_uri}"' in guard

    assert (
        "--one-location-read-only-state-enabled "
        '"${{ steps.one_location_read_only_rollout.outputs.enabled }}"'
    ) in sync

    # The scheduler JSON is consumed through a private pipe; only a boolean
    # leaves the parser, so the credential value never reaches workflow logs.
    assert "scheduler_auth_present" in guard
    assert "Header values remain in" in guard
    assert "ONE_LOCATION_RETENTION_TOKEN" not in guard


def test_uat_guard_matches_the_canonical_scheduler_contract():
    workflow = _WORKFLOWS["uat"]
    scheduler = (_REPO_ROOT / "deploy/one-location/setup_retention_scheduler.sh").read_text()

    assert 'JOB_NAME="${JOB_NAME:-one-location-retention-purge-uat}"' in scheduler
    assert (
        'URI="${BACKEND_URL%/}/api/one/location/retention/purge?older_than_hours=${OLDER_THAN_HOURS}"'
        in scheduler
    )
    assert "one-location-retention-purge-uat" in workflow
    assert "/api/one/location/retention/purge?older_than_hours=12" in workflow
