"""Exact approved projection validation shared by hub and owner-pod composers."""

from datetime import date, datetime
from typing import Any


def scope_has_fact(scope: str, value: object) -> bool:
    """Structural completeness only; this never invents or writes an answer."""

    def substantive(item: object) -> bool:
        if item is None:
            return False
        if isinstance(item, str):
            return bool(item.strip())
        if isinstance(item, dict):
            return any(
                substantive(inner) for key, inner in item.items() if not key.startswith("__")
            )
        if isinstance(item, list):
            return any(substantive(inner) for inner in item)
        return isinstance(item, (int, float, bool))

    segments = scope.split(".")
    if len(segments) < 3 or segments[0] != "attr":
        return False
    # Scalars/lists may already be a leaf projection. Objects must carry the
    # approved attribute path; unrelated account context cannot fill a gap.
    if isinstance(value, dict):
        value = value.get(segments[1], value)
        for segment in segments[2:]:
            if segment == "*":
                break
            if not isinstance(value, dict) or segment not in value:
                return False
            value = value[segment]
    return substantive(value)


def valid_source_freshness(
    value: object, approved_scopes: list[str], approved_values: dict[str, Any]
) -> bool:
    """Bound revision/date metadata to the same exact scopes as the facts."""
    if not isinstance(value, dict) or not set(value) <= set(approved_scopes):
        return False
    try:
        for scope, freshness in value.items():
            if not isinstance(freshness, dict) or set(freshness) != {
                "sources",
                "derivedOn",
                "builtAt",
            }:
                return False
            built = freshness["builtAt"]
            if (
                not isinstance(built, str)
                or len(built) > 40
                or datetime.fromisoformat(built.replace("Z", "+00:00")).tzinfo is None
            ):
                return False
            derived = freshness["derivedOn"]
            if derived is not None and (
                not isinstance(derived, str)
                or len(derived) != 10
                or date.fromisoformat(derived).isoformat() != derived
            ):
                return False
            sources = freshness["sources"]
            if not isinstance(sources, list) or not 1 <= len(sources) <= 5:
                return False
            allowed_domains = {scope.split(".")[1], "one_memory", "account_profile"}
            approved_value = approved_values.get(scope)
            if scope == "attr.professional.profile.age" or (
                scope == "attr.professional.profile.*"
                and derived is not None
                and isinstance(approved_value, dict)
                and scope_has_fact("attr.professional.profile.age", approved_value)
            ):
                # An approved legacy age selector derives from canonical DOB;
                # only its source revisions travel, never the DOB value/path.
                allowed_domains.add("identity")
            for source in sources:
                if not isinstance(source, dict) or set(source) != {
                    "domain",
                    "contentRevision",
                    "manifestRevision",
                    "absent",
                }:
                    return False
                if source["domain"] not in allowed_domains or type(source["absent"]) is not bool:
                    return False
                if any(
                    revision is not None
                    and (type(revision) is not int or not 0 <= revision <= 2**53 - 1)
                    for revision in (source["contentRevision"], source["manifestRevision"])
                ):
                    return False
        return True
    except (ValueError, TypeError, IndexError):
        return False


def valid_answer_projection(work: dict, projection: object) -> bool:
    if not isinstance(projection, dict):
        return False
    values = projection.get("values")
    return bool(
        {"memory", "values"} <= set(projection) <= {"memory", "values", "sourceFreshness"}
        and isinstance(values, dict)
        and values
        and set(values) == set(work["approvedScopes"])
        and all(scope_has_fact(scope, value) for scope, value in values.items())
        and isinstance(projection.get("memory"), str)
        and len(str(projection)) <= 200_000
        and (
            "sourceFreshness" not in projection
            or valid_source_freshness(projection["sourceFreshness"], work["approvedScopes"], values)
        )
    )
