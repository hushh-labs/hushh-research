import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/097_redact_legacy_pkm_message_excerpts.sql"


def _redact_synthetic_manifest(row: dict) -> dict:
    """Mirror the migration's two exact manifest projection deletions."""
    result = json.loads(json.dumps(row))
    result.get("summary_projection", {}).pop("message_excerpt", None)
    result.get("structure_decision", {}).get("summary_projection", {}).pop("message_excerpt", None)
    return result


def test_redaction_preserves_all_unrelated_manifest_metadata() -> None:
    source = {
        "summary_projection": {
            "message_excerpt": "PRIVATE USER SENTENCE",
            "path_count": 4,
            "readable_source_label": "Memory",
        },
        "structure_decision": {
            "action": "extend_domain",
            "summary_projection": {
                "message_excerpt": "PRIVATE USER SENTENCE",
                "intent_class": "preference",
            },
        },
    }

    redacted = _redact_synthetic_manifest(source)
    redacted_twice = _redact_synthetic_manifest(redacted)

    assert "PRIVATE USER SENTENCE" not in json.dumps(redacted)
    assert redacted["summary_projection"] == {
        "path_count": 4,
        "readable_source_label": "Memory",
    }
    assert redacted["structure_decision"] == {
        "action": "extend_domain",
        "summary_projection": {"intent_class": "preference"},
    }
    assert redacted_twice == redacted


def test_migration_is_transactional_scoped_and_reports_only_row_counts() -> None:
    sql = MIGRATION.read_text()

    assert "BEGIN;" in sql and "COMMIT;" in sql
    assert "COALESCE(summary_projection, '{}'::JSONB) - 'message_excerpt'" in sql
    assert "structure_decision #- '{summary_projection,message_excerpt}'" in sql
    assert "#- '{summary_projection,message_excerpt}'" in sql
    assert "#- '{structure_decision,summary_projection,message_excerpt}'" in sql
    assert "GET DIAGNOSTICS v_manifest_rows = ROW_COUNT" in sql
    assert "GET DIAGNOSTICS v_event_rows = ROW_COUNT" in sql
    assert "PRIVATE USER SENTENCE" not in sql
