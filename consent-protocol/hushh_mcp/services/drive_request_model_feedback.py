"""Bounded schema diagnostics without model values or exception prose."""

from __future__ import annotations

from functools import lru_cache
from typing import get_args

from pydantic import BaseModel, ValidationError
from pydantic_core import ErrorType

_ERROR_TYPES = frozenset(get_args(ErrorType))
# Model-validator failures have no field location. Only these authored,
# value-free cross-field codes may reach a correction prompt.
_SAFE_PLAN_RULES = frozenset(
    {
        "drive_subject_incomplete",
        "drive_specific_subject_missing",
        "drive_metadata_subject_conflict",
        "drive_term_group_canonical_mismatch",
        "drive_count_requires_recent_sort",
        "drive_search_boundary_missing",
        "drive_date_requires_file_activity",
        "drive_mixed_date_filters",
        "drive_calendar_range_invalid",
        "drive_semantic_subject_incomplete",
        "drive_semantic_scope_mismatch",
    }
)
_MAX_ISSUES = 8
_MAX_PATH = 8
_MAX_INDEX = 999


@lru_cache(maxsize=32)
def _owned_fields(schema: type[BaseModel]) -> frozenset[str]:
    names: set[str] = set()

    def visit(node):
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                names.update(properties)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(schema.model_json_schema())
    return frozenset(names)


def validation_feedback(error: BaseException, *, schema: type[BaseModel]) -> dict:
    """Expose only schema-owned field names, bounded indexes and known error types.

    Extra-field locations may contain arbitrary source text. Stop at the first
    unknown component rather than echoing it. Plain ValueError and provider
    exceptions have no trusted structured diagnostics and stay generic.
    """
    result = {"code": "invalid_model_output", "issues": []}
    if not isinstance(error, ValidationError):
        return result
    owned = _owned_fields(schema)
    for issue in error.errors(include_url=False, include_context=False, include_input=False)[
        :_MAX_ISSUES
    ]:
        location = []
        for component in issue.get("loc", ())[:_MAX_PATH]:
            if isinstance(component, str) and component in owned:
                location.append(component)
            elif type(component) is int and 0 <= component <= _MAX_INDEX:
                location.append(component)
            else:
                break
        kind = issue.get("type")
        result["issues"].append(
            {
                "location": location,
                "type": kind
                if kind in _ERROR_TYPES or kind in _SAFE_PLAN_RULES
                else "validation_error",
            }
        )
    return result
