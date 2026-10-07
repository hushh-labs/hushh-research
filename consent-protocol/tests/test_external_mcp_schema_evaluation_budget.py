"""Evaluating a provider's schema is bounded, however hostile or careless the schema is.

Admission bounds a schema's size, not what it costs to evaluate against what a model
sent, and Python's regex engine cannot be interrupted on a shared worker's event loop.
Evaluation therefore spends a deterministic step budget and refuses patterns that could
not be cheap, ending the call as "too costly" instead of stalling the worker.
"""

from __future__ import annotations

import time

import pytest

from hushh_mcp.services import external_mcp_client as client
from hushh_mcp.services.external_mcp_client import ExternalMcpError, schema_is_valid

DRAFT7 = "http://json-schema.org/draft-07/schema#"


def object_schema(**properties) -> dict:
    return {"type": "object", "properties": properties, "additionalProperties": False}


@pytest.mark.parametrize("dialect", [None, DRAFT7])
def test_an_ordinary_schema_is_evaluated_exactly_as_before(dialect):
    schema = object_schema(
        email={"type": "string", "pattern": r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$"},
        date={"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
        tags={"type": "array", "items": {"type": "string"}, "maxItems": 5},
    )
    if dialect:
        schema["$schema"] = dialect
    assert schema_is_valid(schema, {"email": "a@b.co", "date": "2026-10-06", "tags": ["x"]})
    assert not schema_is_valid(schema, {"email": "not-an-email"})
    assert not schema_is_valid(schema, {"date": "06/10/2026"})
    assert not schema_is_valid(schema, {"tags": ["a"] * 6})


def test_a_pattern_properties_schema_still_works():
    schema = {"type": "object", "patternProperties": {"^x-": {"type": "string"}}}
    assert schema_is_valid(schema, {"x-a": "ok", "other": 1})
    assert not schema_is_valid(schema, {"x-a": 1})


def test_a_catastrophic_pattern_ends_the_call_instead_of_stalling_the_worker():
    schema = object_schema(name={"type": "string", "pattern": "^(a|a)+$"})
    started = time.perf_counter()
    with pytest.raises(ExternalMcpError) as caught:
        schema_is_valid(schema, {"name": "a" * 40 + "!"})
    assert time.perf_counter() - started < 1
    assert caught.value.code == "MCP_SCHEMA_LIMIT"


@pytest.mark.parametrize("pattern", ["^(a|a)+$", "^(a|aa)+$"])
def test_the_usual_backtracking_shapes_are_stopped_by_the_match_timeout(pattern):
    schema = object_schema(name={"type": "string", "pattern": pattern})
    started = time.perf_counter()
    with pytest.raises(ExternalMcpError):
        schema_is_valid(schema, {"name": "a" * 40 + "!"})
    assert time.perf_counter() - started < 2


def test_a_short_subject_is_always_cheap_so_a_repeated_group_still_evaluates():
    schema = object_schema(code={"type": "string", "pattern": r"^(\d+,)*\d+$"})
    assert schema_is_valid(schema, {"code": "1,22,333"})
    assert not schema_is_valid(schema, {"code": "1,x"})


def test_a_pattern_or_subject_beyond_the_bounds_is_refused():
    with pytest.raises(ExternalMcpError):
        schema_is_valid(object_schema(v={"type": "string", "pattern": "a" * 513}), {"v": "a"})
    with pytest.raises(ExternalMcpError):
        schema_is_valid(object_schema(v={"type": "string", "pattern": "^a"}), {"v": "a" * 32_769})


@pytest.mark.parametrize(
    ("pattern", "good", "bad"),
    [
        # zod's email pattern, on a long address (the old heuristic refused it).
        (
            r"^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$",
            "a.very.long.local.part.indeed@sub.domain.example.com",
            "not an email address at all, really not",
        ),
        (
            r"^([a-z0-9]+[._-]?)*$",
            "abcdefghijklmnopqrstuvwxyz.0123456789.abcdefghij",
            "UPPER-case-and-more-than-24",
        ),
        (
            r"^([a-z0-9]+\.)+[a-z]{2,}$",
            "deeply.nested.sub.domain.example.com",
            "no-dots-here-just-a-long-word",
        ),
        (r"^[\s\S]*$", "n" * 5_000, None),
    ],
)
def test_ordinary_patterns_on_long_values_are_evaluated_not_refused(pattern, good, bad):
    schema = object_schema(v={"type": "string", "pattern": pattern})
    assert schema_is_valid(schema, {"v": good})
    if bad is not None:
        assert not schema_is_valid(schema, {"v": bad})


def test_exponential_fan_out_through_references_is_stopped_by_the_step_budget():
    depth = 40
    defs = {
        f"n{i}": {"allOf": [{"$ref": f"#/$defs/n{i + 1}"}, {"$ref": f"#/$defs/n{i + 1}"}]}
        for i in range(depth)
    }
    defs[f"n{depth}"] = {"type": "string"}
    schema = {"type": "object", "$defs": defs, "properties": {"a": {"$ref": "#/$defs/n0"}}}
    started = time.perf_counter()
    with pytest.raises(ExternalMcpError) as caught:
        schema_is_valid(schema, {"a": "x"})
    assert time.perf_counter() - started < 2
    assert caught.value.code == "MCP_SCHEMA_LIMIT"


def test_a_nested_dialect_declaration_cannot_escape_the_bounds():
    """The library re-resolves each sub-schema's class from its own `$schema`."""
    schema = {
        "$schema": DRAFT7,
        "type": "object",
        "definitions": {"x": {"$schema": DRAFT7, "type": "string", "pattern": "^(a|a)+$"}},
        "properties": {"v": {"$ref": "#/definitions/x"}},
    }
    started = time.perf_counter()
    with pytest.raises(ExternalMcpError):
        schema_is_valid(schema, {"v": "a" * 40 + "!"})
    assert time.perf_counter() - started < 1


def test_the_budget_belongs_to_one_call_and_is_restored_afterwards():
    wide = object_schema(items={"type": "array", "items": {"type": "integer"}})
    # Large but legitimate: within the budget, and the next call starts afresh.
    for _ in range(3):
        assert schema_is_valid(wide, {"items": list(range(5_000))})
    assert client._EVALUATION_BUDGET.get() is None


def test_an_exhausted_budget_is_not_left_behind_for_the_next_call():
    wide = object_schema(items={"type": "array", "items": {"type": "integer"}})
    with pytest.raises(ExternalMcpError):
        schema_is_valid(wide, {"items": list(range(25_000))})
    assert client._EVALUATION_BUDGET.get() is None
    assert schema_is_valid(wide, {"items": [1, 2, 3]})


def test_without_a_budget_the_validator_is_unbounded_but_patterns_are_still_guarded():
    """Direct use (the call sites that hold no budget) keeps the pattern guard."""
    schema = object_schema(name={"type": "string", "pattern": "^(a|a)+$"})
    with pytest.raises(ExternalMcpError):
        client.schema_validator(schema).is_valid({"name": "a" * 40 + "!"})


def test_an_undeclared_or_unknown_dialect_is_still_refused():
    with pytest.raises(ExternalMcpError):
        schema_is_valid({"$schema": "http://example.test/other", "type": "object"}, {})


def test_the_toolset_surfaces_the_cost_refusal_as_a_schema_problem():
    from hushh_mcp.one_adk.governed_mcp_toolset import validated_mcp_arguments

    schema = object_schema(name={"type": "string", "pattern": "^(a|a)+$"})
    with pytest.raises(ExternalMcpError) as caught:
        validated_mcp_arguments(schema, {"name": "a" * 40 + "!"})
    assert caught.value.code == "MCP_SCHEMA_LIMIT"


def test_a_property_named_schema_is_left_alone_when_nested_declarations_are_removed():
    schema = {
        "$schema": DRAFT7,
        "type": "object",
        "properties": {"$schema": {"type": "string", "enum": ["a", "b"]}},
    }
    assert schema_is_valid(schema, {"$schema": "a"})
    assert not schema_is_valid(schema, {"$schema": "c"})
