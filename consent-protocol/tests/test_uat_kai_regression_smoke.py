from __future__ import annotations

import json

from scripts.uat_kai_regression_smoke import (
    SAMPLE_BROKERAGE_PATH,
    _build_manifest_artifacts,
)


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
