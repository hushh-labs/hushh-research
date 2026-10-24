"""Read complete capacity inventories through a caller-owned cloud adapter.

This module performs no import-time reads. It preserves each required check and
joins bounded UAT reads before returning any inventory for budget evaluation.
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any


class BudgetError(ValueError):
    """Inventory or policy is incomplete, so admission cannot be proved."""


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
        for revision in (by_name[revision_name] for revision_name in referenced):
            annotations = (revision.get("metadata") or {}).get("annotations") or {}
            if connection_name in annotations.get(
                "run.googleapis.com/cloudsql-instances", ""
            ).split(","):
                raise BudgetError(
                    f"{name}: reachable revision attaches to budgeted Cloud SQL"
                )
    return {"service": service, "revisions": revisions}


def collect_inventory(
    config: dict[str, Any],
    region: str,
    read: Callable[..., Any],
    *,
    parallel: bool,
) -> dict[str, Any]:
    project = config["project"]
    sql = read(
        "sql",
        "instances",
        "describe",
        config["database_instance"],
        f"--project={project}",
    )
    maximum = _database_maximum(sql)
    opts = (f"--project={project}", f"--region={region}")
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
        ),
        parallel=parallel,
    )
    services = {
        name: row for name, row in collected.items() if name not in non_database
    }
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
    return {"database_max_connections": maximum, "services": services, "jobs": jobs}
