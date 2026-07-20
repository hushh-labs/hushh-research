"""The historical seed command must remain a wrapper, never a second writer."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_seed_script_delegates_to_canonical_registry_cli():
    source = (ROOT / "scripts" / "ops" / "seed_crm_registry_row.py").read_text()
    assert "configure_crm_registry.main()" in source
    assert "INSERT INTO enterprise_crm_registry" not in source
    assert "encrypt_data" not in source
