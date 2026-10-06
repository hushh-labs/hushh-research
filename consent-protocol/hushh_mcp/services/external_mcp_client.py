"""Generic Streamable-HTTP MCP client for external connectors.

Hushh already runs a proven MCP client inside
`connected_systems_service.py`'s `ExternalCrmStreamableMcpAdapter._call_tool`
-- but that path is wired for one fixed CRM-record shape (5 operation names,
3 response-contract "versions" with named path segments). An external
connector's tool catalog does not share that shape, so this module extracts
just the transport-agnostic part -- `ClientSession` + `streamablehttp_client`
from the official `mcp` SDK -- with no response-contract mapping: callers get
the tool's raw result back, lightly normalized and size-capped.

Every tool description and every tool result from an external server is
untrusted data, never an instruction to a model. Callers must not
interpolate a raw result into a system/developer prompt; treat it as content
to summarize or display, the same caution issue #6581 raised about server
descriptions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote

from jsonschema import Draft7Validator, Draft202012Validator, validators
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry

from hushh_mcp.services.mcp_public_http import create_bounded_mcp_http_client, validate_mcp_endpoint

logger = logging.getLogger("external_mcp_client")

_DEFAULT_TIMEOUT_SECONDS = 20.0
_MAX_RESULT_BYTES = 32_000
_MAX_CATALOG_PAGES = 20
_MAX_CATALOG_TOOLS = 500
_MAX_CATALOG_BYTES = 1_000_000
_MAX_SCHEMA_DEPTH = 32
_MAX_SCHEMA_NODES = 4096


class ExternalMcpError(RuntimeError):
    def __init__(self, message: str, *, code: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class ExternalMcpTimeoutError(ExternalMcpError):
    def __init__(self) -> None:
        super().__init__(
            "The external connector did not respond in time.",
            code="EXTERNAL_MCP_TIMEOUT",
            status_code=504,
        )


class ExternalMcpAuthError(ExternalMcpError):
    def __init__(self) -> None:
        super().__init__(
            "The external connector rejected this credential.",
            code="EXTERNAL_MCP_AUTH_FAILED",
            status_code=401,
        )


@dataclass(frozen=True)
class ExternalMcpToolResult:
    is_error: bool
    payload: dict[str, Any]
    truncated: bool


def _http_status_from_error(error: BaseException, *, _seen: set[int] | None = None) -> int | None:
    seen = _seen if _seen is not None else set()
    if id(error) in seen:
        return None
    seen.add(id(error))
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    nested = getattr(error, "exceptions", None)
    if isinstance(nested, (tuple, list)):
        for child in nested:
            status = _http_status_from_error(child, _seen=seen)
            if status is not None:
                return status
    for nested_error in (getattr(error, "__cause__", None), getattr(error, "__context__", None)):
        if isinstance(nested_error, BaseException):
            status = _http_status_from_error(nested_error, _seen=seen)
            if status is not None:
                return status
    return None


def _error_types(error: BaseException, *, _seen: set[int] | None = None, _depth: int = 0) -> str:
    """Exception class names only, so a flattened failure can be told apart in logs.

    Never the message, arguments or traceback: those can carry authorization
    headers, URLs and returned document text. A class name cannot.
    """
    seen = _seen if _seen is not None else set()
    if id(error) in seen or _depth > 4:
        return ""
    seen.add(id(error))
    names = [type(error).__name__]
    children = list(getattr(error, "exceptions", None) or ())
    for link in (error.__cause__, error.__context__):
        if isinstance(link, BaseException):
            children.append(link)
    for child in children[:4]:
        if isinstance(child, BaseException) and (
            nested := _error_types(child, _seen=seen, _depth=_depth + 1)
        ):
            names.append(nested)
    return "<".join(names)


def _external_error_in(error: BaseException) -> ExternalMcpError | None:
    """The connector error a task group wrapped, if that is all it contained.

    The streamable-HTTP transport runs in an anyio task group, so an
    ExternalMcpError raised while the connection is open (an unsupported tool
    schema, say) leaves it wrapped in one or more ExceptionGroups. Without this
    it falls through to the generic handler and is reported as "could not
    reach the connector", hiding a specific, actionable reason. Only a group whose
    every leaf is a connector error is unwrapped; a mixed group is a real failure.
    """
    leaves: list[BaseException] = []

    def collect(node: BaseException, depth: int = 0) -> None:
        # Only a real exception group is descended into; any other exception is a
        # leaf however it is shaped, so a genuine failure beside a connector error
        # is never dropped.
        if isinstance(node, BaseExceptionGroup) and depth < 8:
            for child in node.exceptions:
                collect(child, depth + 1)
        else:
            leaves.append(node)

    collect(error)
    connector_errors = [leaf for leaf in leaves if isinstance(leaf, ExternalMcpError)]
    if not connector_errors or len(connector_errors) != len(leaves):
        return None
    # An authorization or timeout classification outranks a generic connector error.
    for kind in (ExternalMcpAuthError, ExternalMcpTimeoutError):
        for candidate in connector_errors:
            if isinstance(candidate, kind):
                return candidate
    return connector_errors[0]


_MODEL_SCHEMA_DATA_KEYS = {"enum", "const", "default", "examples"}
# Keys whose value is a map of NAME -> schema, so every entry is expanded even when a
# name collides with a data keyword (a property literally called "default").
_MODEL_SCHEMA_MAPS = {
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
}
_MODEL_SCHEMA_ANNOTATIONS = {
    "description",
    "title",
    "$comment",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
}
_MODEL_SCHEMA_MAX_REF_DEPTH = 8
_MODEL_SCHEMA_MAX_NODES = 20_000
_MODEL_SCHEMA_MAX_BYTES = 262_144
_POINTER_INDEX = re.compile(r"0|[1-9][0-9]{0,8}")


class _ExpansionBudgetExceeded(Exception):
    """Local reference expansion grew past its budget; use the schema as written."""


def _json_pointer(document: Any, reference: str) -> Any | None:
    """Resolve a `#/a/b/0` reference. None when it does not resolve."""
    node = document
    for part in reference[2:].split("/"):
        part = unquote(part).replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and _POINTER_INDEX.fullmatch(part) and int(part) < len(node):
            node = node[int(part)]
        else:
            return None
    return node


def model_facing_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """A conservative copy of a tool schema for the model's function declaration.

    Guidance only: argument validation always uses the provider's own admitted
    schema. The copy drops the root `$schema` and inlines local `#/...`
    references, so the model provider is never handed a dialect marker or a
    pointer form it may not accept (one rejected declaration would fail every chat
    turn for the owner). A reference that cannot be expanded safely (a cycle, a
    missing target, a size blowup) is left as the provider wrote it; the root
    `$schema` is always dropped.
    """
    source = json.loads(json.dumps(schema))
    source.pop("$schema", None)
    nodes = 0
    size = 0

    def spend(cost: int) -> None:
        # Counted as the copy is built, so a hostile fan-out of references (many
        # nodes, or one very large node referenced many times) is abandoned early
        # instead of being built and then measured.
        nonlocal nodes, size
        nodes += 1
        size += cost
        if nodes > _MODEL_SCHEMA_MAX_NODES or size > _MODEL_SCHEMA_MAX_BYTES:
            raise _ExpansionBudgetExceeded

    def entries(items: list[tuple[str, Any]], stack: tuple[str, ...]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, child in items:
            spend(len(key) + 2)
            if key in _MODEL_SCHEMA_DATA_KEYS:
                out[key] = child
            else:
                out[key] = expand(child, stack, names=key in _MODEL_SCHEMA_MAPS)
        return out

    def expand(node: Any, stack: tuple[str, ...], *, names: bool = False) -> Any:
        if isinstance(node, list):
            spend(2)
            return [expand(child, stack) for child in node]
        if not isinstance(node, dict):
            spend(len(node) + 2 if isinstance(node, str) else 8)
            return node
        spend(2)
        if names:
            # A map of NAME -> schema: its keys are names, never keywords.
            return {key: expand(child, stack) for key, child in node.items()}
        reference = node.get("$ref")
        if (
            isinstance(reference, str)
            and reference.startswith("#/")
            and reference not in stack
            and len(stack) < _MODEL_SCHEMA_MAX_REF_DEPTH
        ):
            target = _json_pointer(source, reference)
            if isinstance(target, dict):
                merged = expand(target, (*stack, reference))
                siblings = entries([(k, v) for k, v in node.items() if k != "$ref"], stack)
                if not siblings:
                    return merged
                if set(siblings) <= _MODEL_SCHEMA_ANNOTATIONS:
                    return {**merged, **siblings}
                # Keywords beside a $ref narrow the target; keep both, conjunctively.
                return {"allOf": [merged], **siblings}
        return entries(list(node.items()), stack)

    try:
        return expand(source, ())  # type: ignore[no-any-return]
    except (_ExpansionBudgetExceeded, RecursionError, ValueError, TypeError):
        return source  # type: ignore[no-any-return]


def _normalize_and_cap(
    result: Any, *, project: Callable[[dict[str, Any]], dict[str, Any]] | None = None
) -> ExternalMcpToolResult:
    is_error = bool(getattr(result, "isError", False) or getattr(result, "is_error", False))
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        # MCP's structured result is authoritative; content text is its
        # compatibility mirror and can be absent or much larger.
        payload = structured
    else:
        texts: list[str] = []
        for item in getattr(result, "content", None) or []:
            text = getattr(item, "text", None)
            if isinstance(text, str):
                texts.append(text)
        if len(texts) == 1:
            try:
                parsed = json.loads(texts[0])
            except json.JSONDecodeError:
                parsed = {"text": texts[0]}
            payload = parsed if isinstance(parsed, dict) else {"value": parsed}
        else:
            payload = {"content": texts}

    if project is not None and not is_error:
        payload = project(payload)

    serialized = json.dumps(payload)
    if len(serialized.encode("utf-8")) <= _MAX_RESULT_BYTES:
        return ExternalMcpToolResult(is_error=is_error, payload=payload, truncated=False)
    # An oversized result from an untrusted external server must never reach
    # a prompt context whole; cap it rather than pass it through.
    truncated_text = serialized[: _MAX_RESULT_BYTES // 2]
    return ExternalMcpToolResult(
        is_error=is_error,
        payload={"truncated": True, "preview": truncated_text},
        truncated=True,
    )


# The dialects a provider may declare. A schema is validated under the dialect it
# declares, so a provider's own contract is applied as written rather than
# reinterpreted. Anything else is refused. (zod-based servers, such as Attio's,
# declare draft-07 on every tool.)
_DIALECTS: dict[str, Any] = {
    Draft202012Validator.META_SCHEMA["$id"]: Draft202012Validator,
    "http://json-schema.org/draft-07/schema#": Draft7Validator,
    "http://json-schema.org/draft-07/schema": Draft7Validator,
    "https://json-schema.org/draft-07/schema#": Draft7Validator,
    "https://json-schema.org/draft-07/schema": Draft7Validator,
}
# 2019-09 / 2020-12 constructs a draft-07 validator silently ignores. A schema that
# declares draft-07 and uses one is refused: admitting it would drop constraints the
# provider believes it is enforcing.
_DRAFT7_UNMODELLED = {
    "prefixItems",
    "dependentRequired",
    "dependentSchemas",
    "unevaluatedProperties",
    "unevaluatedItems",
    "minContains",
    "maxContains",
    "$anchor",
    "$dynamicRef",
    "$dynamicAnchor",
    "$recursiveAnchor",
    "$vocabulary",
}


def schema_validator_class(schema: Any) -> Any | None:
    """The validator class for a schema's declared dialect, or None if unsupported.

    No declaration means 2020-12, the same default as before.
    """
    if not isinstance(schema, dict):
        return None
    dialect = schema.get("$schema")
    if dialect is None:
        return Draft202012Validator
    return _DIALECTS.get(dialect) if isinstance(dialect, str) else None


# A provider's schema is evaluated against what a model sent, on the event loop of a
# shared worker, and Python's `re` cannot be interrupted. Admission bounds the schema's
# size, not what evaluating it costs, so evaluation is bounded separately and
# deterministically (steps, never wall time): every sub-schema visit spends one step
# from the budget of the current call, and a hostile or accidental pathological schema
# ends the call as "too costly" instead of stalling the worker.
_MAX_EVALUATION_STEPS = 20_000
_MAX_PATTERN_LENGTH = 512
_MAX_PATTERN_SUBJECT = 2_048
# Exponential backtracking needs a repeated group whose body is itself repeated, and
# a subject long enough to matter; a short string is always cheap.
_NESTED_QUANTIFIER = re.compile(r"\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\d*\})")
_BACKTRACKING_SUBJECT = 24
_EVALUATION_BUDGET: ContextVar[list[int] | None] = ContextVar(
    "mcp_schema_evaluation_budget", default=None
)


def _too_costly() -> ExternalMcpError:
    return ExternalMcpError("Connector schema is too costly to evaluate.", code="MCP_SCHEMA_LIMIT")


def _spend(steps: int = 1) -> None:
    budget = _EVALUATION_BUDGET.get()
    if budget is None:
        return
    budget[0] -= steps
    if budget[0] < 0:
        raise _too_costly()


def _bounded_search(pattern: Any, subject: str) -> bool:
    """`re.search` for a provider's pattern, refused when it could not be cheap."""
    if (
        not isinstance(pattern, str)
        or len(pattern) > _MAX_PATTERN_LENGTH
        or len(subject) > _MAX_PATTERN_SUBJECT
        or (len(subject) > _BACKTRACKING_SUBJECT and _NESTED_QUANTIFIER.search(pattern))
    ):
        raise _too_costly()
    _spend(1 + len(subject) // 64)
    return re.search(pattern, subject) is not None


def _pattern(validator, patrn, instance, schema):  # type: ignore[no-untyped-def]
    if validator.is_type(instance, "string") and not _bounded_search(patrn, instance):
        yield ValidationError(f"{instance!r} does not match {patrn!r}")


def _pattern_properties(validator, pattern_properties, instance, schema):  # type: ignore[no-untyped-def]
    if not validator.is_type(instance, "object"):
        return
    for pattern, subschema in pattern_properties.items():
        for key, value in instance.items():
            if _bounded_search(pattern, key):
                yield from validator.descend(value, subschema, path=key, schema_path=pattern)


def _counted(keyword: Callable[..., Any]) -> Callable[..., Any]:
    def spend_then_evaluate(validator, value, instance, schema):  # type: ignore[no-untyped-def]
        _spend(1)
        return keyword(validator, value, instance, schema)

    return spend_then_evaluate


def _bounded_class(base: Any) -> Any:
    """`base` with every keyword spending a step and patterns guarded.

    Built with the library's own `extend`, never by subclassing: a subclass has its
    `evolve` replaced by the library, and a sub-schema's class would then be
    re-resolved from its own `$schema`, handing it the unbounded original.
    """
    keywords = {name: _counted(function) for name, function in base.VALIDATORS.items()}
    keywords["pattern"] = _counted(_pattern)
    keywords["patternProperties"] = _counted(_pattern_properties)
    bounded = validators.extend(base, validators=keywords)
    bounded.__name__ = f"Bounded{base.__name__}"
    return bounded


def _without_nested_dialects(node: Any, *, root: bool = True) -> Any:
    """A copy with every non-root `$schema` declaration removed.

    The library resolves the class of each sub-schema from its own `$schema`, so a
    nested declaration would route that sub-schema to the unbounded validator.
    A nested declaration may only repeat the root's dialect (admission), so it
    carries no information. A property that is itself named `$schema` has a schema
    object as its value, not a string, and is left alone.
    """
    if isinstance(node, dict):
        return {
            key: _without_nested_dialects(value, root=False)
            for key, value in node.items()
            if root or not (key == "$schema" and isinstance(value, str))
        }
    if isinstance(node, list):
        return [_without_nested_dialects(item, root=False) for item in node]
    return node


_BOUNDED: dict[Any, Any] = {}


def schema_validator(schema: Any) -> Any:
    """A validator for the schema's declared dialect that can never fetch a reference.

    Admission refuses remote references, but a local pointer can still land on a
    node the walk treats as data (an enum value, say), and the validator would then
    resolve whatever it holds. An empty registry means any reference that is not
    local to this schema fails instead of being retrieved over the network or from disk.

    Evaluation cost is bounded too (see `schema_is_valid` for the per-call budget).
    """
    validator_class = schema_validator_class(schema)
    if validator_class is None:
        raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
    bounded = _BOUNDED.get(validator_class)
    if bounded is None:
        bounded = _BOUNDED[validator_class] = _bounded_class(validator_class)
    return bounded(_without_nested_dialects(schema), registry=Registry())


def schema_is_valid(schema: Any, instance: Any) -> bool:
    """Whether `instance` satisfies the provider's schema, at a bounded cost.

    Raises `ExternalMcpError` (MCP_SCHEMA_LIMIT) when evaluating would exceed the
    step budget or needs a pattern that could not be cheap; the call is refused.
    """
    token = _EVALUATION_BUDGET.set([_MAX_EVALUATION_STEPS])
    try:
        return bool(schema_validator(schema).is_valid(instance))
    finally:
        _EVALUATION_BUDGET.reset(token)


def validate_tool_schema(schema: Any) -> dict[str, Any]:
    """Admit bounded object schemas without fetching provider-controlled references.

    Keep the provider's validation contract intact: unsupported schemas fail
    admission instead of silently dropping constraints. Descriptions remain
    untrusted content and do not determine execution permission.
    """
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ExternalMcpError("Invalid connector schema.", code="MCP_SCHEMA_INVALID")
    validator_class = schema_validator_class(schema)
    if validator_class is None:
        raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
    # A nested declaration may only repeat the root's dialect.
    permitted_dialect = schema.get("$schema") or Draft202012Validator.META_SCHEMA["$id"]
    draft7 = validator_class is Draft7Validator
    schema_maps = {"$defs", "properties", "patternProperties", "dependentSchemas"}
    if draft7:
        # Draft-07's own homes for sub-schemas, so a hidden $id or remote $ref in
        # one is checked like any other (`items` as a list is handled below).
        schema_maps |= {"definitions", "dependencies"}
    schema_arrays = {"allOf", "anyOf", "oneOf", "prefixItems"}
    schema_values = {
        "additionalProperties",
        "unevaluatedProperties",
        "propertyNames",
        "items",
        "unevaluatedItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
    }
    if draft7:
        schema_values.add("additionalItems")
    pending = [(schema, 0, "schema")]
    nodes = 0
    while pending:
        value, depth, kind = pending.pop()
        nodes += 1
        if depth > _MAX_SCHEMA_DEPTH or nodes > _MAX_SCHEMA_NODES:
            raise ExternalMcpError("Connector schema is too large.", code="MCP_SCHEMA_LIMIT")
        if isinstance(value, dict) and kind == "schema":
            # Remote refs and rebasing IDs may otherwise turn validation into
            # server-side requests, or change the meaning of local references.
            for key in ("$ref", "$dynamicRef"):
                reference = value.get(key)
                if reference is not None and (
                    not isinstance(reference, str) or not reference.startswith("#")
                ):
                    raise ExternalMcpError(
                        "Unsupported connector schema reference.", code="MCP_SCHEMA_INVALID"
                    )
            if "$id" in value or "$recursiveRef" in value:
                raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
            dialect = value.get("$schema")
            if dialect is not None and dialect != permitted_dialect:
                raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
            if draft7 and _DRAFT7_UNMODELLED.intersection(value):
                raise ExternalMcpError("Unsupported connector schema.", code="MCP_SCHEMA_INVALID")
        if isinstance(value, dict):
            for key, child in value.items():
                child_kind = "data"
                if kind == "map":
                    child_kind = "schema"
                elif kind == "schema":
                    if key in schema_maps:
                        child_kind = "map"
                    elif key in schema_arrays:
                        child_kind = "array"
                    elif key in schema_values:
                        # Draft-07 allows `items` as a list of schemas (a tuple).
                        child_kind = (
                            "array" if key == "items" and isinstance(child, list) else "schema"
                        )
                pending.append((child, depth + 1, child_kind))
        elif isinstance(value, list):
            pending.extend(
                (child, depth + 1, "schema" if kind == "array" else "data") for child in value
            )
    try:
        validator_class.check_schema(schema)
    except SchemaError:
        raise ExternalMcpError("Invalid connector schema.", code="MCP_SCHEMA_INVALID") from None
    # Not bounded here: the cost of EVALUATING a schema against an argument (a
    # recursive schema with several branches, say) depends on the argument, so no
    # estimate at admission can bound it. Callers that validate provider schemas
    # must treat evaluation as potentially expensive.
    return schema


_REVIEW_HINTS = ("readOnlyHint", "destructiveHint")


def _review_hints(tool: Any) -> dict[str, bool]:
    """Keep only boolean review hints; anything else is absent.

    Hints are the server's own claim. Absent or malformed hints never relax
    review, so dropping them here is the fail-closed direction. The pinned MCP
    SDK parses tools in pydantic lax mode, so "true", 1 or "yes" already arrive
    as True: the same claim, spelled loosely. Non-boolean shapes are dropped.
    """
    annotations = getattr(tool, "annotations", None)
    return {
        key: value
        for key in _REVIEW_HINTS
        if type(value := getattr(annotations, key, None)) is bool
    }


async def _list_session_tools(
    session: Any, *, include_review_hints: bool = False
) -> list[dict[str, Any]]:
    """Read a complete bounded catalog; never present a partial list as complete."""
    catalog: list[dict[str, Any]] = []
    names: set[str] = set()
    cursors: set[str] = set()
    cursor: str | None = None
    size = 0
    for _ in range(_MAX_CATALOG_PAGES):
        page = await session.list_tools(**({"cursor": cursor} if cursor else {}))
        for tool in page.tools:
            name = tool.name
            if not isinstance(name, str) or not name or name in names:
                raise ExternalMcpError("Invalid connector catalog.", code="MCP_CATALOG_INVALID")
            item = {
                "name": name,
                "description": getattr(tool, "description", None) or "",
                "inputSchema": getattr(tool, "inputSchema", None) or {},
            }
            if include_review_hints and (hints := _review_hints(tool)):
                item["annotations"] = hints
            validate_tool_schema(item["inputSchema"])
            size += len(json.dumps(item).encode("utf-8"))
            if len(catalog) >= _MAX_CATALOG_TOOLS or size > _MAX_CATALOG_BYTES:
                raise ExternalMcpError("Connector catalog is too large.", code="MCP_CATALOG_LIMIT")
            names.add(name)
            catalog.append(item)
        cursor = getattr(page, "nextCursor", None)
        if cursor is None:
            return sorted(catalog, key=lambda item: item["name"])
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ExternalMcpError("Invalid connector continuation.", code="MCP_CATALOG_INVALID")
        cursors.add(cursor)
    raise ExternalMcpError("Connector catalog is too large.", code="MCP_CATALOG_LIMIT")


async def list_tools(
    *, endpoint: str, headers: dict[str, str] | None = None, timeout_seconds: float | None = None
) -> list[dict[str, Any]]:
    """Probe a connector's live tool catalog (name, description, input schema)."""

    async def _run() -> list[dict[str, Any]]:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        validate_mcp_endpoint(endpoint)
        client_kwargs: dict[str, Any] = {
            "headers": dict(headers) if headers else None,
            "httpx_client_factory": create_bounded_mcp_http_client,
        }
        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _unused,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                return await _list_session_tools(session)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_seconds or _DEFAULT_TIMEOUT_SECONDS)
    except ExternalMcpError:
        raise
    except TimeoutError as error:
        raise ExternalMcpTimeoutError() from error
    except Exception as error:
        if (inner := _external_error_in(error)) is not None:
            raise inner from None
        status = _http_status_from_error(error)
        # This branch flattens every unexpected failure (a transport error, a
        # response the SDK cannot parse) into "could not reach", so record what
        # it was. Class names only; see _error_types.
        logger.warning(
            "external_mcp_client.list_tools_failed status=%s types=%s",
            status,
            _error_types(error),
        )
        if status in {401, 403}:
            raise ExternalMcpAuthError() from error
        raise ExternalMcpError(
            "Could not reach the external connector.", code="EXTERNAL_MCP_UNREACHABLE"
        ) from error


async def call_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    endpoint: str,
    headers: dict[str, str] | None = None,
    timeout_seconds: float | None = None,
    project: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> ExternalMcpToolResult:
    """Invoke one tool on an external connector's MCP server. Raw result,
    size-capped and lightly normalized -- no CRM-shaped response-contract
    mapping, since an arbitrary connector's tools share no fixed shape."""

    async def _run() -> ExternalMcpToolResult:
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        validate_mcp_endpoint(endpoint)
        client_kwargs: dict[str, Any] = {
            "headers": dict(headers) if headers else None,
            "httpx_client_factory": create_bounded_mcp_http_client,
        }
        async with streamablehttp_client(endpoint, **client_kwargs) as (
            read_stream,
            write_stream,
            _unused,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(name, arguments)
        return _normalize_and_cap(result, project=project)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_seconds or _DEFAULT_TIMEOUT_SECONDS)
    except ExternalMcpError:
        raise
    except TimeoutError as error:
        raise ExternalMcpTimeoutError() from error
    except Exception as error:
        if (inner := _external_error_in(error)) is not None:
            raise inner from None
        status = _http_status_from_error(error)
        # Provider/SDK exceptions can contain authorization headers, arguments,
        # URLs, and returned document text. Never retain their traceback or
        # model-supplied tool name in application diagnostics.
        logger.warning(
            "external_mcp_client.call_tool_failed status=%s types=%s",
            status,
            _error_types(error),
        )
        if status in {401, 403}:
            raise ExternalMcpAuthError() from error
        raise ExternalMcpError(
            "The external connector request failed.", code="EXTERNAL_MCP_CALL_FAILED"
        ) from error
