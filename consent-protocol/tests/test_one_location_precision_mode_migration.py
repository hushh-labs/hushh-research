import json
from pathlib import Path

from hushh_mcp.services.one_location_precision import (
    approximate_area_center,
    approximate_area_radius_m,
    normalize_approximate_radius_m,
    normalize_location_mode,
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "132_one_location_location_precision_mode.sql"


def test_precision_mode_migration_is_release_registered() -> None:
    sql = (ROOT / "db" / "migrations" / MIGRATION_NAME).read_text("utf-8")
    rollback = (
        ROOT / "db" / "migrations" / "rollback" / f"{MIGRATION_NAME[:-4]}_down.sql"
    ).read_text("utf-8")
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text("utf-8"))

    assert manifest["ordered_migrations"][-1] == MIGRATION_NAME
    assert manifest["groups"]["iam"][-1] == MIGRATION_NAME
    assert "location_mode" in sql
    assert "approximate_radius_m" in sql
    assert "retained across application rollback" in rollback

    for contract_name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads((ROOT / "db" / "contracts" / contract_name).read_text("utf-8"))
        assert contract["expected_migration_version"] == 132


def test_precision_helpers_are_deterministic_and_bounded() -> None:
    first = approximate_area_center(latitude=25.213815, longitude=75.864752)
    nearby = approximate_area_center(latitude=25.213915, longitude=75.864752)
    assert first == nearby
    assert approximate_area_radius_m(12) == 1_000
    assert approximate_area_radius_m(3_000) > 3_000

    for latitude, longitude in ((89.9, 45), (-89.9, -45), (0, 179.9999)):
        center_latitude, center_longitude = approximate_area_center(
            latitude=latitude,
            longitude=longitude,
        )
        assert -85.05112878 <= center_latitude <= 85.05112878
        assert -180 <= center_longitude <= 180


def test_precision_metadata_validation_fails_closed() -> None:
    assert normalize_location_mode(None) == "precise"
    assert normalize_approximate_radius_m(mode="precise", value=None) is None
    assert normalize_approximate_radius_m(mode="approximate", value=1_250) == 1_250

    for mode in ("exact", "nearby"):
        try:
            normalize_location_mode(mode)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid mode {mode!r} was accepted")
