from __future__ import annotations

import json
import uuid
from pathlib import Path

from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    connector_key_fingerprint,
)
from scripts.uat_kai_regression_smoke import (
    SAMPLE_BROKERAGE_PATH,
    UatKaiSmoke,
    _build_manifest_artifacts,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_sample_brokerage_manifest_exposes_portfolio_without_provenance() -> None:
    sample = json.loads(SAMPLE_BROKERAGE_PATH.read_text(encoding="utf-8"))
    domain_data = {
        "schema_version": 3,
        "portfolio": sample,
        "updated_at": "2026-07-15T00:00:00Z",
    }

    structure_decision, manifest = _build_manifest_artifacts(
        domain="financial",
        domain_data=domain_data,
        previous_manifest={"manifest_version": 4, "paths": []},
    )

    assert structure_decision["action"] == "extend_domain"
    assert "portfolio" in manifest["top_level_scope_paths"]
    assert "portfolio.holdings._items.symbol" in manifest["externalizable_paths"]
    assert not any("provenance" in path for path in manifest["externalizable_paths"])
    assert not any(path.endswith("updated_at") for path in manifest["externalizable_paths"])


def test_sample_brokerage_fixture_has_expected_holdings() -> None:
    sample = json.loads(SAMPLE_BROKERAGE_PATH.read_text(encoding="utf-8"))

    assert len(sample["holdings"]) == 20
    assert sample["account_info"]["brokerage"] == "Demo Brokerage"


def test_reviewer_approval_encrypts_a_bound_envelope_v2() -> None:
    smoke = UatKaiSmoke.__new__(UatKaiSmoke)
    connector = smoke._new_connector_keypair()
    aad = ConsentExportAadV2(
        app_id="app_reviewer_smoke",
        grant_id="req_reviewer_smoke",
        export_id=str(uuid.uuid4()),
        revision=1,
        machine_scope="attr.financial.portfolio.*",
        scope_handle="s_reviewer_portfolio",
        recipient_key_fingerprint=connector_key_fingerprint(connector.public_key_b64),
        expires_at_ms=1_900_000_000_000,
    )

    package = smoke._encrypt_export_payload(
        {"portfolio": {"holdings": [{"symbol": "AAPL"}]}},
        connector_public_key_b64=connector.public_key_b64,
        connector_key_id=connector.key_id,
        aad=aad,
    )
    envelope = ConsentExportEnvelopeSubmissionV2.model_validate(package["exportEnvelope"])

    assert package["version"] == 2
    assert envelope.aad == aad
    assert envelope.ciphertext_bytes > 0
    assert package["connectorKeyId"] == connector.key_id


def test_uat_backend_deploy_sets_the_public_consent_resource_origin() -> None:
    workflow = (REPO_ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")
    backend_build = (REPO_ROOT / "deploy/backend.cloudbuild.yaml").read_text(encoding="utf-8")

    assert "CONSENT_API_PUBLIC_ORIGIN: https://api.uat.hushh.ai" in workflow
    assert "_CONSENT_API_PUBLIC_ORIGIN=${{ env.CONSENT_API_PUBLIC_ORIGIN }}" in workflow
    assert '"CONSENT_API_PUBLIC_ORIGIN=${_CONSENT_API_PUBLIC_ORIGIN}"' in backend_build
    assert '_CONSENT_API_PUBLIC_ORIGIN: ""' in backend_build
