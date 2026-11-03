from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_identity import (
    MANIFEST_SCHEMA,
    OperatorRefused,
    canonical_manifest_sha256,
    execute_action,
)
from tests.helpers.hosted_provider_account_ops import _Runtime, _snapshot


def test_operator_inventory_import_does_not_require_hub_crypto_secrets():
    environment = os.environ.copy()
    for name in (
        "APP_SIGNING_KEY",
        "APP_SIGNING_KEY_CIPHERTEXT",
        "VAULT_DATA_KEY",
        "VAULT_DATA_KEY_CIPHERTEXT",
        "KMS_KEK_RESOURCE",
    ):
        environment.pop(name, None)
    # Local .env files must not repopulate the keys removed for this check.
    environment["PYTHON_DOTENV_DISABLED"] = "1"

    result = subprocess.run(
        [sys.executable, "-c", "import scripts.ops.hosted_provider_account_inventory"],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
async def test_mutating_action_defaults_to_report_only_without_lifecycle_call():
    snapshot = _snapshot()
    runtime = _Runtime(snapshot)

    result = await execute_action(
        runtime,
        action="associate-account",
        hushh_id=next(iter(PLACEMENTS)),
        environment=None,
        apply=False,
        manifest_sha256=None,
    )

    assert result["reportOnly"] is True
    assert result["manifestSha256"] == snapshot.sha256
    assert runtime.inventory_calls == 1
    assert runtime.actions == []


@pytest.mark.asyncio
async def test_apply_requires_explicit_dev_and_exact_reviewed_manifest_before_dispatch():
    snapshot = _snapshot()
    runtime = _Runtime(snapshot)
    hushh_id = next(iter(PLACEMENTS))

    with pytest.raises(OperatorRefused, match="--environment dev"):
        await execute_action(
            runtime,
            action="resume",
            hushh_id=hushh_id,
            environment="uat",
            apply=True,
            manifest_sha256=snapshot.sha256,
        )
    assert runtime.actions == []

    stale_runtime = _Runtime(snapshot)
    with pytest.raises(OperatorRefused, match="reviewed manifest SHA is stale"):
        await execute_action(
            stale_runtime,
            action="resume",
            hushh_id=hushh_id,
            environment="dev",
            apply=True,
            manifest_sha256="0" * 64,
        )
    assert stale_runtime.actions == []


@pytest.mark.asyncio
async def test_apply_reinventory_blocks_identity_drift_and_protected_projects():
    hushh_id = next(iter(PLACEMENTS))
    reviewed = _snapshot(hushh_id=hushh_id)
    changed = _snapshot(hushh_id=hushh_id, identity_state="unresolved")
    runtime = _Runtime(reviewed, changed)

    with pytest.raises(OperatorRefused, match="fresh inventory contains unresolved"):
        await execute_action(
            runtime,
            action="remove",
            hushh_id=hushh_id,
            environment="dev",
            apply=True,
            manifest_sha256=reviewed.sha256,
        )
    assert runtime.inventory_calls == 2
    assert runtime.actions == []

    protected = _snapshot(hushh_id=hushh_id, project_id="hushh-pda-dev")
    with pytest.raises(OperatorRefused, match="protected project"):
        await execute_action(
            _Runtime(protected),
            action="remove",
            hushh_id=hushh_id,
            environment=None,
            apply=False,
            manifest_sha256=None,
        )


@pytest.mark.asyncio
async def test_reviewed_synthetic_removal_routes_once_after_fresh_manifest_match():
    hushh_id = next(iter(PLACEMENTS))
    reviewed = _snapshot(hushh_id=hushh_id)
    runtime = _Runtime(reviewed, reviewed)

    result = await execute_action(
        runtime,
        action="remove",
        hushh_id=hushh_id,
        environment="dev",
        apply=True,
        manifest_sha256=reviewed.sha256,
    )

    assert result["result"] == {"status": "synthetic-complete"}
    assert runtime.inventory_calls == 2
    assert len(runtime.actions) == 1
    assert runtime.actions[0][0] == "remove"


def test_canonical_manifest_digest_ignores_mapping_insertion_order():
    left = {"schema": MANIFEST_SCHEMA, "placements": [{"projectId": "project-a", "owner": 1}]}
    right = {"placements": [{"owner": 1, "projectId": "project-a"}], "schema": MANIFEST_SCHEMA}

    assert canonical_manifest_sha256(left) == canonical_manifest_sha256(right)
