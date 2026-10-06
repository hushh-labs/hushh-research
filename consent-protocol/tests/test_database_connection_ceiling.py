"""Every deploy path's worst-case Postgres connection count fits its lane's limit.

Dev Cloud SQL reached 99 of its 100 connections on 2026-10-01 and 2026-10-02, and
UAT reached 148 of 150. Neither was a surprise once multiplied out: every hub
worker opens its own asyncpg pool, its own SQLAlchemy pool, and its own dedicated
lock connections, and a rollout runs the old and the new revision side by side.

This guard reads the real deploy config (the lane workflows, the fallback release
script, the Cloud Build template defaults, the dev capacity block and worker count
in ``scripts/deploy/backend-deploy.sh``, the drive worker scripts, and the
connection sources in ``consent-protocol/db``) and computes, for every deploy path:

    rollout instances  = rollout_overlap.factor x max instances
    per worker         = asyncpg max + SQLAlchemy pool + overflow + dedicated
    worst case         = rollout instances x workers x per worker
                         + companion services (same formula)
                         + release migration job pool
                         + external_reserve (measured, outside the deploy config)
                         + superuser_reserved_connections

It is a ratchet, per deploy path. A worst case within ``ceiling_fraction`` of the
lane's ``max_connections`` passes. Above it, the path passes only while it carries
an ``accepted_worst_case`` (a recorded, pending owner decision) equal to its
current worst case, so an undecided path cannot get worse while it waits, and the
recorded number has to come down when the path improves. The limits, and
where each one was measured, live in
``consent-protocol/config/database_connection_limits.json``.

The LISTEN connections each worker holds (``listener_modules``) are drawn from its
asyncpg pool, so they are inside ``asyncpg max`` and not added again; they are why
the pool needs at least one connection more than there are listeners.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "consent-protocol"
LIMITS = json.loads(
    (BACKEND_ROOT / "config" / "database_connection_limits.json").read_text(encoding="utf-8")
)
BACKEND_DEPLOY = REPO_ROOT / "scripts" / "deploy" / "backend-deploy.sh"
TEMPLATE = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"

# The 2026-08-28 first-run measurement: setup routes starved when the asyncpg pool
# left requests almost nothing after the LISTEN connections. Shrinking it to fit
# the ceiling would trade one outage for another, so the floor is part of the guard.
MIN_FREE_REQUEST_CONNECTIONS = 1
LISTENER_MODULES = tuple(LIMITS["listener_modules"]["modules"])

POOL_KEYS = ("_DB_POOL_MAX_SIZE", "_DB_SQLALCHEMY_POOL_SIZE", "_DB_SQLALCHEMY_MAX_OVERFLOW")
CAPACITY_KEYS = (
    "_CLOUD_RUN_MAX_INSTANCES",
    "_CLOUD_RUN_MEMORY",
    "_CLOUD_RUN_CPU",
    "_CLOUD_RUN_CONCURRENCY",
)
_SUBSTITUTION = re.compile(r"(_[A-Z0-9_]+)=([^,#\"\s]*)")
_CONNECTION_OPENER = re.compile(
    r"(?<![\w.])(?:asyncpg\.connect|asyncpg\.create_pool|create_engine|create_async_engine"
    r"|psycopg2?\.connect)\(|(?<![\w.])dedicated_connection\b"
)


@dataclass(frozen=True)
class Fleet:
    """One service's connection shape: instances x workers x per-worker connections."""

    name: str
    max_instances: int
    workers: int
    per_worker: int

    @property
    def rollout_total(self) -> int:
        factor = int(LIMITS["rollout_overlap"]["factor"])
        return factor * self.max_instances * self.workers * self.per_worker

    def describe(self) -> str:
        factor = LIMITS["rollout_overlap"]["factor"]
        return (
            f"{self.name}: {factor} x {self.max_instances} instances x {self.workers} workers"
            f" x {self.per_worker} per worker = {self.rollout_total}"
        )


def _read(relative: str) -> str:
    return (REPO_ROOT / relative).read_text(encoding="utf-8")


def _template_defaults() -> dict[str, str]:
    substitutions = yaml.safe_load(TEMPLATE.read_text(encoding="utf-8"))["substitutions"]
    return {key: str(value) for key, value in substitutions.items()}


def _substitutions_from_line(text: str, relative: str) -> dict[str, str]:
    """The backend deploy's substitution string: the one line naming _BACKEND_SERVICE."""
    lines = [line for line in text.splitlines() if "_BACKEND_SERVICE=" in line]
    assert len(lines) == 1, (
        f"{relative}: expected one backend substitution line, found {len(lines)}"
    )
    return dict(_SUBSTITUTION.findall(lines[0]))


def _release_script_branch(text: str, branch: str) -> dict[str, str]:
    """The production or non-production SUBS block of scripts/ops/cloudbuild_release.sh."""
    start = text.index('if [[ "$TARGET_ENV" == "production" ]]; then')
    end = text.index("run gcloud builds submit", start)
    production, non_production = text[start:end].split("\n  else\n", 1)
    return dict(_SUBSTITUTION.findall(production if branch == "production" else non_production))


def _deploy_path_values(deploy_path: dict[str, str]) -> dict[str, str]:
    relative = deploy_path["path"]
    text = _read(relative)
    if "branch" in deploy_path:
        declared = _release_script_branch(text, deploy_path["branch"])
    else:
        declared = _substitutions_from_line(text, relative)
    return {**_template_defaults(), **declared}


def _run_bash(snippet: str, env: dict[str, str], output: str) -> str:
    result = subprocess.run(  # noqa: S603 - fixed shell running repository-owned deploy code
        ["bash", "-eu", "-c", f'{snippet}\nprintf "%s" "{output}"'],
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout


def _effective_max_instances(values: dict[str, str], deploy_env: str) -> int:
    """Run backend-deploy.sh's own dev capacity block, so its overrides are counted."""
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    block = script.split("# BEGIN DEV HUB CAPACITY DEFAULTS\n", 1)[1].split(
        "# END DEV HUB CAPACITY DEFAULTS", 1
    )[0]
    env = {"_DEPLOY_ENV": deploy_env, **{key: values[key] for key in CAPACITY_KEYS}}
    return int(_run_bash(block, env, "${_CLOUD_RUN_MAX_INSTANCES}"))


def _hub_worker_count(deploy_env: str) -> int:
    """Run backend-deploy.sh's own worker selection, which becomes WEB_CONCURRENCY."""
    script = BACKEND_DEPLOY.read_text(encoding="utf-8")
    marker = 'env_vars+=("WEB_CONCURRENCY=${worker_count}")'
    start = script.index('worker_count="')
    snippet = script[start : script.index(marker, start)]
    return int(_run_bash(snippet, {"_DEPLOY_ENV": deploy_env}, "${worker_count}"))


def _dedicated_per_worker() -> int:
    declared = LIMITS["dedicated_connections_per_worker"]
    return sum(entry["connections"] for entry in declared.values())


def _hub_fleet(values: dict[str, str], deploy_env: str) -> Fleet:
    per_worker = sum(int(values[key]) for key in POOL_KEYS) + _dedicated_per_worker()
    return Fleet(
        name="hub",
        max_instances=_effective_max_instances(values, deploy_env),
        workers=_hub_worker_count(deploy_env),
        per_worker=per_worker,
    )


def _single_int(pattern: str, text: str, relative: str) -> int:
    matches = re.findall(pattern, text)
    assert len(matches) == 1, f"{relative}: expected one match for {pattern!r}, found {matches}"
    return int(matches[0])


def _companion_fleet(relative: str) -> Fleet:
    """A separately deployed service on the same database, e.g. the drive worker."""
    text = _read(relative)
    pools = sum(
        _single_int(rf"\b{key}=(\d+)", text, relative)
        for key in ("DB_POOL_MAX_SIZE", "DB_SQLALCHEMY_POOL_SIZE", "DB_SQLALCHEMY_MAX_OVERFLOW")
    )
    return Fleet(
        name=relative,
        max_instances=_single_int(r"--max-instances=(\d+)", text, relative),
        workers=_single_int(r",-w,(\d+),", text, relative),
        per_worker=pools,
    )


def _migration_job_connections() -> int:
    """The release migration job's own pool (db/migrate.py), open during a rollout."""
    text = (BACKEND_ROOT / "db" / "migrate.py").read_text(encoding="utf-8")
    calls = re.findall(r"asyncpg\.create_pool\((.*?)\)", text, flags=re.DOTALL)
    assert len(calls) == 1, f"db/migrate.py: expected one create_pool call, found {len(calls)}"
    return _single_int(r"max_size=(\d+)", calls[0], "db/migrate.py")


def _worst_case(lane: dict, values: dict[str, str]) -> tuple[int, list[str]]:
    fleets = [_hub_fleet(values, lane["deploy_env"])]
    fleets += [_companion_fleet(relative) for relative in lane["companion_services"]]
    migration = _migration_job_connections()
    external = int(lane["external_reserve"]["connections"])
    reserved = LIMITS["superuser_reserved_connections"]["connections"]
    total = sum(fleet.rollout_total for fleet in fleets) + migration + external + reserved
    lines = [fleet.describe() for fleet in fleets]
    lines += [
        f"release migration job: {migration}",
        f"external reserve: {external}",
        f"superuser reserved: {reserved}",
    ]
    return total, lines


def _ceiling(lane: dict) -> int:
    return int(lane["max_connections"] * LIMITS["ceiling_fraction"])


LANE_PATHS = [
    pytest.param(name, deploy_path, id=f"{name}:{deploy_path['path']}")
    for name, lane in LIMITS["lanes"].items()
    for deploy_path in lane["deploy_paths"]
]


@pytest.mark.parametrize(("lane_name", "deploy_path"), LANE_PATHS)
def test_rollout_worst_case_fits_the_lane_connection_limit(lane_name, deploy_path) -> None:
    lane = LIMITS["lanes"][lane_name]
    total, lines = _worst_case(lane, _deploy_path_values(deploy_path))
    ceiling = _ceiling(lane)
    if total <= ceiling:
        return
    accepted = deploy_path.get("accepted_worst_case")
    breakdown = "\n  ".join(lines)
    headline = (
        f"{lane_name} via {deploy_path['path']}: worst case {total} connections exceeds "
        f"{ceiling} ({LIMITS['ceiling_fraction']:.0%} of max_connections="
        f"{lane['max_connections']}).\n  {breakdown}\n"
    )
    assert accepted is not None, (
        f"{headline}No accepted_worst_case is recorded for this deploy path. Lower max instances, "
        "workers or pool sizes, or record the overage as a pending owner decision in the "
        "limits table. Never raise max_connections as a side effect: it restarts the instance."
    )
    assert total <= accepted["connections"], (
        f"{headline}The accepted worst case is {accepted['connections']} "
        f"({accepted['decision']}, recorded {accepted['recorded']}). A path awaiting that "
        "decision may not get worse."
    )


@pytest.mark.parametrize(("lane_name", "deploy_path"), LANE_PATHS)
def test_accepted_worst_case_is_a_tight_pending_decision(lane_name, deploy_path) -> None:
    """An acceptance exists only while the path is over its ceiling, at its exact number.

    A recorded number above the computed worst case would let the path regrow
    unnoticed, and an acceptance on a path that already fits is stale.
    """
    lane = LIMITS["lanes"][lane_name]
    accepted = deploy_path.get("accepted_worst_case")
    if accepted is None:
        return
    worst, _ = _worst_case(lane, _deploy_path_values(deploy_path))
    where = f"{lane_name} via {deploy_path['path']}"
    assert worst > _ceiling(lane), (
        f"{where} now fits its ceiling ({worst} <= {_ceiling(lane)}); remove its "
        "accepted_worst_case."
    )
    assert accepted["connections"] == worst, (
        f"{where}: accepted_worst_case is {accepted['connections']} but the computed "
        f"worst case is {worst}. Record {worst}, so the ratchet holds at the current value."
    )
    assert accepted["decision"].startswith("pending founder:"), accepted["decision"]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", accepted["recorded"]), accepted["recorded"]


@pytest.mark.parametrize(("lane_name", "deploy_path"), LANE_PATHS)
def test_request_pool_keeps_its_floor(lane_name, deploy_path) -> None:
    pool = int(_deploy_path_values(deploy_path)["_DB_POOL_MAX_SIZE"])
    listeners = len(LISTENER_MODULES)
    free = pool - listeners
    assert free >= MIN_FREE_REQUEST_CONNECTIONS and pool >= listeners + 1, (
        f"{lane_name} via {deploy_path['path']}: _DB_POOL_MAX_SIZE={pool} leaves {free} request"
        f" connections per worker after its {listeners} LISTEN connections"
        f" ({', '.join(LISTENER_MODULES)}). The pool must be at least listeners + 1."
    )


def test_declared_connection_holders_exist() -> None:
    """A stale table entry would silently change the arithmetic, so each must exist."""
    declared = [*LISTENER_MODULES, *LIMITS["dedicated_connections_per_worker"]]
    missing = sorted(module for module in declared if not (BACKEND_ROOT / module).is_file())
    assert not missing, (
        f"The limits table declares connection holders that no longer exist: {missing}. "
        "Remove or rename them in consent-protocol/config/database_connection_limits.json."
    )


def test_every_listener_is_declared() -> None:
    """A new LISTEN holder takes a request connection away from every worker."""
    found = {
        path.relative_to(BACKEND_ROOT).as_posix()
        for top in ("api", "db", "hushh_mcp", "mcp_modules")
        for path in (BACKEND_ROOT / top).rglob("*.py")
        if "add_listener(" in path.read_text(encoding="utf-8")
    }
    undeclared = sorted(found - set(LISTENER_MODULES))
    assert not undeclared, (
        f"These modules hold LISTEN connections the request floor does not count: {undeclared}."
        " Add each to listener_modules in consent-protocol/config/database_connection_limits.json."
    )


@pytest.mark.parametrize("lane_name", sorted(LIMITS["lanes"]))
def test_limits_table_names_the_lane_database_and_its_source(lane_name) -> None:
    lane = LIMITS["lanes"][lane_name]
    assert lane["max_connections"] > 0
    assert lane["max_connections_source"].strip()
    assert lane["external_reserve"]["connections"] >= 0
    assert lane["external_reserve"]["source"].strip()
    workflow = next(p["path"] for p in lane["deploy_paths"] if p["path"].startswith(".github/"))
    assert lane["cloud_sql_instance"] in _read(workflow), (
        f"{workflow} no longer deploys against {lane['cloud_sql_instance']}; the limit recorded "
        "for that instance no longer describes this lane."
    )


def test_container_takes_its_worker_count_from_the_deploy() -> None:
    """The worker count above only holds if gunicorn honours WEB_CONCURRENCY."""
    dockerfile = (BACKEND_ROOT / "Dockerfile").read_text(encoding="utf-8")
    command = next(line for line in dockerfile.splitlines() if line.startswith("CMD "))
    assert "-w ${WEB_CONCURRENCY:-" in command


def test_every_connection_source_is_counted() -> None:
    """A new pool or dedicated connection must be declared before it can ship.

    The arithmetic only covers the sources the limits table names. An undeclared
    ``asyncpg.connect`` or ``dedicated_connection`` user would add connections per
    worker that no lane's budget includes.
    """
    declared = (
        set(LIMITS["runtime_pool_modules"])
        | set(LIMITS["operator_tool_modules"])
        | set(LIMITS["dedicated_connections_per_worker"])
    )
    found = set()
    for top in ("api", "db", "hushh_mcp", "mcp_modules"):
        for path in (BACKEND_ROOT / top).rglob("*.py"):
            if _CONNECTION_OPENER.search(path.read_text(encoding="utf-8")):
                found.add(path.relative_to(BACKEND_ROOT).as_posix())
    for entry in ("server.py", "server_drive_worker.py", "pod_server.py"):
        if _CONNECTION_OPENER.search((BACKEND_ROOT / entry).read_text(encoding="utf-8")):
            found.add(entry)
    undeclared = sorted(found - declared)
    assert not undeclared, (
        f"These modules open database connections the ceiling does not count: {undeclared}. "
        "Add each to consent-protocol/config/database_connection_limits.json."
    )
