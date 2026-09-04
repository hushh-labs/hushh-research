from __future__ import annotations

import json
import uuid
from pathlib import Path

from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    connector_key_fingerprint,
)
from hushh_mcp.consent.export_projection import decrypt_scoped_export_package
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
    assert sample["account_info"]["statement_period_start"] == "2026-06-01"
    assert sample["account_info"]["statement_period_end"] == "2026-06-30"


def test_reviewer_export_projects_the_approved_brokerage_information() -> None:
    sample = json.loads(SAMPLE_BROKERAGE_PATH.read_text(encoding="utf-8"))
    domain_data = {
        "schema_version": 3,
        "portfolio": sample,
        "updated_at": "2026-07-15T00:00:00Z",
    }
    _, manifest = _build_manifest_artifacts(
        domain="financial",
        domain_data=domain_data,
        previous_manifest={"manifest_version": 4, "paths": []},
    )
    smoke = UatKaiSmoke.__new__(UatKaiSmoke)
    smoke._fetch_domain_manifest = lambda _domain: manifest
    smoke._fetch_domain_blob = lambda _domain: {"data_version": 7}
    smoke._decrypt_domain_blob = lambda _blob: domain_data

    payload, content_revision, manifest_revision = smoke._build_export_payload(
        "attr.financial.portfolio.*"
    )

    assert len(payload["financial"]["portfolio"]["holdings"]) == 20
    assert payload["financial"]["portfolio"]["account_info"]["brokerage"] == "Demo Brokerage"
    assert (
        payload["financial"]["portfolio"]["account_info"]["statement_period_start"] == "2026-06-01"
    )
    assert payload["financial"]["portfolio"]["account_info"]["statement_period_end"] == "2026-06-30"
    assert content_revision == 7
    assert manifest_revision == manifest["manifest_version"]


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

    decrypted = decrypt_scoped_export_package(
        wrapped_key_bundle={
            "wrapped_export_key": package["wrappedExportKey"],
            "wrapped_key_iv": package["wrappedKeyIv"],
            "wrapped_key_tag": package["wrappedKeyTag"],
            "sender_public_key": package["senderPublicKey"],
        },
        iv_b64=package["encryptedIv"],
        tag_b64=package["encryptedTag"],
        ciphertext=package["encryptedData"],
        connector_private_key=connector.x25519_box,
        export_envelope=package["exportEnvelope"],
    )

    assert decrypted == {"portfolio": {"holdings": [{"symbol": "AAPL"}]}}


def test_uat_backend_deploy_sets_the_public_consent_resource_origin() -> None:
    workflow = (REPO_ROOT / ".github/workflows/deploy-uat.yml").read_text(encoding="utf-8")
    backend_build = (REPO_ROOT / "deploy/backend.cloudbuild.yaml").read_text(encoding="utf-8")

    assert "CONSENT_API_PUBLIC_ORIGIN: https://api.uat.hushh.ai" in workflow
    assert "_CONSENT_API_PUBLIC_ORIGIN=${{ env.CONSENT_API_PUBLIC_ORIGIN }}" in workflow
    assert '"CONSENT_API_PUBLIC_ORIGIN=${_CONSENT_API_PUBLIC_ORIGIN}"' in backend_build
    assert '_CONSENT_API_PUBLIC_ORIGIN: ""' in backend_build
