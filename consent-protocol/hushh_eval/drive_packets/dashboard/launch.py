"""``python -m hushh_eval.drive_packets dashboard``: start the local dashboard.

1. The owner comes from the eval's founder configuration only (``owner.py``).
2. UAT's serving backend revision and its deploy-sha label are read with one
   describe call. The request engine must be exactly that commit: the dashboard
   uses an engine checkout at that SHA (``--engine-root``, or a git worktree it
   adds on the SSD, ``dashboard-engines/dash-engine-<sha12>``) and re-runs itself with
   that checkout's ``hushh_mcp`` first on the path and this checkout's
   ``hushh_eval`` overlaid on top. ``--no-engine-checkout`` runs in place; the
   page then shows the mismatch in red.
3. UAT is opened read-only (DashboardUat) and the server binds 127.0.0.1.
``--check`` runs the same startup, prints counts only, and exits.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

from hushh_eval.drive_packets.dashboard.engine_info import (
    EngineInfo,
    _git,
    describe_serving,
    engine_checkout,
    local_engine,
    same_commit,
)
from hushh_eval.drive_packets.dashboard.owner import (
    DEFAULT_STATE_DIR,
    OwnerConfigError,
    resolve_owner,
)

ENGINE_ENV = "HUSHH_DASHBOARD_ENGINE_ROOT"
DEFAULT_DB_PORT = 6657
ENGINE_PARENT = Path("/Volumes/AnkitSSD/DevCache/dashboard-engines")


class LaunchError(RuntimeError):
    """Startup refused; the message is a fixed code."""


def dashboard_checkout() -> Path:
    import hushh_eval

    return Path(hushh_eval.__file__).resolve().parents[2]


def _emit(payload: dict) -> None:
    print(json.dumps(payload, sort_keys=True, default=str), flush=True)


def _commit_known(root: Path, sha: str, git=_git) -> bool:
    try:
        return git("-C", str(root), "cat-file", "-t", sha) == "commit"
    except RuntimeError:
        return False


def ensure_engine_checkout(
    deployed_sha: str, *, dashboard_root: Path, parent: Path = ENGINE_PARENT, git=_git
) -> Path:
    """A checkout of exactly the deployed commit: this one, or dash-engine-<sha12> on the SSD."""
    here = local_engine(dashboard_root, git=git)
    if here["engine_clean"] and same_commit(here["engine_sha"], deployed_sha):
        return dashboard_root
    if not parent.parent.is_dir():
        raise LaunchError("engine_parent_missing")
    target = parent / f"dash-engine-{deployed_sha[:12]}"
    if target.exists():
        found = local_engine(target, git=git)
        if not same_commit(found["engine_sha"], deployed_sha):
            raise LaunchError("engine_checkout_wrong_commit")
        return target
    if not _commit_known(dashboard_root, deployed_sha, git):
        git("-C", str(dashboard_root), "fetch", "origin", "--prune")
    if not _commit_known(dashboard_root, deployed_sha, git):
        raise LaunchError("deployed_commit_not_found")
    parent.mkdir(mode=0o755, exist_ok=True)
    git("-C", str(dashboard_root), "worktree", "add", str(target), deployed_sha)
    print(f"Added engine checkout {target} at {deployed_sha[:12]}", file=sys.stderr, flush=True)
    return target


def overlay_directory(state_dir: Path, dashboard_root: Path) -> Path:
    """A private directory holding only a link to this checkout's hushh_eval."""
    from hushh_eval.drive_packets.privacy import PrivateWorkdir

    overlay = PrivateWorkdir(state_dir).directory("engine-overlay")
    link = overlay / "hushh_eval"
    target = dashboard_root / "consent-protocol" / "hushh_eval"
    if link.is_symlink() and Path(os.readlink(link)) != target:
        link.unlink()
    if not link.exists():
        link.symlink_to(target, target_is_directory=True)
    return overlay


def reexec_with_engine(engine_root: Path, *, state_dir: Path, argv: list[str]) -> None:
    """Replace this process: the engine checkout's hushh_mcp, this checkout's hushh_eval."""
    overlay = overlay_directory(state_dir, dashboard_checkout())
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(overlay), str(engine_root / "consent-protocol")]
    )
    environment[ENGINE_ENV] = str(engine_root)
    os.chdir(overlay)
    os.execve(  # noqa: S606 - the same interpreter and module, new import path only
        sys.executable, [sys.executable, "-m", "hushh_eval.drive_packets", *argv], environment
    )


def proxy_listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def build_context(owner, *, db_port: int, engine: EngineInfo, state_dir: Path):
    from hushh_eval.drive_packets.dashboard.eval_view import EvalView
    from hushh_eval.drive_packets.dashboard.labels import EvalVerdicts, LabelStore
    from hushh_eval.drive_packets.dashboard.queries import DashboardData, OwnerScopedReader
    from hushh_eval.drive_packets.dashboard.real_requests import RealRequests
    from hushh_eval.drive_packets.dashboard.server import DashboardContext
    from hushh_eval.drive_packets.dashboard.uat import DashboardUat

    labels = LabelStore(state_dir)
    context = DashboardContext(
        owner=owner,
        labels=labels,
        evals=EvalView(owner.eval_workdir),
        engine=engine,
        db_port=db_port,
    )
    if not proxy_listening(db_port):
        raise LaunchError("cloud_sql_proxy_not_listening")
    uat = DashboardUat(owner_user_id=owner.owner_id, db_port=db_port)
    reader = OwnerScopedReader(uat.engine, owner.owner_id)
    context.uat, context.reader = uat, reader
    context.data = DashboardData(
        reader,
        owner_label=owner.display_name,
        labels=labels,
        verdicts=EvalVerdicts(owner.eval_workdir),
    )
    context.requests = RealRequests(reader, labels=labels)
    return context


def check_summary(context) -> dict:
    """Counts only: what the live smoke and the operator need to see."""
    from hushh_eval.drive_packets.dashboard.accuracy import packet_accuracy

    owner = context.data.owner_summary()
    health = context.data.health()
    packets = context.data.packets()
    detail = None
    if packets:
        chosen = next((item for item in packets if item["status"] == "ready"), packets[0])
        first = context.data.packet_detail(chosen["packet_id"])
        detail = {
            "status": first["status"],
            "members": len(first["members"]),
            "checks": len(first["checks"]),
            "checks_ok": sum(item["ok"] is True for item in first["checks"]),
            "eval_verdicts": len(first["eval_verdicts"]),
        }
    requests = context.requests.list()
    evals = context.evals.view()
    served_ai = {item["packet_id"]: item.get("ai_verdict") for item in packets}
    accuracy = packet_accuracy(
        context.evals.ready_packets(), context.labels.packet_labels(), served_ai
    )
    return {
        "owner": {key: owner[key] for key in ("files_found", "packets", "ready", "listed")},
        "health": {
            key: health[key]
            for key in (
                "files_found",
                "extracted",
                "facts_complete",
                "facts_waiting",
                "extracted_last_hour",
                "facts_last_hour",
                "packets_by_status",
            )
        },
        "health_failed_reasons": len(health["failed_by_reason"]),
        "packets": len(packets),
        "packets_with_ai_verdict": sum(item.get("ai_verdict") is not None for item in packets),
        "first_packet_detail": detail,
        "real_requests": len(requests),
        "real_requests_paid": sum(bool(item["paid"]) for item in requests),
        "eval_batches": len(evals["batches"]),
        "eval_human_queue": evals["human_queue"],
        "accuracy_packets_ai": {
            key: accuracy["ai"][key] for key in ("correct", "wrong", "undecided", "n")
        },
        "accuracy_packets_human_n": accuracy["human"]["n"],
        "bars": accuracy["bars"],
    }


def run(args) -> int:
    try:
        owner = resolve_owner()
    except OwnerConfigError as error:
        _emit({"command": "dashboard", "error": str(error)})
        return 2
    state_dir = Path(DEFAULT_STATE_DIR)
    engine = EngineInfo()
    pinned = os.environ.get(ENGINE_ENV)
    if pinned:
        if engine_checkout().resolve() != Path(pinned).resolve():
            _emit({"command": "dashboard", "error": "engine_overlay_failed"})
            return 2
    elif not args.no_engine_checkout:
        try:
            deployed = describe_serving()
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
            deployed = {"deploy_sha": None, "error": "describe_failed"}
        sha = deployed.get("deploy_sha")
        if not sha:
            # Without the deployed SHA no checkout can be proven equal to it: start in
            # place and let the page show the mismatch in red.
            _emit(
                {"command": "dashboard", "warning": deployed.get("error") or "deployed_sha_unknown"}
            )
        else:
            try:
                root = (
                    Path(args.engine_root).resolve()
                    if args.engine_root
                    else ensure_engine_checkout(sha, dashboard_root=dashboard_checkout())
                )
                if not (root / "consent-protocol" / "hushh_mcp").is_dir():
                    raise LaunchError("engine_root_not_a_checkout")
            except (LaunchError, RuntimeError, OSError, subprocess.SubprocessError) as error:
                _emit({"command": "dashboard", "error": str(error)})
                return 2
            if root != engine_checkout().resolve():
                reexec_with_engine(root, state_dir=state_dir, argv=sys.argv[1:])
    snapshot = engine.snapshot()
    _emit(
        {
            "command": "dashboard",
            "testing": f"deployed UAT {snapshot['deployed_revision']} @ "
            f"{(snapshot['deployed_sha'] or 'unknown')[:10]}",
            "engine_sha": (snapshot["engine_sha"] or "unknown")[:10],
            "match": snapshot["match"],
            "reason": snapshot["reason"],
        }
    )
    try:
        context = build_context(owner, db_port=args.db_port, engine=engine, state_dir=state_dir)
    except (LaunchError, RuntimeError) as error:
        payload = {"command": "dashboard", "error": str(error).split(":")[0][:120]}
        if str(error) == "cloud_sql_proxy_not_listening":
            payload["start_read_only_proxy"] = (
                f"cloud-sql-proxy --address 127.0.0.1 --port {args.db_port} "
                "hushh-pda-uat:us-central1:hushh-uat-pg"
            )
        _emit(payload)
        return 2
    try:
        if args.check:
            _emit({"command": "dashboard", "check": check_summary(context)})
            return 0
        import threading

        from hushh_eval.drive_packets.dashboard.server import create_app, serve

        threading.Thread(target=context.data.warm, name="dashboard-warm", daemon=True).start()
        _emit({"command": "dashboard", "url": f"http://127.0.0.1:{args.port}/"})
        serve(create_app(context, port=args.port), port=args.port)
        return 0
    finally:
        context.uat.close()
