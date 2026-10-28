"""Manifest-authored request meaning and a deterministic Drive discovery compiler.

Discovery is deliberately weaker than verification. Content and negative
predicates remain in the sealed plan even when Google cannot establish them.
No query, score, spelling hint or provider hit is permission to share a file.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal, Mapping
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SEMANTIC_PLAN_VERSION = 1
MAX_SEMANTIC_QUERY_CHARS = 1800


class SemanticPlanInputRequired(ValueError):
    """The bounded compiler cannot resolve an authored identity or search scope."""


class SemanticPredicate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")
    kind: Literal["entity", "content", "semantic", "title", "owner", "shared_by"]
    value: str = Field(min_length=1, max_length=160)
    match: Literal["token", "phrase", "exact"]
    negated: bool
    # Authored discovery clues, never alternate permission or relevance evidence.
    discovery_terms: list[str] = Field(max_length=4)

    @field_validator("value")
    @classmethod
    def literal(cls, value: str) -> str:
        if value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("invalid predicate literal")
        return value

    @field_validator("discovery_terms")
    @classmethod
    def clues(cls, values: list[str]) -> list[str]:
        if any(not 1 <= len(value) <= 160 for value in values):
            raise ValueError("invalid discovery literal")
        for value in values:
            cls.literal(value)
        if len(set(values)) != len(values):
            raise ValueError("duplicate discovery literal")
        return values

    @model_validator(mode="after")
    def typed_identity(self):
        if self.kind in {"owner", "shared_by"} and self.discovery_terms:
            raise ValueError("identity predicates cannot invent text discovery aliases")
        return self


class SemanticClause(BaseModel):
    """One conjunction; the plan is a disjunction of these clauses."""

    model_config = ConfigDict(extra="forbid", strict=True)
    predicates: list[SemanticPredicate] = Field(min_length=1, max_length=8)


class SemanticDrivePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    # Google structured-output enums accept strings only. Strict integer
    # bounds retain the version contract without an unsupported numeric enum.
    version: int = Field(ge=1, le=1)
    status: Literal["ready", "input_required"]
    clauses: list[SemanticClause] = Field(max_length=6)
    metadata_listing: bool
    # Picked dates stay host-bound. Only explicit metadata intent is pushed down.
    date_basis: Literal["title_created_modified", "created", "modified", "content"]
    clarification: str | None = Field(max_length=500)

    @field_validator("version", mode="before")
    @classmethod
    def exact_version(cls, value):
        if type(value) is not int or value != SEMANTIC_PLAN_VERSION:
            raise ValueError("unsupported semantic plan version")
        return value

    @model_validator(mode="after")
    def complete_expression(self):
        predicates = [item for clause in self.clauses for item in clause.predicates]
        if len(predicates) > 24 or len({item.id for item in predicates}) != len(predicates):
            raise ValueError("predicate identities must be unique and bounded")
        if self.status == "input_required":
            if not self.clarification or not self.clarification.strip():
                raise ValueError("unresolved request requires clarification")
            return self
        if self.clarification is not None:
            raise ValueError("ready request cannot carry an unresolved clarification")
        if self.metadata_listing == bool(self.clauses):
            raise ValueError("use either explicit predicates or a metadata listing")
        if any(all(item.negated for item in clause.predicates) for clause in self.clauses):
            raise ValueError("negative-only request needs a positive discovery boundary")
        return self


class SemanticPredicateV2(SemanticPredicate):
    sparse_fallback_any_token: bool = False

    @model_validator(mode="after")
    def bounded_sparse_fallback(self):
        if self.sparse_fallback_any_token and (
            self.kind != "entity"
            or self.match != "token"
            or self.negated
            or len({token.casefold() for token in self.value.split()}) < 2
        ):
            raise ValueError("sparse fallback requires a positive multi-token entity")
        return self


class SemanticClauseV2(SemanticClause):
    predicates: list[SemanticPredicateV2] = Field(min_length=1, max_length=8)


class SemanticDrivePlanV2(SemanticDrivePlan):
    version: int = Field(ge=2, le=2)
    clauses: list[SemanticClauseV2] = Field(max_length=6)
    date_basis: Literal["activity_union", "created", "modified", "content"]

    @field_validator("version", mode="before")
    @classmethod
    def exact_version(cls, value):
        if type(value) is not int or value != 2:
            raise ValueError("unsupported semantic plan version")
        return value


def parse_semantic_plan(plan) -> SemanticDrivePlan | SemanticDrivePlanV2:
    """Read the explicitly versioned contract without changing V1 canonical data."""
    payload = plan.model_dump(mode="json") if isinstance(plan, BaseModel) else plan
    model = (
        SemanticDrivePlanV2
        if isinstance(payload, Mapping)
        and type(payload.get("version")) is int
        and payload["version"] == 2
        else SemanticDrivePlan
    )
    return model.model_validate(payload)


def semantic_plan_digest(plan: SemanticDrivePlan | SemanticDrivePlanV2 | dict) -> str:
    """Canonical digest of the complete validated interpretation, not its query."""
    payload = parse_semantic_plan(plan).model_dump(mode="json")
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def _quoted(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _full_text(value: str, *, phrase: bool) -> str:
    if phrase or any(not char.isalnum() for char in value):
        value = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return _quoted(value)


def _identity(predicate: SemanticPredicate, resolved: Mapping[str, str]) -> str:
    # Model-authored names/addresses are not a trusted identity resolution.
    email = resolved.get(predicate.id)
    if (
        not isinstance(email, str)
        or not 3 <= len(email) <= 254
        or email != email.strip()
        or email.count("@") != 1
        or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in email)
        or not all(email.split("@"))
    ):
        raise SemanticPlanInputRequired("unresolved_identity")
    return email


def _predicate_query(predicate: SemanticPredicate, resolved: Mapping[str, str]) -> str | None:
    if predicate.kind in {"owner", "shared_by"}:
        identity = _identity(predicate, resolved)
        if predicate.negated:
            # Preserve negative identity constraints for fresh provider-fact verification.
            return None
        if predicate.kind == "shared_by":
            # writers/owners are NOT the person who shared a file. This is a
            # broad corpus clue; sharingUser must prove the actual identity.
            return "sharedWithMe = true"
        return f"{_quoted(identity)} in owners"
    if predicate.negated:
        # Google's content index cannot prove absence or semantic negation.
        return None
    if predicate.kind == "title" and predicate.match == "exact":
        return f"name = {_quoted(predicate.value)}"
    values = predicate.discovery_terms or [predicate.value]
    if predicate.match == "token":
        # Each word is a high-recall discovery anchor, not a replacement for
        # the full predicate the semantic verifier must still establish.
        values = list(dict.fromkeys(word for value in values for word in value.split()))
    clauses = []
    for value in values:
        title = f"name contains {_quoted(value)}"
        if predicate.kind == "title":
            clauses.append(title)
        else:
            clauses.append(
                f"({title} or fullText contains {_full_text(value, phrase=predicate.match != 'token')})"
            )
    return "(" + " or ".join(clauses) + ")"


def _metadata_period(
    *, start: str | None, end: str | None, timezone: str, basis: str
) -> str | None:
    if (start is None) != (end is None):
        raise ValueError("picked dates require both endpoints")
    zone = ZoneInfo(timezone)
    if start is None:
        return None
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first > last or first.isoformat() != start or last.isoformat() != end:
        raise ValueError("invalid picked date interval")
    if basis not in {"created", "modified"}:
        return None
    lower = datetime.combine(first, time.min, tzinfo=zone).astimezone(UTC)
    upper = datetime.combine(last + timedelta(days=1), time.min, tzinfo=zone).astimezone(UTC)
    field = "createdTime" if basis == "created" else "modifiedTime"
    return (
        f"({field} >= {_quoted(lower.strftime('%Y-%m-%dT%H:%M:%SZ'))} and "
        f"{field} < {_quoted(upper.strftime('%Y-%m-%dT%H:%M:%SZ'))})"
    )


def compile_semantic_queries(
    plan: SemanticDrivePlan | dict,
    *,
    file_kind: str = "any",
    period_start: str | None = None,
    period_end: str | None = None,
    timezone: str = "UTC",
    resolved_identities: Mapping[str, str] | None = None,
) -> list[dict]:
    """Compile high-recall discovery; all authored predicates survive for verification.

    resolved_identities is a trusted caller-owned predicate-ID-to-email binding,
    never a map accepted from a model or passed through from an API request.
    """
    from hushh_mcp.services.drive_live_reader import MIME_CLAUSES
    from hushh_mcp.services.drive_owner_search_service import _request_discovery_clause

    parsed = SemanticDrivePlan.model_validate(plan)
    if parsed.status != "ready":
        raise SemanticPlanInputRequired("request_input_required")
    if file_kind not in {"any", *MIME_CLAUSES}:
        raise ValueError("invalid file kind")
    resolved = resolved_identities or {}
    alternatives = []
    for clause in parsed.clauses:
        # Relationship constraints always need a caller-trusted identity,
        # including exclusions kept for verification rather than provider q.
        for predicate in clause.predicates:
            if predicate.kind in {"owner", "shared_by"}:
                _identity(predicate, resolved)
        positive = [predicate for predicate in clause.predicates if not predicate.negated]
        anchors = [
            predicate
            for predicate in positive
            if predicate.kind in {"entity", "title", "owner", "shared_by"}
        ] or positive
        # A semantic category may be established only inside a generic-titled
        # document. Prefer required identity/title anchors when present, while
        # preserving every omitted content condition in the verifier's plan.
        anchors = [
            query
            for predicate in anchors
            if (query := _predicate_query(predicate, resolved)) is not None
        ]
        if not anchors:
            raise SemanticPlanInputRequired("missing_discovery_boundary")
        alternatives.append("(" + " and ".join(anchors) + ")")
    base = ["trashed = false"]
    if file_kind != "any":
        # Folders and shortcuts are discovery paths, not additional eligible kinds.
        base.append(_request_discovery_clause(file_kind))
    period = _metadata_period(
        start=period_start, end=period_end, timezone=timezone, basis=parsed.date_basis
    )
    if period:
        base.append(period)
    query = " and ".join(
        [*(["(" + " or ".join(alternatives) + ")"] if alternatives else []), *base]
    )
    if len(query) > MAX_SEMANTIC_QUERY_CHARS:
        # Never silently omit a required clause to fit a provider budget.
        raise SemanticPlanInputRequired("query_budget_exceeded")
    arguments = {"query": query}
    if "fullText contains" not in query:
        field = "createdTime" if parsed.date_basis == "created" else "modifiedTime"
        arguments["orderBy"] = f"{field} desc"
    return [{"arguments": arguments}]
