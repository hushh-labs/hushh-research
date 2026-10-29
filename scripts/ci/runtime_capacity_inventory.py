"""Read complete capacity inventories through a caller-owned cloud adapter.

This module performs no import-time reads. It preserves each required check and
joins bounded UAT reads before returning any inventory for budget evaluation.
"""

from __future__ import annotations

import importlib.util
import ipaddress
import hashlib
import sys
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

_SCOPE_SPEC = importlib.util.spec_from_file_location(
    "runtime_capacity_target_scope",
    Path(__file__).with_name("runtime_capacity_target_scope.py"),
)
assert _SCOPE_SPEC and _SCOPE_SPEC.loader
_scope = importlib.util.module_from_spec(_SCOPE_SPEC)
_SCOPE_SPEC.loader.exec_module(_scope)
BudgetError = _scope.BudgetError
ResolvedRouteSecret = _scope.ResolvedRouteSecret
VerifiedNonTargetInventory = _scope.VerifiedNonTargetInventory
ISOLATED_DEV_CONNECTION = _scope.ISOLATED_DEV_CONNECTION
isolated_dev_scope = _scope.isolated_dev_scope
non_target_rows = _scope.non_target_rows
_non_target_routing = _scope.non_target_routing


def _health_module():
    # File-import consumers retain their own checkout without ambient PYTHONPATH.
    path = (
        Path(__file__).resolve().parents[2]
        / "deploy/observability/auth_health_non_sql.py"
    )
    name = "_hussh_auth_health_" + hashlib.sha256(str(path).encode()).hexdigest()[:12]
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    assert Path(module.__file__).resolve() == path
    return module


def observability_rows(inventory, environment):
    proof = inventory.get("verified_non_sql_job")
    if proof is None:
        return []
    try:
        return _health_module().capacity_rows(proof, inventory["jobs"], environment)
    except ValueError as error:
        raise BudgetError("protected configuration job is unqualified") from error


def positive_int(value: Any, label: str, *, zero_ok: bool = False) -> int:
    if isinstance(value, bool) or not str(value).isdigit():
        raise BudgetError(f"{label}: expected a non-negative integer, got {value!r}")
    number = int(value)
    if not zero_ok and number == 0:
        raise BudgetError(f"{label}: expected a positive integer")
    return number


def _collect_named_inventory(
    names: list[str],
    read: Callable[[str], dict[str, Any]],
    *,
    parallel: bool,
) -> dict[str, Any]:
    """Join every required read before returning a complete inventory.

    Threads and gcloud descendants remain in the caller's process group, so the
    admission command's existing absolute deadline still owns their cleanup.
    The executor joins running reads even when another read fails.
    """
    if not parallel:
        return {name: read(name) for name in names}
    with ThreadPoolExecutor(max_workers=3) as executor:
        return dict(zip(names, executor.map(read, names), strict=True))


def _database_maximum(sql: dict[str, Any]) -> int:
    if sql.get("state") != "RUNNABLE":
        raise BudgetError(f"Cloud SQL instance is not RUNNABLE: {sql.get('state')}")
    flags = (sql.get("settings") or {}).get("databaseFlags") or []
    if not any(
        flag.get("name") == "cloudsql.iam_authentication" and flag.get("value") == "on"
        for flag in flags
    ):
        raise BudgetError("Cloud SQL IAM authentication flag is not on")
    values = [
        flag.get("value") for flag in flags if flag.get("name") == "max_connections"
    ]
    if len(values) != 1:
        raise BudgetError(
            "Cloud SQL max_connections must be explicitly configured and readable"
        )
    return positive_int(values[0], "Cloud SQL max_connections")


def _read_service_inventory(
    name: str,
    read: Callable[..., Any],
    opts: tuple[str, str],
    *,
    non_database: set[str],
    connection_name: str,
    isolated: bool = False,
    endpoints: set[str] | None = None,
    aliases: set[str] | None = None,
    resolve_secret: Callable | None = None,
    pending_latest: list | None = None,
) -> dict[str, Any]:
    service = read("run", "services", "describe", name, *opts)
    revisions = read("run", "revisions", "list", f"--service={name}", *opts)
    if not isinstance(revisions, list):
        raise BudgetError(f"{name}: revision inventory unavailable")
    if name in non_database:
        traffic = (service.get("status") or {}).get("traffic")
        if not isinstance(traffic, list):
            raise BudgetError(f"{name}: traffic unavailable")
        referenced = {
            target.get("revisionName")
            for target in traffic
            if target.get("tag") or target.get("percent", 0)
        }
        latest = (service.get("status") or {}).get("latestReadyRevisionName")
        if latest:
            referenced.add(latest)
        by_name = {(rev.get("metadata") or {}).get("name"): rev for rev in revisions}
        if None in referenced or referenced - by_name.keys():
            raise BudgetError(f"{name}: referenced revision unavailable")
        selected = (
            revisions
            if isolated
            else [by_name[revision_name] for revision_name in referenced]
        )
        for revision in selected:
            annotations = (revision.get("metadata") or {}).get("annotations") or {}
            if connection_name in annotations.get(
                "run.googleapis.com/cloudsql-instances", ""
            ).split(","):
                raise BudgetError(
                    f"{name}: reachable revision attaches to budgeted Cloud SQL"
                )
        if isolated:
            if not isinstance(service.get("spec", {}).get("template"), dict) or len(
                by_name
            ) != len(revisions):
                raise BudgetError(
                    "non-target service template/revision inventory is incomplete"
                )
            if any(
                not isinstance(key, str) or not key.startswith(name + "-")
                for key in by_name
            ):
                raise BudgetError("non-target retained revision identity is ambiguous")
            versions: set[str] = set()
            for workload in (service, *revisions):
                versions.update(
                    _non_target_routing(
                        workload, endpoints, aliases, resolve_secret, pending_latest
                    )
                )
            return {
                "service": service,
                "revisions": revisions,
                "non_target": {
                    "name": name,
                    "connections": 0,
                    "capacity_classification": "not-target-instance",
                    "checked_revisions": sorted(by_name),
                    "template_checked": True,
                    "resolved_secret_versions": sorted(versions),
                },
            }
    return {"service": service, "revisions": revisions}


def _isolated_identity(sql, project, region, read):
    if (
        sql.get("project") != project
        or sql.get("name") != "plg-qualification-pg"
        or sql.get("region") != region
        or sql.get("connectionName") != ISOLATED_DEV_CONNECTION
    ):
        raise BudgetError("isolated DEV SQL identity is not bound")
    project_record = read("projects", "describe", project)
    number = str(project_record.get("projectNumber", ""))
    if project_record.get("projectId") != project or not number.isdigit():
        raise BudgetError("isolated DEV project identity is unavailable")
    aliases = {project, number}
    addresses = sql.get("ipAddresses")
    if not isinstance(addresses, list) or not addresses:
        raise BudgetError("isolated DEV SQL endpoint inventory is unavailable")
    try:
        endpoints = {str(ipaddress.ip_address(row["ipAddress"])) for row in addresses}
    except (KeyError, TypeError, ValueError):
        raise BudgetError("isolated DEV SQL endpoint inventory is malformed") from None
    endpoints.update({ISOLATED_DEV_CONNECTION, "plg-qualification-pg"})
    return endpoints, aliases


def _service_partition(config, read, opts):
    listed_services = read("run", "services", "list", *opts)
    if not isinstance(listed_services, list):
        raise BudgetError("Cloud Run services inventory unavailable")
    service_names = {
        (service.get("metadata") or {}).get("name") for service in listed_services
    }
    profiled = set(config["services"])
    non_database = set(config["non_database_services"])
    if None in service_names:
        raise BudgetError("Cloud Run service inventory contains an unnamed service")
    if service_names - profiled != non_database:
        raise BudgetError(
            f"Cloud Run service inventory drift: unprofiled={sorted((service_names - profiled) - non_database)}, "
            f"missing declared non-DB={sorted(non_database - service_names)}"
        )
    required = {
        name
        for name, settings in config["services"].items()
        if not settings.get("optional_existing")
    }
    if required - service_names:
        raise BudgetError(
            f"required database services missing: {sorted(required - service_names)}"
        )

    return service_names, non_database


def _job_inventory(read, opts, parallel):
    listed = read("run", "jobs", "list", *opts)
    if not isinstance(listed, list):
        raise BudgetError("Cloud Run jobs inventory unavailable")
    names = [(job.get("metadata") or {}).get("name") for job in listed]
    if any(not isinstance(name, str) for name in names) or len(names) != len(
        set(names)
    ):
        raise BudgetError("Cloud Run jobs inventory malformed")
    jobs = _collect_named_inventory(
        names,
        lambda name: read("run", "jobs", "describe", name, *opts),
        parallel=parallel,
    )
    return jobs


def _non_target_jobs(
    config, jobs, read, opts, endpoints, aliases, resolve_secret, pending_latest
):
    if set(jobs) != set(config["jobs"]) | set(config["non_target_jobs"]):
        raise BudgetError("isolated DEV job inventory differs from exact partition")
    zero_jobs = []
    for name in config["non_target_jobs"]:
        versions = _non_target_routing(
            jobs[name], endpoints, aliases, resolve_secret, pending_latest
        )
        executions = read("run", "jobs", "executions", "list", "--job=" + name, *opts)
        if not isinstance(executions, list) or len(executions) > 10_000:
            raise BudgetError("non-target job execution inventory is unavailable")
        active = []
        seen = set()
        for execution in executions:
            execution_name = execution.get("metadata", {}).get("name")
            if (
                not isinstance(execution_name, str)
                or not execution_name.startswith(name + "-")
                or execution_name in seen
            ):
                raise BudgetError("non-target job execution identity is ambiguous")
            seen.add(execution_name)
            if execution.get("status", {}).get("completionTime"):
                continue
            observed = read(
                "run", "jobs", "executions", "describe", execution_name, *opts
            )
            if observed.get("metadata", {}).get("name") != execution_name:
                raise BudgetError("non-target execution read changed identity")
            if (
                observed.get("metadata", {})
                .get("labels", {})
                .get("run.googleapis.com/job")
                != name
            ):
                raise BudgetError("non-target execution belongs to another job")
            versions.update(
                _non_target_routing(
                    observed, endpoints, aliases, resolve_secret, pending_latest
                )
            )
            active.append(execution_name)
        zero_jobs.append(
            {
                "name": name,
                "connections": 0,
                "capacity_classification": "not-target-instance",
                "template_checked": True,
                "checked_active_executions": sorted(active),
                "resolved_secret_versions": sorted(versions),
            }
        )
    return zero_jobs


def _recheck_routes(
    config, project, sql, maximum, read, resolve_secret, pending_latest
):
    for workload, node, version in pending_latest:
        current = _scope.observe_route_secret(resolve_secret, workload, node, project)
        if type(current) is not ResolvedRouteSecret or current.resource_name != version:
            raise BudgetError("non-target route secret changed during collection")
    latest_sql = read(
        "sql",
        "instances",
        "describe",
        config["database_instance"],
        f"--project={project}",
    )
    if (
        _database_maximum(latest_sql) != maximum
        or latest_sql.get("connectionName") != ISOLATED_DEV_CONNECTION
        or latest_sql.get("settings", {}).get("settingsVersion")
        != sql.get("settings", {}).get("settingsVersion")
    ):
        raise BudgetError("isolated DEV SQL changed during collection")


def collect_inventory(
    config: dict[str, Any],
    region: str,
    read: Callable[..., Any],
    *,
    parallel: bool,
    environment: str | None = None,
    resolve_secret: Callable | None = None,
) -> dict[str, Any]:
    isolated = isolated_dev_scope(config, region, environment)
    project = config["project"]
    sql = read(
        "sql",
        "instances",
        "describe",
        config["database_instance"],
        f"--project={project}",
    )
    maximum = _database_maximum(sql)
    endpoints, aliases, pending_latest = set(), set(), []
    if isolated:
        endpoints, aliases = _isolated_identity(sql, project, region, read)
        parallel = False
    opts = (f"--project={project}", f"--region={region}")
    service_names, non_database = _service_partition(config, read, opts)

    # Only independent reads overlap. Keep describe -> revisions ordering per
    # service, including every non-database attachment check, and retain the
    # serial production path for this bounded UAT rollout.
    collected = _collect_named_inventory(
        sorted(service_names),
        lambda name: _read_service_inventory(
            name,
            read,
            opts,
            non_database=non_database,
            connection_name=f"{project}:{region}:{config['database_instance']}",
            isolated=isolated,
            endpoints=endpoints,
            aliases=aliases,
            resolve_secret=resolve_secret,
            pending_latest=pending_latest,
        ),
        parallel=parallel,
    )
    services = (
        collected
        if isolated
        else {name: row for name, row in collected.items() if name not in non_database}
    )
    jobs = _job_inventory(read, opts, parallel)
    result = {"database_max_connections": maximum, "services": services, "jobs": jobs}
    if environment == "production" and project == "hushh-pda":
        health = _health_module()
        if health.NAME in jobs:
            try:
                result["verified_non_sql_job"] = health.qualify(jobs[health.NAME], read)
            except ValueError as error:
                raise BudgetError(
                    "protected configuration job is unqualified"
                ) from error
    if not isolated:
        return result
    zero_jobs = _non_target_jobs(
        config, jobs, read, opts, endpoints, aliases, resolve_secret, pending_latest
    )
    _recheck_routes(config, project, sql, maximum, read, resolve_secret, pending_latest)
    result["non_target_workloads"] = VerifiedNonTargetInventory(
        ISOLATED_DEV_CONNECTION,
        tuple(collected[name]["non_target"] for name in sorted(non_database)),
        tuple(zero_jobs),
    )
    return result
