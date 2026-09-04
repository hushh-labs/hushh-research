from hushh_mcp.consent.pkm_scope_policy import (
    is_private_pkm_export_scope,
    is_private_pkm_manifest_path,
)


def test_private_analysis_scope_policy_retires_raw_finance_artifacts_and_broad_legacy_scope() -> (
    None
):
    assert is_private_pkm_export_scope("attr.financial.analysis_history.*") is True
    assert is_private_pkm_export_scope("attr.financial.analysis_history.aapl.raw_card") is True
    assert is_private_pkm_export_scope("attr.financial.*") is True
    assert is_private_pkm_export_scope("attr.financial.portfolio.*") is False
    assert is_private_pkm_export_scope("attr.financial.analysis.decisions.*") is False


def test_private_analysis_manifest_policy_blocks_history_paths() -> None:
    assert is_private_pkm_manifest_path(domain="financial", path="analysis_history.aapl") is True
    assert is_private_pkm_manifest_path(domain="financial", path="portfolio.holdings") is False


def test_private_analysis_redaction_migration_is_in_the_release_chain() -> None:
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    assert (root / "db" / "migrations" / "128_private_analysis_history_redaction.sql").is_file()
    manifest = json.loads((root / "db" / "release_migration_manifest.json").read_text("utf-8"))
    assert "128_private_analysis_history_redaction.sql" in manifest["ordered_migrations"]
    for contract in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        value = json.loads((root / "db" / "contracts" / contract).read_text("utf-8"))
        assert value["expected_migration_version"] >= 128
