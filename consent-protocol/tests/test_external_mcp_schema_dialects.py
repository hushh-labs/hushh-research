"""A provider's declared JSON Schema dialect is honoured, and nothing is admitted unchecked.

Attio's MCP server (zod-based) declares draft-07 on every tool. The admission check
accepted only 2020-12, so every Attio tool was refused and the whole catalog with it.
"""

from __future__ import annotations

import copy
import json
import time
import urllib.request
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import external_mcp_client as client

DRAFT7 = "http://json-schema.org/draft-07/schema#"
DRAFT7_BARE = "http://json-schema.org/draft-07/schema"
DRAFT_2020 = "https://json-schema.org/draft/2020-12/schema"


def zod_style_schema(**extra):
    """The shape zod-to-json-schema emits (anyOf, additionalProperties, items, local $ref)."""
    return {
        "type": "object",
        "properties": {
            "object": {"type": "string", "description": "Which object"},
            "values": {
                "type": "object",
                "additionalProperties": {
                    "anyOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string", "format": "email"}},
                    ]
                },
            },
            "again": {"$ref": "#/properties/values/additionalProperties/anyOf/0"},
            "kind": {"const": "person"},
            "not_empty": {"not": {"type": "null"}},
        },
        "required": ["object", "values"],
        "additionalProperties": False,
        "$schema": DRAFT7,
        **extra,
    }


def code_of(schema):
    with pytest.raises(client.ExternalMcpError) as caught:
        client.validate_tool_schema(schema)
    return caught.value.code


# --- admission -------------------------------------------------------------------


@pytest.mark.parametrize("dialect", [DRAFT7, DRAFT7_BARE])
def test_declared_draft7_is_admitted_unchanged(dialect):
    schema = zod_style_schema()
    schema["$schema"] = dialect
    assert client.validate_tool_schema(schema) == schema


def test_2020_12_and_undeclared_are_unchanged():
    declared = {"type": "object", "$schema": DRAFT_2020, "properties": {}}
    assert client.validate_tool_schema(declared) == declared
    undeclared = {"type": "object", "properties": {"a": {"type": "string"}}}
    assert client.validate_tool_schema(undeclared) == undeclared


@pytest.mark.parametrize(
    "dialect",
    [
        "http://json-schema.org/draft-04/schema#",
        "http://json-schema.org/draft-06/schema#",
        "https://json-schema.org/draft/2019-09/schema",
        "https://unknown.invalid/schema",
        "http://json-schema.org/draft-07/schema#/",
        "",
        7,
    ],
)
def test_any_other_dialect_is_refused(dialect):
    assert code_of({"type": "object", "$schema": dialect}) == "MCP_SCHEMA_INVALID"


def test_a_nested_declaration_may_only_repeat_the_roots_dialect():
    inner_same = zod_style_schema()
    inner_same["properties"]["nested"] = {"type": "object", "$schema": DRAFT7}
    assert client.validate_tool_schema(inner_same) == inner_same
    for other in (DRAFT_2020, DRAFT7_BARE):
        mixed = zod_style_schema()
        mixed["properties"]["nested"] = {"type": "object", "$schema": other}
        assert code_of(mixed) == "MCP_SCHEMA_INVALID"
    # An undeclared root still allows only the default dialect nested.
    root = {"type": "object", "properties": {"n": {"type": "object", "$schema": DRAFT7}}}
    assert code_of(root) == "MCP_SCHEMA_INVALID"


def test_draft7_does_not_relax_reference_or_identity_rules():
    assert code_of(zod_style_schema(**{"$id": "https://evil.invalid/s"})) == "MCP_SCHEMA_INVALID"
    remote = zod_style_schema()
    remote["properties"]["r"] = {"$ref": "https://private.invalid/schema"}
    assert code_of(remote) == "MCP_SCHEMA_INVALID"
    recursive = zod_style_schema()
    recursive["properties"]["r"] = {"$recursiveRef": "#"}
    assert code_of(recursive) == "MCP_SCHEMA_INVALID"


def test_a_draft7_schema_must_still_be_a_valid_draft7_schema():
    broken = zod_style_schema()
    broken["properties"]["bad"] = {"type": "not-a-type"}
    assert code_of(broken) == "MCP_SCHEMA_INVALID"


def test_literal_ref_text_inside_draft7_data_is_not_a_directive():
    schema = zod_style_schema()
    schema["properties"]["note"] = {"type": "string", "const": {"$ref": "https://x.invalid"}}
    assert client.validate_tool_schema(schema) == schema


def test_dialect_selection():
    assert client.schema_validator_class({"type": "object"}) is client.Draft202012Validator
    assert client.schema_validator_class({"$schema": DRAFT_2020}) is client.Draft202012Validator
    assert client.schema_validator_class({"$schema": DRAFT7}) is client.Draft7Validator
    assert client.schema_validator_class({"$schema": DRAFT7_BARE}) is client.Draft7Validator
    assert client.schema_validator_class({"$schema": "nope"}) is None
    assert client.schema_validator_class({"$schema": None}) is client.Draft202012Validator
    assert client.schema_validator_class("not a schema") is None


# --- a caught error stays specific -----------------------------------------------


def transport_raising(error):
    @asynccontextmanager
    async def transport(*_a, **_k):
        raise error
        yield  # pragma: no cover

    return transport


@pytest.fixture
def public_endpoint(monkeypatch):
    monkeypatch.setattr(client, "validate_mcp_endpoint", lambda endpoint: None)


@pytest.mark.asyncio
@pytest.mark.usefixtures("public_endpoint")
async def test_connector_error_wrapped_by_the_task_group_keeps_its_code(monkeypatch):
    # What the transport's task group does to an error raised while connected.
    inner = client.ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
    wrapped = ExceptionGroup(
        "g", [ExceptionGroup("g2", [inner, inner]), ExceptionGroup("g3", [inner])]
    )
    monkeypatch.setattr(
        "mcp.client.streamable_http.streamablehttp_client", transport_raising(wrapped)
    )
    with pytest.raises(client.ExternalMcpError) as caught:
        await client.list_tools(endpoint="https://mcp.example.com/mcp")
    assert caught.value.code == "MCP_SCHEMA_INVALID"
    assert str(caught.value) == "Unsupported connector schema."


@pytest.mark.asyncio
@pytest.mark.usefixtures("public_endpoint")
async def test_a_mixed_group_is_still_a_real_failure(monkeypatch):
    inner = client.ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
    wrapped = ExceptionGroup("g", [inner, ConnectionError("down")])
    monkeypatch.setattr(
        "mcp.client.streamable_http.streamablehttp_client", transport_raising(wrapped)
    )
    with pytest.raises(client.ExternalMcpError) as caught:
        await client.list_tools(endpoint="https://mcp.example.com/mcp")
    assert caught.value.code == "EXTERNAL_MCP_UNREACHABLE"


@pytest.mark.asyncio
@pytest.mark.usefixtures("public_endpoint")
async def test_call_tool_unwraps_the_same_way(monkeypatch):
    inner = client.ExternalMcpError("Connector catalog is too large.", code="MCP_CATALOG_LIMIT")
    monkeypatch.setattr(
        "mcp.client.streamable_http.streamablehttp_client",
        transport_raising(ExceptionGroup("g", [inner])),
    )
    with pytest.raises(client.ExternalMcpError) as caught:
        await client.call_tool("x", {}, endpoint="https://mcp.example.com/mcp")
    assert caught.value.code == "MCP_CATALOG_LIMIT"


def test_external_error_in_handles_non_groups_and_depth():
    only = client.ExternalMcpError("m", code="C")
    assert client._external_error_in(only) is only
    assert client._external_error_in(ValueError("x")) is None
    deep = ExceptionGroup("g", [only])
    for _ in range(12):
        deep = ExceptionGroup("g", [deep])
    # Past the depth cap the group itself is a leaf, so it is not a connector error.
    assert client._external_error_in(deep) is None


# --- the model-facing copy -------------------------------------------------------


def test_model_facing_schema_drops_dialect_and_inlines_local_references():
    schema = zod_style_schema()
    original = copy.deepcopy(schema)
    facing = client.model_facing_schema(schema)
    assert "$schema" not in facing
    text = json.dumps(facing)
    assert "$ref" not in text
    assert facing["properties"]["again"] == {"type": "string"}
    # Provider constraints survive, and the input is never mutated.
    assert facing["required"] == ["object", "values"]
    assert facing["additionalProperties"] is False
    assert schema == original


def test_model_facing_schema_keeps_ref_siblings_and_leaves_data_alone():
    schema = {
        "type": "object",
        "$schema": DRAFT7,
        "properties": {
            "a": {"type": "string", "maxLength": 5},
            "b": {"$ref": "#/properties/a", "description": "B"},
            "c": {"enum": [{"$ref": "#/properties/a"}], "default": {"$ref": "#/properties/a"}},
        },
    }
    facing = client.model_facing_schema(schema)
    assert facing["properties"]["b"] == {"type": "string", "maxLength": 5, "description": "B"}
    assert facing["properties"]["c"]["enum"] == [{"$ref": "#/properties/a"}]
    assert facing["properties"]["c"]["default"] == {"$ref": "#/properties/a"}


def test_model_facing_schema_leaves_cycles_missing_targets_and_blowups_as_written():
    cyclic = {
        "type": "object",
        "properties": {
            "node": {"type": "object", "properties": {"next": {"$ref": "#/properties/node"}}},
        },
    }
    facing = client.model_facing_schema(cyclic)
    assert "$ref" in json.dumps(facing)  # not expanded forever
    missing = {"type": "object", "properties": {"x": {"$ref": "#/properties/nope"}}}
    assert client.model_facing_schema(missing) == missing
    # A reference that fans out exponentially is abandoned during expansion (not
    # built and then measured) and the schema is used as the provider wrote it.
    big = {"type": "object", "properties": {"leaf": {"type": "string"}}}
    previous = "#/properties/leaf"
    for index in range(18):
        big["properties"][f"l{index}"] = {"allOf": [{"$ref": previous}, {"$ref": previous}]}
        previous = f"#/properties/l{index}"
    assert client.model_facing_schema(big) == big


def test_model_facing_schema_expansion_is_budgeted_while_it_runs(monkeypatch):
    monkeypatch.setattr(client, "_MODEL_SCHEMA_MAX_NODES", 30)
    schema = {
        "type": "object",
        "properties": {
            "a": {"type": "string"},
            **{f"p{n}": {"$ref": "#/properties/a"} for n in range(40)},
        },
    }
    # Over budget: unchanged (minus the dialect marker, which was never present).
    assert client.model_facing_schema(schema) == schema


def test_json_pointer_resolution_handles_escapes_and_bad_paths():
    document = {"a/b": {"c~d": [10, 20]}}
    assert client._json_pointer(document, "#/a~1b/c~0d/1") == 20
    assert client._json_pointer(document, "#/a~1b/missing") is None
    assert client._json_pointer(document, "#/a~1b/c~0d/9") is None


# --- a provider schema can never make this server fetch anything --------------------------

FETCH_TARGETS = [
    "file:///C:/Windows/win.ini",
    "http://127.0.0.1:9/schema",
    "https://example.invalid/s",
]
HIDING_PLACES = ["enum", "const", "default", "examples", "x-hidden"]


@pytest.mark.parametrize("dialect", [None, DRAFT7])
@pytest.mark.parametrize("target", FETCH_TARGETS)
@pytest.mark.parametrize("place", HIDING_PLACES)
def test_a_local_pointer_into_data_cannot_reach_a_remote_reference(
    monkeypatch, place, target, dialect
):
    """The walk treats enum/const/default/examples/unknown keys as data, but a local
    pointer can still land on one and the validator would resolve what it holds."""
    from hushh_mcp.one_adk import governed_mcp_toolset as governed

    fetched = []

    def forbidden(*args, **kwargs):
        fetched.append(args)
        raise AssertionError("a reference was fetched")

    monkeypatch.setattr(urllib.request, "urlopen", forbidden)
    in_list = place in {"enum", "examples"}
    hidden = [{"$ref": target}] if in_list else {"$ref": target}
    pointer = f"#/properties/h/{place}" + ("/0" if in_list else "")
    schema = {
        "type": "object",
        "properties": {"h": {place: hidden}, "p": {"$ref": pointer}},
    }
    if dialect:
        schema["$schema"] = dialect
    try:
        client.validate_tool_schema(schema)
    except client.ExternalMcpError:
        return  # refused at admission is also fine
    with pytest.raises(client.ExternalMcpError) as caught:
        governed.validated_mcp_arguments(schema, {"p": "x"})
    assert caught.value.code == "MCP_SCHEMA_INVALID"
    assert fetched == []


def test_a_reference_outside_the_schema_never_resolves_even_by_the_validator():
    from hushh_mcp.one_adk import governed_mcp_toolset as governed

    schema = {"type": "object", "properties": {"p": {"$ref": "#/properties/missing"}}}
    with pytest.raises(client.ExternalMcpError) as caught:
        governed.validated_mcp_arguments(schema, {"p": 1})
    assert caught.value.code == "MCP_SCHEMA_INVALID"  # not a raw referencing error


# --- evaluation cost is bounded at admission -----------------------------------------------


def test_an_ordinary_shared_definition_is_still_admitted():
    shared = {"type": "string", "maxLength": 5}
    schema = {
        "type": "object",
        "properties": {
            "a": shared,
            **{f"r{i}": {"$ref": "#/properties/a"} for i in range(50)},
        },
    }
    assert client.validate_tool_schema(schema) == schema


@pytest.mark.parametrize(
    "recursive",
    [
        {"type": "object", "properties": {"a": {"$ref": "#/properties/a"}}},
        {"type": "object", "$ref": "#"},
    ],
)
def test_an_endless_reference_loop_is_a_schema_refusal_not_a_crash(recursive):
    from hushh_mcp.one_adk import governed_mcp_toolset as governed

    client.validate_tool_schema(recursive)  # a cycle alone is not refused at admission
    with pytest.raises(client.ExternalMcpError) as caught:
        governed.validated_mcp_arguments(recursive, {"a": 1})
    assert caught.value.code == "MCP_SCHEMA_INVALID"


def test_a_legitimate_recursive_schema_still_validates():
    from hushh_mcp.one_adk import governed_mcp_toolset as governed

    tree = {
        "type": "object",
        "properties": {
            "children": {"type": "array", "items": {"$ref": "#"}},
            "name": {"type": "string"},
        },
    }
    assert client.validate_tool_schema(tree) == tree
    assert governed.validated_mcp_arguments(tree, {"name": "a", "children": [{"name": "b"}]})
    with pytest.raises(client.ExternalMcpError):
        governed.validated_mcp_arguments(tree, {"children": [{"name": 5}]})


# --- draft-07 declares what it enforces ---------------------------------------------------


@pytest.mark.parametrize(
    "construct",
    [
        {"prefixItems": [{"type": "string"}]},
        {"dependentRequired": {"a": ["b"]}},
        {"dependentSchemas": {"a": {"required": ["b"]}}},
        {"unevaluatedProperties": False},
        {"unevaluatedItems": False},
        {"minContains": 2},
        {"maxContains": 2},
        {"$anchor": "foo"},
        {"$dynamicRef": "#x"},
        {"$dynamicAnchor": "x"},
        {"$recursiveAnchor": True},
    ],
)
def test_a_draft7_schema_cannot_carry_constructs_draft7_would_silently_ignore(construct):
    nested = zod_style_schema()
    nested["properties"]["deep"] = {"type": "array", **construct}
    assert code_of(nested) == "MCP_SCHEMA_INVALID"
    assert code_of(zod_style_schema(**construct)) == "MCP_SCHEMA_INVALID"


def test_draft7_roots_are_meta_checked_by_the_draft7_metaschema(monkeypatch):
    calls = []
    monkeypatch.setattr(
        client.Draft7Validator, "check_schema", classmethod(lambda cls, s: calls.append("d7"))
    )
    monkeypatch.setattr(
        client.Draft202012Validator,
        "check_schema",
        classmethod(lambda cls, s: calls.append("2020")),
    )
    client.validate_tool_schema(zod_style_schema())
    assert calls == ["d7"]
    calls.clear()
    client.validate_tool_schema({"type": "object"})
    assert calls == ["2020"]


# --- the group unwrap only trusts real groups ---------------------------------------------


def test_a_lookalike_exception_is_a_leaf_and_auth_or_timeout_outrank_others():
    class Lookalike(Exception):
        exceptions = ()

    inner = client.ExternalMcpError("m", code="C")
    assert client._external_error_in(ExceptionGroup("g", [inner, Lookalike()])) is None
    auth, timeout = client.ExternalMcpAuthError(), client.ExternalMcpTimeoutError()
    assert client._external_error_in(ExceptionGroup("g", [inner, timeout, auth])) is auth
    assert client._external_error_in(ExceptionGroup("g", [inner, timeout])) is timeout


# --- a realistic zod-style catalog passes the real catalog path -----------------------------


@pytest.mark.asyncio
async def test_a_draft7_catalog_passes_the_real_listing_path():
    def tool(name, schema):
        return SimpleNamespace(
            name=name, description=f"{name} tool", inputSchema=schema, annotations=None
        )

    session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(
                tools=[
                    tool("create-record", zod_style_schema()),
                    tool("find-records", {"type": "object", "$schema": DRAFT7, "properties": {}}),
                    tool("list-things", {"type": "object", "properties": {}}),
                ],
                nextCursor=None,
            )
        )
    )
    catalog = await client._list_session_tools(session)
    assert [item["name"] for item in catalog] == ["create-record", "find-records", "list-things"]


# --- the model-facing copy: edge cases the review found ----------------------------------


def test_pointer_resolution_rejects_lookalike_digits_and_decodes_fragments():
    assert client._json_pointer({"a": [1, 2]}, "#/a/\u00b2") is None  # superscript two
    assert client._json_pointer({"a": [1, 2]}, "#/a/\u0661") is None  # arabic-indic one
    assert client._json_pointer({"a": [1, 2]}, "#/a/01") is None  # no leading zeros
    assert client._json_pointer({"a b": 5}, "#/a%20b") == 5
    assert client._json_pointer({"a~1b": 7, "a/b": 9}, "#/a~01b") == 7  # ~01 is "~1", not "/"


def test_a_hostile_pointer_cannot_crash_the_copy():
    schema = {
        "type": "object",
        "properties": {"a": {"enum": [1]}, "b": {"$ref": "#/properties/a/enum/\u00b2"}},
    }
    assert client.model_facing_schema(schema) == schema  # left as written


def test_a_property_named_like_a_data_keyword_is_still_expanded():
    schema = {
        "type": "object",
        "properties": {"base": {"type": "string"}, "default": {"$ref": "#/properties/base"}},
    }
    facing = client.model_facing_schema(schema)
    assert facing["properties"]["default"] == {"type": "string"}
    assert "$ref" not in json.dumps(facing)


def test_a_ref_with_narrowing_siblings_keeps_both_conjunctively():
    schema = {
        "type": "object",
        "properties": {"s": {"type": "string"}, "t": {"$ref": "#/properties/s", "maxLength": 3}},
    }
    assert client.model_facing_schema(schema)["properties"]["t"] == {
        "allOf": [{"type": "string"}],
        "maxLength": 3,
    }


def test_one_large_node_referenced_many_times_is_stopped_by_the_byte_budget():
    schema = {
        "type": "object",
        "properties": {
            "big": {"type": "string", "description": "d" * 5000},
            **{f"r{i}": {"$ref": "#/properties/big"} for i in range(200)},
        },
    }
    started = time.monotonic()
    assert client.model_facing_schema(schema) == schema  # over budget: as written
    assert time.monotonic() - started < 2


# --- draft-07's own sub-schema positions are modelled, so nothing hides in them -------------

DRAFT7_HOMES = {
    "definitions": lambda hidden: {"definitions": {"x": hidden}},
    "dependencies": lambda hidden: {"dependencies": {"a": hidden}},
    "additionalItems": lambda hidden: {"additionalItems": hidden},
    "tuple_items": lambda hidden: {"items": [hidden]},
}


def draft7_with(home, hidden):
    schema = zod_style_schema()
    schema["properties"]["deep"] = {"type": "array", **DRAFT7_HOMES[home](hidden)}
    return schema


@pytest.mark.parametrize("home", sorted(DRAFT7_HOMES))
def test_ordinary_draft7_constructs_are_admitted(home):
    schema = draft7_with(home, {"type": "string"})
    assert client.validate_tool_schema(schema) == schema


def test_draft7_definitions_with_a_local_pointer_are_admitted_and_validate():
    from hushh_mcp.one_adk import governed_mcp_toolset as governed

    schema = {
        "type": "object",
        "$schema": DRAFT7,
        "definitions": {"Email": {"type": "string", "format": "email", "maxLength": 20}},
        "properties": {
            "to": {"$ref": "#/definitions/Email"},
            "pair": {
                "type": "array",
                "minItems": 2,
                "items": [{"type": "number"}, {"type": "string"}],
                "additionalItems": False,
            },
        },
    }
    assert client.validate_tool_schema(schema) == schema
    assert governed.validated_mcp_arguments(schema, {"to": "a@b.co", "pair": [1, "x"]})
    for bad in ({"to": 5}, {"pair": ["x", 1]}, {"pair": [1, "x", 3]}):
        with pytest.raises(client.ExternalMcpError):
            governed.validated_mcp_arguments(schema, bad)


@pytest.mark.parametrize("home", sorted(DRAFT7_HOMES))
@pytest.mark.parametrize(
    "hidden",
    [
        {"$id": "https://evil.invalid/s"},
        {"$ref": "https://evil.invalid/s"},
        {"$ref": "file:///C:/Windows/win.ini"},
        {"$schema": "https://unknown.invalid/schema"},
        {"$recursiveRef": "#"},
        {"type": "object", "properties": {"n": {"$id": "https://evil.invalid/n"}}},
        {"prefixItems": [{"type": "string"}]},
    ],
)
def test_nothing_can_hide_in_a_draft7_sub_schema_position(home, hidden):
    assert code_of(draft7_with(home, hidden)) == "MCP_SCHEMA_INVALID"


def test_the_https_form_of_the_draft7_dialect_is_accepted():
    for dialect in (
        "https://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft-07/schema",
    ):
        schema = zod_style_schema()
        schema["$schema"] = dialect
        assert client.validate_tool_schema(schema) == schema
        assert client.schema_validator_class(schema) is client.Draft7Validator


# --- evaluation failures of an admitted schema are controlled refusals -----------------------


@pytest.mark.parametrize(
    ("schema", "args"),
    [
        (
            {"type": "object", "properties": {"x": {"type": "number", "multipleOf": 10**400}}},
            {"x": 1.5},
        ),
        ({"type": "object", "properties": {"x": {"$ref": "#/properties/x"}}}, {"x": 1}),
    ],
)
def test_a_schema_that_cannot_be_evaluated_is_refused_not_crashed(schema, args):
    from hushh_mcp.one_adk import governed_mcp_toolset as governed

    client.validate_tool_schema(schema)  # admission does not evaluate
    with pytest.raises(client.ExternalMcpError) as caught:
        governed.validated_mcp_arguments(schema, args)
    assert caught.value.code == "MCP_SCHEMA_INVALID"


def test_an_absurd_pointer_index_cannot_crash_anything():
    schema = {
        "type": "object",
        "allOf": [{"type": "object"}],
        "properties": {"x": {"$ref": "#/allOf/" + "9" * 5000}},
    }
    client.validate_tool_schema(schema)
    assert client._json_pointer(schema, "#/allOf/" + "9" * 5000) is None
    assert client.model_facing_schema(schema) == schema


# --- the copy treats a $ref node's sibling keys like every other node's -----------------------


def test_names_beside_a_ref_are_expanded_even_when_they_look_like_data_keywords():
    schema = {
        "type": "object",
        "$defs": {
            "Base": {"type": "object", "properties": {"a": {"type": "string"}}},
            "Opt": {"type": "string", "enum": ["x"]},
        },
        "properties": {
            "obj": {
                "$ref": "#/$defs/Base",
                "properties": {
                    "default": {"$ref": "#/$defs/Opt"},
                    "enum": {"$ref": "#/$defs/Opt"},
                },
            }
        },
    }
    facing = client.model_facing_schema(schema)
    assert "$ref" not in json.dumps(facing["properties"])
    assert facing["properties"]["obj"]["properties"]["default"] == {"type": "string", "enum": ["x"]}


def test_an_uncompilable_pattern_is_refused_at_admission():
    schema = {"type": "object", "properties": {"x": {"type": "string", "pattern": "["}}}
    assert code_of(schema) == "MCP_SCHEMA_INVALID"
