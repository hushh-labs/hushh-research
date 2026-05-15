"""
Tests for utils/policy_engine.py — multi-tenant consent policy evaluation.

Dynamic Policy Orchestrator by Abdul Gaffar — verifies that:
  1. Brand A (location restriction + age gate) correctly passes/fails
  2. Brand B (no rules) always passes
  3. All operators behave as specified
  4. "all" vs "any" mode semantics are correct
  5. Unknown operators raise PolicyOperationError
  6. check_or_raise raises PolicyViolationError on failure
  7. Round-trip serialisation via from_dict / to_dict
"""

from __future__ import annotations

import pytest

from hushh_mcp.consent.policy_engine import (
    PolicyEngine,
    PolicyOperationError,
    PolicyRule,
    PolicyViolationError,
    TenantPolicy,
    policy_engine,
)

# ---------------------------------------------------------------------------
# Fixture policies
# ---------------------------------------------------------------------------

# Brand A: US-only, minimum 18 years old, consent window ≤ 168 h (1 week)
_BRAND_A = TenantPolicy(
    tenant_id="brand_a",
    tenant_name="Brand A",
    mode="all",
    rules=[
        PolicyRule("location", "eq", "US", "US users only"),
        PolicyRule("user_age", "gte", 18, "Must be 18 or older"),
        PolicyRule("duration_hours", "lte", 168, "Max 1-week consent window"),
    ],
)

# Brand B: no restrictions
_BRAND_B = TenantPolicy(
    tenant_id="brand_b",
    tenant_name="Brand B",
    mode="all",
    rules=[],
)

# Base context with fields that satisfy Brand A
_CTX_OK = {
    "userId": "user_123",
    "requestId": "req_456",
    "location": "US",
    "user_age": 25,
    "duration_hours": 24,
    "permission_levels": ["pkm.read", "vault.owner"],
}


# ---------------------------------------------------------------------------
# Brand A — required metadata present and valid
# ---------------------------------------------------------------------------


class TestBrandAPass:
    def test_all_rules_satisfied(self):
        result = policy_engine.evaluate(_CTX_OK, _BRAND_A)
        assert result.passed is True

    def test_passed_rules_count(self):
        result = policy_engine.evaluate(_CTX_OK, _BRAND_A)
        assert len(result.passed_rules) == 3
        assert len(result.failed_rules) == 0

    def test_result_carries_tenant_id(self):
        result = policy_engine.evaluate(_CTX_OK, _BRAND_A)
        assert result.tenant_id == "brand_a"
        assert result.tenant_name == "Brand A"

    def test_message_contains_identity_label(self):
        result = policy_engine.evaluate(_CTX_OK, _BRAND_A)
        assert "Abdul Gaffar" in result.message
        assert "Dynamic Policy Orchestrator" in result.message

    def test_summary_contains_passed_flag(self):
        result = policy_engine.evaluate(_CTX_OK, _BRAND_A)
        assert "passed=True" in result.summary()


# ---------------------------------------------------------------------------
# Brand A — failed scenarios
# ---------------------------------------------------------------------------


class TestBrandAFail:
    def test_wrong_location_fails(self):
        ctx = {**_CTX_OK, "location": "UK"}
        result = policy_engine.evaluate(ctx, _BRAND_A)
        assert result.passed is False
        assert any(r["field"] == "location" for r in result.failed_rules)

    def test_missing_location_fails(self):
        ctx = {k: v for k, v in _CTX_OK.items() if k != "location"}
        result = policy_engine.evaluate(ctx, _BRAND_A)
        assert result.passed is False

    def test_underage_user_fails(self):
        ctx = {**_CTX_OK, "user_age": 16}
        result = policy_engine.evaluate(ctx, _BRAND_A)
        assert result.passed is False
        assert any(r["field"] == "user_age" for r in result.failed_rules)

    def test_duration_exceeded_fails(self):
        ctx = {**_CTX_OK, "duration_hours": 200}
        result = policy_engine.evaluate(ctx, _BRAND_A)
        assert result.passed is False

    def test_multiple_rules_can_fail(self):
        ctx = {**_CTX_OK, "location": "CA", "user_age": 15}
        result = policy_engine.evaluate(ctx, _BRAND_A)
        assert result.passed is False
        assert len(result.failed_rules) == 2

    def test_failure_message_names_failed_rules(self):
        ctx = {**_CTX_OK, "location": "UK"}
        result = policy_engine.evaluate(ctx, _BRAND_A)
        assert "US users only" in result.message or "location" in result.message


# ---------------------------------------------------------------------------
# Brand B — no restrictions (always passes)
# ---------------------------------------------------------------------------


class TestBrandBAlwaysPasses:
    def test_empty_context_passes(self):
        result = policy_engine.evaluate({}, _BRAND_B)
        assert result.passed is True

    def test_any_context_passes(self):
        for ctx in [_CTX_OK, {}, {"location": "MARS"}, {"user_age": -1}]:
            assert policy_engine.evaluate(ctx, _BRAND_B).passed is True

    def test_no_failed_rules(self):
        result = policy_engine.evaluate({}, _BRAND_B)
        assert result.failed_rules == []


# ---------------------------------------------------------------------------
# Mode: "any" (OR semantics)
# ---------------------------------------------------------------------------


class TestAnyMode:
    def setup_method(self):
        self.policy = TenantPolicy(
            tenant_id="or_brand",
            tenant_name="OR Brand",
            mode="any",
            rules=[
                PolicyRule("location", "eq", "US", "US users"),
                PolicyRule("location", "eq", "CA", "CA users"),
            ],
        )

    def test_passes_when_first_rule_matches(self):
        result = policy_engine.evaluate({"location": "US"}, self.policy)
        assert result.passed is True

    def test_passes_when_second_rule_matches(self):
        result = policy_engine.evaluate({"location": "CA"}, self.policy)
        assert result.passed is True

    def test_fails_when_no_rule_matches(self):
        result = policy_engine.evaluate({"location": "UK"}, self.policy)
        assert result.passed is False

    def test_empty_rules_any_mode_passes(self):
        policy = TenantPolicy("t", "T", mode="any", rules=[])
        assert policy_engine.evaluate({}, policy).passed is True


# ---------------------------------------------------------------------------
# Operator correctness
# ---------------------------------------------------------------------------


class TestOperators:
    def _eval(self, field: str, op: str, value: Any, ctx_value: Any) -> bool:
        rule = PolicyRule(field="x", op=op, value=value)
        result = policy_engine.evaluate({"x": ctx_value}, _one_rule_policy(rule))
        return result.passed

    def test_eq_match(self):
        assert self._eval("x", "eq", "US", "US") is True

    def test_eq_no_match(self):
        assert self._eval("x", "eq", "US", "UK") is False

    def test_neq(self):
        assert self._eval("x", "neq", "US", "UK") is True
        assert self._eval("x", "neq", "US", "US") is False

    def test_in_list(self):
        assert self._eval("x", "in", ["a", "b", "c"], "b") is True
        assert self._eval("x", "in", ["a", "b", "c"], "d") is False

    def test_not_in_list(self):
        assert self._eval("x", "not_in", ["a", "b"], "c") is True
        assert self._eval("x", "not_in", ["a", "b"], "a") is False

    def test_lt(self):
        assert self._eval("x", "lt", 18, 10) is True
        assert self._eval("x", "lt", 18, 18) is False

    def test_lte(self):
        assert self._eval("x", "lte", 18, 18) is True
        assert self._eval("x", "lte", 18, 19) is False

    def test_gt(self):
        assert self._eval("x", "gt", 10, 18) is True
        assert self._eval("x", "gt", 10, 10) is False

    def test_gte(self):
        assert self._eval("x", "gte", 18, 18) is True
        assert self._eval("x", "gte", 18, 17) is False

    def test_exists_present(self):
        assert self._eval("x", "exists", None, "value") is True

    def test_exists_missing(self):
        rule = PolicyRule(field="missing_field", op="exists", value=None)
        result = policy_engine.evaluate({}, _one_rule_policy(rule))
        assert result.passed is False

    def test_not_exists_missing(self):
        rule = PolicyRule(field="absent", op="not_exists", value=None)
        result = policy_engine.evaluate({}, _one_rule_policy(rule))
        assert result.passed is True

    def test_not_exists_present(self):
        assert self._eval("x", "not_exists", None, "something") is False

    def test_contains_string(self):
        assert self._eval("x", "contains", "foo", "foobar") is True
        assert self._eval("x", "contains", "foo", "baz") is False

    def test_contains_list(self):
        assert self._eval("x", "contains", "pkm.read", ["pkm.read", "vault.owner"]) is True
        assert self._eval("x", "contains", "pkm.write", ["pkm.read"]) is False

    def test_not_contains(self):
        assert self._eval("x", "not_contains", "pkm.write", ["pkm.read"]) is True

    def test_unknown_op_raises(self):
        rule = PolicyRule(field="x", op="magic", value=None)
        with pytest.raises(PolicyOperationError, match="magic"):
            policy_engine.evaluate({"x": 1}, _one_rule_policy(rule))


# ---------------------------------------------------------------------------
# Dot-notation field resolution
# ---------------------------------------------------------------------------


class TestFieldResolution:
    def test_nested_field_access(self):
        policy = _one_rule_policy(PolicyRule("payload.duration_hours", "lte", 24))
        ctx = {"payload": {"duration_hours": 12}}
        assert policy_engine.evaluate(ctx, policy).passed is True

    def test_missing_nested_field_fails_non_exists_op(self):
        policy = _one_rule_policy(PolicyRule("payload.duration_hours", "lte", 24))
        ctx = {"payload": {}}
        assert policy_engine.evaluate(ctx, policy).passed is False

    def test_deep_nesting(self):
        policy = _one_rule_policy(PolicyRule("a.b.c", "eq", "deep"))
        ctx = {"a": {"b": {"c": "deep"}}}
        assert policy_engine.evaluate(ctx, policy).passed is True


# ---------------------------------------------------------------------------
# build_context helper
# ---------------------------------------------------------------------------


class TestBuildContext:
    def test_payload_fields_at_top_level(self):
        ctx = PolicyEngine.build_context({"userId": "u1", "duration_hours": 24})
        assert ctx["duration_hours"] == 24

    def test_payload_also_under_payload_key(self):
        ctx = PolicyEngine.build_context({"userId": "u1"})
        assert "payload" in ctx
        assert ctx["payload"]["userId"] == "u1"

    def test_extra_merged(self):
        ctx = PolicyEngine.build_context({}, extra={"location": "US"})
        assert ctx["location"] == "US"

    def test_extra_overrides_payload(self):
        ctx = PolicyEngine.build_context({"location": "CA"}, extra={"location": "US"})
        assert ctx["location"] == "US"


# ---------------------------------------------------------------------------
# check_or_raise
# ---------------------------------------------------------------------------


class TestCheckOrRaise:
    def test_passes_silently(self):
        policy_engine.check_or_raise(_CTX_OK, _BRAND_A)  # should not raise

    def test_raises_on_failure(self):
        ctx = {**_CTX_OK, "location": "UK"}
        with pytest.raises(PolicyViolationError) as exc_info:
            policy_engine.check_or_raise(ctx, _BRAND_A)
        assert exc_info.value.result.passed is False

    def test_violation_error_is_value_error(self):
        ctx = {**_CTX_OK, "location": "UK"}
        with pytest.raises(ValueError):
            policy_engine.check_or_raise(ctx, _BRAND_A)

    def test_violation_message_in_exception(self):
        ctx = {**_CTX_OK, "location": "UK"}
        with pytest.raises(PolicyViolationError) as exc_info:
            policy_engine.check_or_raise(ctx, _BRAND_A)
        assert "Dynamic Policy Orchestrator" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Serialisation round-trip
# ---------------------------------------------------------------------------


class TestSerialisation:
    def test_from_dict_round_trip(self):
        d = {
            "tenant_id": "rt_brand",
            "tenant_name": "Round-Trip Brand",
            "mode": "any",
            "rules": [
                {"field": "location", "op": "eq", "value": "US", "description": "US only"},
            ],
        }
        policy = TenantPolicy.from_dict(d)
        assert policy.tenant_id == "rt_brand"
        assert policy.mode == "any"
        assert len(policy.rules) == 1
        assert policy.rules[0].op == "eq"

    def test_to_dict_is_json_compatible(self):
        policy = _BRAND_A
        d = policy.to_dict()
        assert isinstance(d, dict)
        assert d["tenant_id"] == "brand_a"
        assert len(d["rules"]) == 3

    def test_invalid_mode_raises(self):
        with pytest.raises(ValueError, match="mode"):
            TenantPolicy(tenant_id="x", tenant_name="X", mode="invalid_mode")

    def test_module_singleton_is_engine(self):
        from hushh_mcp.consent.policy_engine import policy_engine as pe
        assert isinstance(pe, PolicyEngine)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

from typing import Any  # noqa: E402 — needed for _eval type hint inside class


def _one_rule_policy(rule: PolicyRule) -> TenantPolicy:
    """Create a minimal 'all'-mode policy containing a single rule."""
    return TenantPolicy(
        tenant_id="test",
        tenant_name="Test Policy",
        mode="all",
        rules=[rule],
    )
