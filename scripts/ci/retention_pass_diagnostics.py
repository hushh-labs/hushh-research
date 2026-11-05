"""Bounded pass-stage tracking and content-free maintenance diagnostics."""

from __future__ import annotations

from collections.abc import Callable
from contextvars import ContextVar
from pathlib import Path
import os
import subprocess
import sys
from typing import Any

DIAGNOSTIC_STAGES = frozenset(
    {
        "startup",
        "arguments",
        "publication_guard",
        "checkpoint_restore",
        "release_context",
        "due_check",
        "release_preflight",
        "pending_mutation_reconcile",
        "capacity_bridge",
        "revision_cleanup",
        "deferred_clock_validation",
        "completion_checkpoint",
        "summary",
    }
)
CURRENT_STAGE: ContextVar[str] = ContextVar(
    "retention_diagnostic_stage", default="startup"
)


def run_stage(
    stage: str, operation: Callable[..., Any], *args: Any, **kwargs: Any
) -> Any:
    CURRENT_STAGE.set(stage)
    return operation(*args, **kwargs)


def safe_failure_diagnostic(stage: object, error: BaseException, retention: Any) -> str:
    """Expose only fixed stage/type labels and validated numeric status fields."""
    stage_name = (
        stage if isinstance(stage, str) and stage in DIAGNOSTIC_STAGES else "unknown"
    )
    if isinstance(error, retention.BudgetExpired):
        kind = "budget_expired"
    elif isinstance(error, retention.UnsafeState):
        kind = "safety_refusal"
    elif isinstance(error, subprocess.CalledProcessError):
        kind = "child_process_failure"
    elif isinstance(error, subprocess.TimeoutExpired):
        kind = "child_process_timeout"
    elif isinstance(error, ValueError):
        kind = "invalid_data"
    elif isinstance(error, KeyError):
        kind = "missing_state_key"
    elif isinstance(error, OSError):
        kind = "os_error"
    else:
        kind = "other_failure"

    fields = [f"stage={stage_name}", f"kind={kind}"]
    if isinstance(error, subprocess.CalledProcessError):
        code = error.returncode
        if type(code) is int and -255 <= code <= 255:
            fields.append(f"exit_code={code}")
    elif isinstance(error, OSError):
        code = error.errno
        if type(code) is int and 0 <= code <= 4095:
            fields.append(f"os_code={code}")

    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if type(status) is not int:
        status = getattr(error, "code", None)
    if type(status) is int and 100 <= status <= 599:
        fields.append(f"http_status={status}")
    return "Hosted maintenance stopped: " + " ".join(fields)


def load_release_context(context: Any, args: Any, repository: str, owner: Any) -> None:
    CURRENT_STAGE.set("release_context")
    args.operational_anchor = context.load_operational(owner, args)
    args.worker_anchor = context.worker(owner, args, repository)


def should_run_preflight(
    args: Any, repository: str, maintenance_due: Callable[..., bool], output: str | None
) -> bool:
    CURRENT_STAGE.set("due_check")
    if (
        (args.verify_source_only or args.apply)
        and not args.force_inspection
        and not maintenance_due(
            repository,
            args.state_dir,
            environment=args.environment,
            release_run_id=int(args.release_run_id) if args.release_run_id else None,
            restore=not args.apply,
        )
    ):
        if output:
            with Path(output).open("a") as stream:
                stream.write("cleanup_ready=false\n")
        return False
    return True


def reconcile_pending(operation: Callable[..., Any], repository: str, args: Any) -> Any:
    return run_stage(
        "pending_mutation_reconcile",
        operation,
        repository,
        args.state_dir,
        args.environment,
    )


def checkpoint_guard(operation: Callable[..., Any], repository: str, args: Any) -> Any:
    try:
        return run_stage("publication_guard", operation, repository, args.environment)
    except Exception as error:
        # Keep the transcript used by historical custody proofs unchanged.
        # Fixed summary codes expose the cause without provider/error payloads.
        codes = {
            "Maintenance exited without publishing its checkpoint; operator reconciliation required": "checkpoint_unpublished",
            "Maintenance publication proof is unavailable or invalid": "publication_unverified",
            "production source ancestry is not bounded and exact": "source_ancestry_unproved",
            "capacity clock source tuple has no unique approved profile for its workflow family": "source_profile_unapproved",
        }
        code = codes.get(str(error))
        summary = os.getenv("GITHUB_STEP_SUMMARY")
        if code and summary:
            try:
                with Path(summary).open("a") as stream:
                    stream.write(f"\nMaintenance stopped before mutation: `{code}`.\n")
            except OSError:
                print("Maintenance diagnostic summary unavailable.", file=sys.stderr)
        raise


def restore_checkpoint(
    operation: Callable[..., Any], repository: str, args: Any
) -> Any:
    return run_stage(
        "checkpoint_restore",
        operation,
        repository,
        args.state_dir,
        environment=args.environment,
    )


def find_release(operation: Callable[..., Any], args: Any, repository: str) -> Any:
    return run_stage("release_preflight", operation, args, repository)
