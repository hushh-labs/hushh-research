"""
Tests for utils/redactor.py — automated data redaction & privacy guardrails.

Privacy Guardrail Engine by Abdul Gaffar — verifies that:
  1. All four RedactionActions (MASK, NULLIFY, REDACT, OMIT) are applied correctly
  2. All four ClearanceLevels produce the expected redaction scope
  3. The deterministic lookup table returns the right action per field
  4. Unknown fields fall back to the default action (REDACT)
  5. Partial Success — brand receives non-sensitive fields intact
  6. Integration with duck-typed PolicyEvaluationResult
  7. Original payload is never mutated
"""

from __future__ import annotations

from types import SimpleNamespace

from utils.redactor import (
    _DEFAULT_ACTION,
    _REDACTION_TABLE,
    _SENTINEL,
    ClearanceLevel,
    RedactedField,
    RedactionAction,
    RedactionEngine,
    RedactionResult,
    _mask_value,
    redaction_engine,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_PAYLOAD: dict = {
    "user_id": "firebase_abc_123",
    "email": "alice@example.com",
    "age": 28,
    "location": "San Francisco",
    "timestamp": 1700000000000,
    "brand_name": "TechCorp",
    "permission_levels": ["data_analytics"],
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rule(field: str) -> SimpleNamespace:
    """Minimal duck-typed PolicyRule with a .field attribute."""
    return SimpleNamespace(field=field)


def _evaluation(failed: list[str], passed: list[str]) -> SimpleNamespace:
    """Minimal duck-typed PolicyEvaluationResult."""
    return SimpleNamespace(
        failed_rules=[_rule(f) for f in failed],
        passed_rules=[_rule(f) for f in passed],
    )


def _fresh() -> dict:
    """Return a fresh copy of the test payload."""
    return dict(_PAYLOAD)


# ---------------------------------------------------------------------------
# Lookup table
# ---------------------------------------------------------------------------


class TestRedactionTable:
    def test_email_maps_to_mask(self):
        assert _REDACTION_TABLE["email"] == RedactionAction.MASK

    def test_phone_maps_to_mask(self):
        assert _REDACTION_TABLE["phone"] == RedactionAction.MASK

    def test_age_maps_to_redact(self):
        assert _REDACTION_TABLE["age"] == RedactionAction.REDACT

    def test_location_maps_to_omit(self):
        assert _REDACTION_TABLE["location"] == RedactionAction.OMIT

    def test_timestamp_maps_to_nullify(self):
        assert _REDACTION_TABLE["timestamp"] == RedactionAction.NULLIFY

    def test_unknown_field_gets_default_action(self):
        engine = RedactionEngine()
        assert engine._lookup_action("unknown_custom_field") == _DEFAULT_ACTION

    def test_default_action_is_redact(self):
        assert _DEFAULT_ACTION == RedactionAction.REDACT

    def test_all_four_actions_represented_in_table(self):
        actions_in_table = set(_REDACTION_TABLE.values())
        assert RedactionAction.MASK in actions_in_table
        assert RedactionAction.NULLIFY in actions_in_table
        assert RedactionAction.REDACT in actions_in_table
        assert RedactionAction.OMIT in actions_in_table

    def test_dot_path_resolves_to_top_key(self):
        engine = RedactionEngine()
        assert engine._lookup_action("email.domain") == _REDACTION_TABLE["email"]


# ---------------------------------------------------------------------------
# Mask helper
# ---------------------------------------------------------------------------


class TestMaskValue:
    def test_long_string_shows_first_last_chars(self):
        result = _mask_value("alice@example.com")
        assert result.startswith("al")
        assert result.endswith("om")
        assert "***" in result

    def test_short_string_becomes_stars(self):
        assert _mask_value("ab") == "***"
        assert _mask_value("abcd") == "***"

    def test_numeric_value_masked_as_string(self):
        result = _mask_value(123456789)
        assert "***" in result


# ---------------------------------------------------------------------------
# ClearanceLevel — FULL
# ---------------------------------------------------------------------------


class TestClearanceLevelFull:
    def test_full_clearance_no_redaction(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["email", "age", "location"],
            clearance_level=ClearanceLevel.FULL,
        )
        assert result.redaction_count == 0
        assert result.payload == _PAYLOAD

    def test_full_clearance_redacted_fields_empty(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["email"],
            clearance_level=ClearanceLevel.FULL,
        )
        assert result.redacted_fields == []


# ---------------------------------------------------------------------------
# ClearanceLevel — NONE
# ---------------------------------------------------------------------------


class TestClearanceLevelNone:
    def test_none_clearance_all_keys_redacted_or_omitted(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=[],
            clearance_level=ClearanceLevel.NONE,
        )
        # Every field must be either removed (OMIT) or have its value changed
        for key in _PAYLOAD:
            if key in result.payload:
                assert result.payload[key] != _PAYLOAD[key], f"field {key!r} was not redacted"

    def test_none_clearance_redaction_count_equals_payload_size(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=[],
            clearance_level=ClearanceLevel.NONE,
        )
        assert result.redaction_count == len(_PAYLOAD)


# ---------------------------------------------------------------------------
# ClearanceLevel — PARTIAL
# ---------------------------------------------------------------------------


class TestClearanceLevelPartial:
    def test_partial_only_failed_fields_redacted(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["age"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert result.payload["age"] == _SENTINEL
        assert result.payload["email"] == _PAYLOAD["email"]  # untouched
        assert result.payload["brand_name"] == _PAYLOAD["brand_name"]  # untouched

    def test_partial_success_brand_gets_non_sensitive_fields(self):
        """Partial Success: email/age fail policy; brand_name passes through."""
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["email", "age"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert "brand_name" in result.payload
        assert result.payload["brand_name"] == "TechCorp"
        assert result.redaction_count == 2

    def test_partial_email_is_masked_not_redacted(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["email"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        masked = result.payload["email"]
        assert masked != _PAYLOAD["email"]
        assert "***" in masked
        assert masked != _SENTINEL  # MASK, not REDACT

    def test_partial_location_is_omitted(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["location"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert "location" not in result.payload

    def test_partial_timestamp_is_nullified(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["timestamp"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert "timestamp" in result.payload
        assert result.payload["timestamp"] is None

    def test_partial_unknown_field_gets_sentinel(self):
        payload = {"custom_secret": "very_private", "safe_field": "public"}
        result = redaction_engine.apply(
            payload,
            failed_fields=["custom_secret"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert result.payload["custom_secret"] == _SENTINEL
        assert result.payload["safe_field"] == "public"


# ---------------------------------------------------------------------------
# ClearanceLevel — MINIMAL
# ---------------------------------------------------------------------------


class TestClearanceLevelMinimal:
    def test_minimal_only_passed_fields_exposed(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["email", "age"],
            passed_fields=["brand_name"],
            clearance_level=ClearanceLevel.MINIMAL,
        )
        assert "brand_name" in result.payload
        # Everything except brand_name should be redacted/omitted
        assert result.payload.get("email") != _PAYLOAD["email"]

    def test_minimal_no_passed_fields_redacts_everything(self):
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=[],
            passed_fields=[],
            clearance_level=ClearanceLevel.MINIMAL,
        )
        assert result.redaction_count == len(_PAYLOAD)


# ---------------------------------------------------------------------------
# RedactionResult
# ---------------------------------------------------------------------------


class TestRedactionResult:
    def test_result_carries_engine_label(self):
        result = redaction_engine.apply(_fresh(), failed_fields=[])
        assert "Abdul Gaffar" in result.engine
        assert "Privacy Guardrail Engine" in result.engine

    def test_result_is_instance(self):
        result = redaction_engine.apply(_fresh(), failed_fields=[])
        assert isinstance(result, RedactionResult)

    def test_redacted_fields_populated(self):
        result = redaction_engine.apply(
            _fresh(), failed_fields=["age"], clearance_level=ClearanceLevel.PARTIAL
        )
        assert len(result.redacted_fields) == 1
        assert isinstance(result.redacted_fields[0], RedactedField)
        assert result.redacted_fields[0].field == "age"

    def test_redacted_field_records_action(self):
        result = redaction_engine.apply(
            _fresh(), failed_fields=["email"], clearance_level=ClearanceLevel.PARTIAL
        )
        assert result.redacted_fields[0].action == RedactionAction.MASK

    def test_redacted_field_records_original_type(self):
        result = redaction_engine.apply(
            _fresh(), failed_fields=["age"], clearance_level=ClearanceLevel.PARTIAL
        )
        assert result.redacted_fields[0].original_type == "int"

    def test_summary_contains_clearance_level(self):
        result = redaction_engine.apply(
            _fresh(), failed_fields=["age"], clearance_level=ClearanceLevel.PARTIAL
        )
        assert "partial" in result.summary()

    def test_summary_contains_redaction_count(self):
        result = redaction_engine.apply(
            _fresh(), failed_fields=["age", "email"], clearance_level=ClearanceLevel.PARTIAL
        )
        assert "redacted=2" in result.summary()

    def test_missing_field_not_counted(self):
        """A failed field that isn't in the payload should not inflate count."""
        result = redaction_engine.apply(
            _fresh(),
            failed_fields=["nonexistent_field"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert result.redaction_count == 0


# ---------------------------------------------------------------------------
# Payload immutability
# ---------------------------------------------------------------------------


class TestPayloadImmutability:
    def test_original_payload_not_mutated(self):
        original = _fresh()
        snapshot = dict(original)
        redaction_engine.apply(
            original,
            failed_fields=["email", "age", "location"],
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert original == snapshot


# ---------------------------------------------------------------------------
# Integration with duck-typed PolicyEvaluationResult
# ---------------------------------------------------------------------------


class TestApplyFromEvaluation:
    def test_integration_failed_rules_redacted(self):
        evaluation = _evaluation(failed=["age"], passed=["brand_name"])
        result = redaction_engine.apply_from_evaluation(
            _fresh(),
            evaluation=evaluation,
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert result.payload["age"] == _SENTINEL

    def test_integration_passed_fields_preserved(self):
        evaluation = _evaluation(failed=["age"], passed=["brand_name"])
        result = redaction_engine.apply_from_evaluation(
            _fresh(),
            evaluation=evaluation,
            clearance_level=ClearanceLevel.PARTIAL,
        )
        assert result.payload["brand_name"] == "TechCorp"

    def test_integration_minimal_clearance_uses_passed_rules(self):
        evaluation = _evaluation(failed=["email", "age"], passed=["brand_name"])
        result = redaction_engine.apply_from_evaluation(
            _fresh(),
            evaluation=evaluation,
            clearance_level=ClearanceLevel.MINIMAL,
        )
        assert "brand_name" in result.payload
        assert result.payload.get("email") != _PAYLOAD["email"]

    def test_integration_unknown_brand_blocks_all(self):
        """If all fields fail and clearance is NONE, payload is fully scrubbed."""
        all_fields = list(_PAYLOAD.keys())
        evaluation = _evaluation(failed=all_fields, passed=[])
        result = redaction_engine.apply_from_evaluation(
            _fresh(),
            evaluation=evaluation,
            clearance_level=ClearanceLevel.NONE,
        )
        assert result.redaction_count == len(_PAYLOAD)


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------


class TestRedactionEngineSingleton:
    def test_singleton_identity(self):
        from utils.redactor import redaction_engine as e2

        assert redaction_engine is e2
