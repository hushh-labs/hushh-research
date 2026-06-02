import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"


def _pkm_event_constraint_operations(migration_name: str) -> set[str] | None:
    sql = (MIGRATIONS_DIR / migration_name).read_text(encoding="utf-8")
    match = re.search(
        r"ADD\s+CONSTRAINT\s+pkm_events_operation_type_check\s+CHECK\s*"
        r"\(\s*operation_type\s+IN\s*\((?P<body>.*?)\)\s*\);",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if match is None:
        return None
    return set(re.findall(r"'([^']+)'", match.group("body")))


def test_pkm_cutover_replay_constraint_allows_later_event_operation_types():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ordered = manifest["ordered_migrations"]
    cutover = "030_pkm_cutover.sql"
    cutover_index = ordered.index(cutover)
    cutover_operations = _pkm_event_constraint_operations(cutover)

    assert cutover_operations is not None

    for migration_name in ordered[cutover_index + 1 :]:
        later_operations = _pkm_event_constraint_operations(migration_name)
        if later_operations is None:
            continue
        assert later_operations <= cutover_operations, (
            f"{cutover} must allow every pkm_events.operation_type allowed by "
            f"{migration_name}; release migrations replay {cutover} before later "
            "constraint wideners on existing UAT/production data."
        )


def test_pkm_cutover_replay_constraint_allows_current_service_events():
    cutover_operations = _pkm_event_constraint_operations("030_pkm_cutover.sql")

    assert cutover_operations is not None
    assert {
        "content_write",
        "structure_create",
        "structure_extend",
        "structure_match",
        "manifest_refresh",
        "decision_projection",
        "attribute_inference",
        "segment_repartition",
        "legacy_cutover",
        "scope_exposure_update",
        "default_projection_publish",
        "default_projection_revoke",
    } <= cutover_operations
