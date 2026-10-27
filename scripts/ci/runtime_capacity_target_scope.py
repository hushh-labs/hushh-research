"""Fixed DEV target-routing admission; no cloud access or budget calculation."""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, NamedTuple
from urllib.parse import unquote

ISOLATED_DEV_SCOPE = "plg-isolated-dev-v1"
ISOLATED_DEV_CONNECTION = "hushh-pda-dev:us-central1:plg-qualification-pg"


@dataclass(frozen=True, slots=True)
class ResolvedRouteSecret:
    """Actual Secret Manager version and in-memory payload from the fixed reader."""

    resource_name: str
    payload: str = field(repr=False)


class VerifiedNonTargetInventory(NamedTuple):
    """Collector-owned proof; parsed local JSON is not an admission input."""

    connection_name: str
    services: tuple[dict[str, Any], ...]
    jobs: tuple[dict[str, Any], ...]


class BudgetError(ValueError):
    """Inventory or policy is incomplete, so admission cannot be proved."""


def isolated_dev_scope(
    config: dict[str, Any], region: str, environment: str | None
) -> bool:
    mode = config.get("capacity_scope")
    if mode is None:
        if "non_target_jobs" in config:
            raise BudgetError("non-target job mode requires fixed isolated DEV scope")
        return False
    if (
        mode != ISOLATED_DEV_SCOPE
        or environment != "dev"
        or region != "us-central1"
        or config.get("project") != "hushh-pda-dev"
        or config.get("database_instance") != "plg-qualification-pg"
    ):
        raise BudgetError("non-target accounting is limited to fixed isolated DEV")
    for key in ("non_database_services", "non_target_jobs"):
        names = config.get(key)
        if (
            not isinstance(names, list)
            or any(
                not isinstance(name, str)
                or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name)
                for name in names
            )
            or len(names) != len(set(names))
        ):
            raise BudgetError("fixed isolated DEV workload partition is malformed")
    if set(config.get("jobs", {})) & set(config["non_target_jobs"]):
        raise BudgetError("a job cannot be target and non-target")
    if set(config.get("services", {})) & set(config["non_database_services"]):
        raise BudgetError("a service cannot be target and non-target")
    return True


def _walk(value: Any, depth: int = 0):
    if depth > 16:
        raise BudgetError("workload target routing exceeds supported depth")
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child, depth + 1)
    elif isinstance(value, str):
        yield value


def _route_setting(name: str) -> bool:
    upper = name.upper()
    return (
        "CONFIG" in upper
        or "SETTINGS" in upper
        or upper
        in {
            "PGHOST",
            "PGHOSTADDR",
            "PGSERVICE",
            "DB_HOST",
            "DB_UNIX_SOCKET",
            "CLOUDSQL_INSTANCE_CONNECTION_NAME",
            "INSTANCE_CONNECTION_NAME",
        }
        or (
            any(part in upper for part in ("DATABASE", "POSTGRES", "DB_", "SQL", "PG"))
            and upper.endswith(
                (
                    "_HOST",
                    "_URL",
                    "_URI",
                    "_DSN",
                    "_SOCKET",
                    "_INSTANCE",
                    "_CONNECTION_NAME",
                )
            )
        )
        or any(
            part in upper
            for part in (
                "DATABASE_URL",
                "DATABASE_URI",
                "POSTGRES_URL",
                "SQLALCHEMY_URL",
                "JDBC_URL",
            )
        )
    )


def _secret_aliases(workload: dict) -> tuple[dict[str, str], bool]:
    """Use Cloud Run's CSV grammar, as commerce-preview-verify.secret_binding does."""
    mapping: dict[str, str] = {}
    present = False
    for item in _walk(workload):
        if not isinstance(item, dict):
            continue
        annotations = item.get("annotations", {})
        if not isinstance(annotations, dict):
            raise BudgetError("non-target secret alias metadata is malformed")
        if "run.googleapis.com/secrets" not in annotations:
            continue
        present = True
        encoded = annotations["run.googleapis.com/secrets"]
        if not isinstance(encoded, str) or not encoded:
            raise BudgetError("non-target secret alias map is unresolved")
        seen: set[str] = set()
        for entry in encoded.split(","):
            alias, separator, resource = entry.partition(":")
            if (
                not separator
                or not re.fullmatch(r"[A-Za-z0-9_-]+", alias)
                or not re.fullmatch(r"projects/[^/]+/secrets/[A-Za-z0-9_-]+", resource)
                or alias in seen
            ):
                raise BudgetError("non-target secret alias map is malformed")
            if alias in mapping and mapping[alias] != resource:
                raise BudgetError("non-target secret alias is ambiguous")
            seen.add(alias)
            mapping[alias] = resource
    return mapping, present


def route_secret_reference(workload: dict, reference: dict, aliases: set[str]) -> dict:
    """Resolve Cloud Run's metadata alias before the normal scoped SM reader."""
    expected = reference["name"]
    if not isinstance(expected, str):
        raise BudgetError("non-target secret name is malformed")
    mapping, present = _secret_aliases(workload)
    if expected in mapping:
        expected = mapping[expected]
    elif present and not expected.startswith("projects/"):
        raise BudgetError("non-target secret alias is unresolved")
    if expected.startswith("projects/"):
        match = re.fullmatch(r"projects/([^/]+)/secrets/([A-Za-z0-9_-]+)", expected)
        if match is None or match[1] not in aliases:
            raise BudgetError("non-target route secret belongs to another project")
        expected = match[2]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", expected):
        raise BudgetError("non-target route secret is not a fixed name")
    return {"name": expected, "key": reference["key"]}


def observe_route_secret(reader, workload, node, project):
    try:
        return reader(workload, node, project)
    except Exception:
        raise BudgetError("non-target route secret is unavailable") from None


def _route_payload(resolved, reference, aliases):
    if type(resolved) is not ResolvedRouteSecret or not isinstance(
        resolved.payload, str
    ):
        raise BudgetError("non-target secret resolver returned untyped observation")
    match = re.fullmatch(
        r"projects/([^/]+)/secrets/([A-Za-z0-9_-]+)/versions/([1-9][0-9]*)",
        resolved.resource_name,
    )
    if (
        match is None
        or match[1] not in aliases
        or match[2] != reference["name"]
        or len(resolved.payload.encode()) > 65_536
    ):
        raise BudgetError("non-target secret version is unbound")
    if reference["key"].isdigit() and match[3] != reference["key"]:
        raise BudgetError("non-target secret version differs from mount")
    return resolved.payload


def non_target_routing(
    workload: dict[str, Any],
    endpoints: set[str],
    aliases: set[str],
    resolve_secret: Callable | None,
    pending_latest: list,
) -> set[str]:
    """Inspect declared routing, including opaque route-bearing config in memory."""
    versions: set[str] = set()

    def inspect(value: Any) -> None:
        for item in _walk(value):
            if isinstance(item, str) and any(
                endpoint in unquote(item) for endpoint in endpoints
            ):
                raise BudgetError(
                    "non-target workload references isolated DEV instance"
                )

    inspect(workload)
    for node in _walk(workload):
        if not isinstance(node, dict):
            continue
        # A secret/config volume needs an explicit route adapter; don't infer
        # zero demand from an absent Cloud SQL annotation alone.
        if node.get("volumes"):
            raise BudgetError("unresolved non-target volume routing")
        name = node.get("name")
        if not isinstance(name, str) or not _route_setting(name):
            continue
        if "value" in node:
            value = node["value"]
        elif "valueFrom" in node:
            origin = node["valueFrom"]
            reference = origin.get("secretKeyRef") if isinstance(origin, dict) else None
            if not isinstance(reference, dict) or resolve_secret is None:
                raise BudgetError("unresolved non-target secret routing")
            key = (reference.get("name"), reference.get("key"))
            if not all(isinstance(part, str) and part for part in key):
                raise BudgetError("non-target secret reference is malformed")
            reference = route_secret_reference(workload, reference, aliases)
            normalized = {**node, "valueFrom": {"secretKeyRef": reference}}
            resolved = observe_route_secret(
                resolve_secret, workload, normalized, "hushh-pda-dev"
            )
            _route_payload(resolved, reference, aliases)
            versions.add(resolved.resource_name)
            if key[1] == "latest":
                pending_latest.append((workload, normalized, resolved.resource_name))
            value = resolved.payload
        else:
            continue
        if not isinstance(value, str):
            raise BudgetError("non-target route setting is not a string")
        if "CONFIG" in name.upper() or "SETTINGS" in name.upper():
            try:
                config = json.loads(value)
            except (ValueError, TypeError):
                raise BudgetError("unresolved non-target config routing") from None
            if not isinstance(config, dict):
                raise BudgetError("non-target config route is not an object")
            for section in _walk(config):
                if isinstance(section, str) and "$" in section:
                    raise BudgetError("unresolved non-target interpolated config route")
            inspect(config)
        elif "$" in value:
            raise BudgetError("unresolved non-target interpolated routing")
        inspect(value)
    return versions


def non_target_rows(proof: Any, config: dict[str, Any], environment: str, region: str):
    """Expose zero rows only from the genuine collector's fixed-scope result."""
    if not isolated_dev_scope(config, region, environment):
        if proof is not None:
            raise BudgetError("non-target proof cannot qualify an ordinary environment")
        return [], []
    if (
        type(proof) is not VerifiedNonTargetInventory
        or proof.connection_name != ISOLATED_DEV_CONNECTION
    ):
        raise BudgetError("fixed isolated DEV needs collector-owned non-target proof")
    for rows, names in (
        (proof.services, config["non_database_services"]),
        (proof.jobs, config["non_target_jobs"]),
    ):
        if (
            {row.get("name") for row in rows} != set(names)
            or len(rows) != len(names)
            or any(
                row.get("connections") != 0
                or row.get("capacity_classification") != "not-target-instance"
                for row in rows
            )
        ):
            raise BudgetError(
                "non-target proof does not cover exact workload partition"
            )
    return list(proof.services), list(proof.jobs)
