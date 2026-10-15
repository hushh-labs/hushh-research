"""Which engine code answers the dashboard, compared with what UAT serves right now.

Deployed: one read-only ``gcloud run services describe`` of the backend service
(and ``revisions describe`` when traffic is pinned to an older revision), giving
the serving revision and its ``deploy-sha`` label. Engine: the git checkout that
``hushh_mcp`` was actually imported from in this process, its HEAD and whether
its engine paths carry local changes. ``match`` is true only when the engine is
exactly the deployed commit with no local changes.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from hushh_eval.drive_packets.sources import BACKEND_SERVICE, PROJECT, REGION, _gcloud

ENGINE_PATHS = ("consent-protocol/hushh_mcp", "consent-protocol/api", "consent-protocol/db")
REFRESH_SECONDS = 300.0


def _git(*args: str) -> str:
    result = subprocess.run(  # noqa: S603 - fixed read-only git commands, no shell
        ["git", *args], capture_output=True, text=True, timeout=30, check=False
    )
    if result.returncode:
        raise RuntimeError("git_read_failed")
    return result.stdout.strip()


def describe_serving(command: Callable[..., str] = _gcloud) -> dict:
    """The revision serving 100% of the backend's traffic and its deploy-sha label."""
    service = json.loads(
        command(
            "run",
            "services",
            "describe",
            BACKEND_SERVICE,
            "--project",
            PROJECT,
            "--region",
            REGION,
            "--format=json",
        )
    )
    status = service.get("status") or {}
    template = (service.get("spec") or {}).get("template") or {}
    template_name = (template.get("metadata") or {}).get("name")
    serving = [item for item in status.get("traffic") or [] if (item.get("percent") or 0) > 0]
    if len(serving) != 1:
        return {"revision": None, "deploy_sha": None, "error": "traffic_split"}
    revision = serving[0].get("revisionName")
    if not revision and serving[0].get("latestRevision"):
        revision = status.get("latestReadyRevisionName")
    if not revision:
        return {"revision": None, "deploy_sha": None, "error": "serving_revision_unknown"}
    if revision == template_name:
        labels = (template.get("metadata") or {}).get("labels") or {}
    else:
        described = json.loads(
            command(
                "run",
                "revisions",
                "describe",
                revision,
                "--project",
                PROJECT,
                "--region",
                REGION,
                "--format=json",
            )
        )
        labels = (described.get("metadata") or {}).get("labels") or {}
    sha = labels.get("deploy-sha")
    return {
        "revision": revision,
        "deploy_sha": sha if isinstance(sha, str) and sha else None,
        "error": None if sha else "deploy_sha_label_missing",
    }


def engine_checkout(module_file: str | None = None) -> Path:
    """The git checkout whose consent-protocol/hushh_mcp this process imported."""
    if module_file is None:
        import hushh_mcp

        module_file = hushh_mcp.__file__
    return Path(module_file).resolve().parents[2]


def local_engine(root: Path | None = None, git: Callable[..., str] = _git) -> dict:
    root = root or engine_checkout()
    try:
        sha = git("-C", str(root), "rev-parse", "HEAD")
        changes = git("-C", str(root), "status", "--porcelain", "--", *ENGINE_PATHS)
    except (RuntimeError, OSError, subprocess.SubprocessError):
        return {"engine_root": str(root), "engine_sha": None, "engine_clean": False}
    return {"engine_root": str(root), "engine_sha": sha or None, "engine_clean": not changes}


def same_commit(first: str | None, second: str | None) -> bool:
    if not first or not second:
        return False
    first, second = first.strip().lower(), second.strip().lower()
    shortest = min(len(first), len(second))
    return shortest >= 7 and first[:shortest] == second[:shortest]


class EngineInfo:
    """/api/engine: deployed revision and SHA beside the engine actually running here."""

    def __init__(
        self,
        *,
        describe: Callable[[], dict] = describe_serving,
        local: Callable[[], dict] = local_engine,
        refresh_seconds: float = REFRESH_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._describe = describe
        self._local = local
        self._refresh = refresh_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._value: dict | None = None
        self._at = 0.0

    def snapshot(self, *, refresh: bool = False) -> dict:
        with self._lock:
            if self._value is not None and not refresh and self._clock() - self._at < self._refresh:
                return dict(self._value)
        try:
            deployed = self._describe()
        except Exception:  # noqa: BLE001 - shown as unknown, never as a match
            deployed = {"revision": None, "deploy_sha": None, "error": "describe_failed"}
        engine = self._local()
        match = bool(
            engine.get("engine_clean")
            and same_commit(deployed.get("deploy_sha"), engine.get("engine_sha"))
        )
        if match:
            reason = ""
        elif not deployed.get("deploy_sha"):
            reason = f"deployed SHA unknown ({deployed.get('error') or 'no label'})"
        elif not engine.get("engine_sha"):
            reason = "engine checkout SHA unknown"
        elif not engine.get("engine_clean"):
            reason = "engine checkout has local changes"
        else:
            reason = "engine checkout is a different commit than UAT serves"
        value = {
            "deployed_revision": deployed.get("revision"),
            "deployed_sha": deployed.get("deploy_sha"),
            "engine_sha": engine.get("engine_sha"),
            "match": match,
            "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "engine_root": engine.get("engine_root"),
            "engine_clean": engine.get("engine_clean"),
            "reason": reason,
        }
        with self._lock:
            self._value, self._at = value, self._clock()
        return dict(value)
