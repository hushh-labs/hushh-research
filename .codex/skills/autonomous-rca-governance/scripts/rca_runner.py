#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
VERIFY_PARITY = REPO_ROOT / "scripts" / "ops" / "verify-env-secrets-parity.py"
VERIFY_UAT_RELEASE = REPO_ROOT / "scripts" / "ops" / "verify_uat_release.py"
VERIFY_RUNTIME_CONTRACT = REPO_ROOT / "scripts" / "ci" / "verify-runtime-config-contract.py"
VERIFY_RELEASE_CONTRACT = REPO_ROOT / "scripts" / "ops" / "verify_release_migration_contract.py"
VERIFY_RUNTIME_DB_CONTRACT = REPO_ROOT / "scripts" / "ops" / "verify_runtime_db_contract.sh"
REPO_SCAN = REPO_ROOT / ".codex" / "skills" / "repo-context" / "scripts" / "repo_scan.py"

DEFAULT_UAT_PROJECT = "hushh-pda-uat"
DEFAULT_UAT_REGION = "us-central1"
DEFAULT_UAT_BACKEND_SERVICE = "consent-protocol"
DEFAULT_UAT_FRONTEND_SERVICE = "hushh-webapp"
DEFAULT_UAT_CONTRACT = REPO_ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"
#: Gitignored (.gitignore:178). Durable across runs on purpose.
DEFAULT_SCRATCH = REPO_ROOT / "tmp" / "rca"
#: Per-check wall clock. Generous, because these legitimately talk to Cloud Run
#: and live URLs, but finite, because an RCA runner that hangs is one nobody can
#: use in a loop.
#:
#: 900, not 600. Measured 2026-08-29: `verify-runtime-config-contract.py` took
#: 486s and exited 0 -- it reads all ~4,950 tracked files against 23 regex
#: patterns. That reading was taken under a load average of ~43, so it is an
#: upper bound on a busy machine rather than a clean profile, and the honest
#: response to a number measured that loosely is headroom. A timeout that trips
#: spuriously manufactures exactly the noise this file exists to remove, so the
#: bound sits well clear of the slowest observed run rather than close to it.
DEFAULT_CHECK_TIMEOUT_SECONDS = 900


#: A check that could not run at all. NOT a domain classification: it says
#: nothing about UAT, the database, or the runtime, only that this runner failed
#: to ask the question.
#:
#: WHY THIS EXISTS
#: `_run` used to return one integer, and every call site read `returncode != 0`
#: as a substantive finding. So on 2026-08-29 `verify_runtime_db_contract.sh`
#: died at `import asyncpg` -- a dependency missing from the interpreter this
#: runner happens to be launched with -- and the surface reported
#: `db_contract_drift`, "Status: blocked", and "Resolve DB release-contract drift
#: before treating the surface as deployable". The database contract was fine.
#: Anyone acting on that verdict would have gone looking for drift that did not
#: exist while the actual defect, a missing package, stayed invisible.
#:
#: The deploy gates already model this correctly:
#: `.github/workflows/deploy-uat.yml` separates `semantic_verifier_failed`
#: ("the verifier produced no report") from `runtime_behavior_failed` ("the
#: verifier ran and reported failures"), and tests `db_outcome == "failure"`
#: rather than `!= "success"` so a SKIPPED step never becomes drift. This runner
#: is what an agent actually invokes, and it had none of that. The two models
#: diverged and the local one is the one that lies.
CHECK_UNEVALUABLE = "check_unevaluable"

OUTCOME_SUCCESS = "success"
OUTCOME_FAILURE = "failure"
OUTCOME_UNEVALUABLE = "unevaluable"

#: Interpreter-level failures. An import error means the process never reached
#: its own logic, so its exit code carries no information about the thing it was
#: meant to inspect.
_UNEVALUABLE_STDERR_MARKERS = (
    "ModuleNotFoundError",
    "ImportError:",
    "No module named",
    "command not found",
)


def _project_python() -> tuple[list[str], str]:
    """The interpreter that can actually run this repo's verifier scripts.

    Two of them (`verify_uat_release.py`, `db_migration_release_guard.py`) import
    `asyncpg` and `python-dotenv`, which live in the consent-protocol
    environment and not in whatever `python3` resolves to on an operator's PATH.
    Measured 2026-08-29: under system python3 both exit non-zero at import;
    under `consent-protocol/.venv/bin/python` both run. The venv also runs
    everything the system interpreter runs, so preferring it is strictly better.

    Returns the command prefix and a short name for the report, so a run made
    with the fallback interpreter can be told apart from one made with the right
    one -- which is the difference between a trustworthy verdict and a guess.
    """
    venv = REPO_ROOT / "consent-protocol" / ".venv" / "bin" / "python"
    if venv.exists():
        return [str(venv)], "consent-protocol/.venv"
    if shutil.which("uv"):
        return ["uv", "run", "--project", str(REPO_ROOT / "consent-protocol"), "python"], "uv"
    # Deliberately last, and deliberately named in the report. Falling back here
    # silently is how a missing dependency became a database-drift verdict.
    return [sys.executable], "fallback:sys.executable"


def _classify_outcome(returncode: int, stderr: str) -> str:
    """success / failure / unevaluable -- three states, because there are three.

    `unevaluable` is not a softer `failure`. A failing check is evidence about
    the system; an unevaluable one is evidence about this runner, and routing it
    into a domain classification sends an operator to fix the wrong thing.
    """
    if returncode == 0:
        return OUTCOME_SUCCESS
    # 124 is the conventional "timed out"; 127 is the shell's "command not
    # found"; 126 is "found but not executable". None of the three is a finding
    # about the surface.
    if returncode in (124, 126, 127):
        return OUTCOME_UNEVALUABLE
    # KILLED BY A SIGNAL. Python reports a signalled direct child as a negative
    # code; a shell in between reports 128+n. Either way the process did not
    # choose to exit, so its code says nothing about what it was inspecting.
    #
    # Measured 2026-08-29 on the `ci` surface: `./bin/hushh ci` returned 143
    # (SIGTERM) because a watchdog killed `verify-runtime-config-contract.py`
    # mid-run, and the runner reported `core_ci_failed`. CI had not failed. CI
    # had been killed, which is a different sentence and a different fix.
    if returncode < 0 or returncode >= 128:
        return OUTCOME_UNEVALUABLE
    if any(marker in stderr for marker in _UNEVALUABLE_STDERR_MARKERS):
        return OUTCOME_UNEVALUABLE
    return OUTCOME_FAILURE


def _run(
    cmd: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path = REPO_ROOT,
    timeout: int = DEFAULT_CHECK_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        # A check that ran out of time did not look, so it has nothing to say
        # about the surface. Bounding this matters more after the interpreter
        # fix than before it: these checks used to die instantly at import, and
        # "fast" was a symptom of that, not a property. Now that they really run,
        # one of them reaching a live database or a live URL can hang, and an
        # RCA runner that never returns is worse than one that returns a wrong
        # answer -- at least a wrong answer can be argued with.
        return {
            "cmd": cmd,
            "returncode": 124,
            "stdout": (exc.stdout or b"").decode("utf-8", "replace")[-4000:]
            if isinstance(exc.stdout, bytes)
            else str(exc.stdout or "")[-4000:],
            "stderr": f"timed out after {timeout}s",
            "ok": False,
            "outcome": OUTCOME_UNEVALUABLE,
        }
    except (FileNotFoundError, NotADirectoryError, PermissionError) as exc:
        # The binary is not there at all. Reporting this as a domain failure
        # would be the same lie the exit-code path used to tell.
        return {
            "cmd": cmd,
            "returncode": 127,
            "stdout": "",
            "stderr": f"{type(exc).__name__}: {exc}",
            "ok": False,
            "outcome": OUTCOME_UNEVALUABLE,
        }
    stderr = result.stderr[-4000:]
    return {
        "cmd": cmd,
        "returncode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": stderr,
        "ok": result.returncode == 0,
        "outcome": _classify_outcome(result.returncode, stderr),
    }


def _note_unevaluable(
    unevaluable: list[dict[str, str]],
    *,
    check: str,
    result: dict[str, Any],
    would_have_been: str,
) -> None:
    """Record WHICH check could not run, and what it would have been blamed for.

    Naming the classification it displaced is the point. Without it the report
    just goes quiet, and silence is what let a crashed semantic verifier read as
    a clean one.
    """
    stderr = str(result.get("stderr") or "").strip().splitlines()
    unevaluable.append(
        {
            "check": check,
            "would_have_been_classified": would_have_been,
            "returncode": str(result.get("returncode")),
            "reason": stderr[-1][:300] if stderr else "no stderr",
        }
    )


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _gcloud_secret(project: str, secret: str) -> str:
    result = _run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            secret,
            "--project",
            project,
        ]
    )
    if not result["ok"]:
        return ""
    return result["stdout"].strip()


def _service_url(project: str, region: str, service: str) -> str:
    result = _run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            "--project",
            project,
            "--region",
            region,
            "--format=value(status.url)",
        ]
    )
    return result["stdout"].strip() if result["ok"] else ""


def _service_revision(project: str, region: str, service: str) -> str:
    result = _run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            "--project",
            project,
            "--region",
            region,
            "--format=value(status.latestReadyRevisionName)",
        ]
    )
    return result["stdout"].strip() if result["ok"] else ""


def _maybe_load_smoke_overlay(project: str, env: dict[str, str]) -> dict[str, str]:
    loaded: dict[str, str] = {}
    for key in ("REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"):
        if env.get(key):
            continue
        value = _gcloud_secret(project, key)
        if value:
            env[key] = value
            loaded[key] = "secret-manager"
    return loaded


def _append_unique(target: list[str], values: list[str]) -> None:
    for value in values:
        if value and value not in target:
            target.append(value)


def _advisory_from_audit(audit_payload: dict[str, Any] | None) -> list[str]:
    if not isinstance(audit_payload, dict):
        return []
    data = audit_payload.get("data") or {}
    findings = data.get("findings") or {}
    relevant: list[str] = []
    for severity in ("high", "medium"):
        for issue in findings.get(severity, []):
            text = str(issue).lower()
            if "workflow pack" in text or "command" in text or "owner" in text:
                relevant.append("doc_skill_drift")
                break
    return list(dict.fromkeys(relevant))


def _render_text(payload: dict[str, Any]) -> str:
    lines = [
        f"Surface: {payload['surface']}",
        f"Status: {payload['status']}",
        f"Can push branch: {payload['can_push_branch']}",
        f"Blocking classifications: {', '.join(payload['blocking_classifications']) or 'none'}",
        f"Advisory classifications: {', '.join(payload['advisory_classifications']) or 'none'}",
    ]
    interpreter = str((payload.get("context") or {}).get("interpreter") or "").strip()
    if interpreter:
        lines.append(f"Interpreter: {interpreter}")
    unevaluable = payload.get("unevaluable_checks") or []
    if unevaluable:
        # Reported separately and never merged into the blocking column. These
        # are facts about this runner, not about the surface it was asked about.
        lines.append("NOT EVALUATED (nothing was verified about these):")
        for entry in unevaluable:
            lines.append(
                f"- {entry['check']}: {entry['reason']} "
                f"(would have been reported as {entry['would_have_been_classified']})"
            )
    if payload.get("next_actions"):
        lines.append("Next actions:")
        lines.extend(f"- {item}" for item in payload["next_actions"])
    reports = payload.get("reports") or {}
    if reports:
        lines.append("Reports:")
        for name, data in reports.items():
            report_path = str(data.get("report_path") or "").strip()
            code = data.get("returncode")
            # The exit code, on the line an operator actually reads. `--text` is
            # the invocation this skill prescribes, and it used to print the
            # verdict while discarding every number and every line of stderr
            # behind it -- so the misclassification was visible and the
            # ModuleNotFoundError that explained it was not.
            suffix = "" if code in (None, 0) else f"  (exit {code})"
            if report_path:
                lines.append(f"- {name}: {report_path}{suffix}")
            elif suffix:
                lines.append(f"- {name}:{suffix}")
    return "\n".join(lines)


def _build_next_actions(
    blocking: list[str], unevaluable: list[dict[str, str]] | None = None
) -> list[str]:
    actions: list[str] = []
    for entry in unevaluable or []:
        # FIRST, and phrased as what it is. The old report said "Resolve DB
        # release-contract drift" for a missing `asyncpg`; naming the check and
        # the reason is the difference between an operator fixing the right file
        # and an operator hunting a contract violation that does not exist.
        actions.append(
            f"The {entry['check']} check could not run, so nothing was verified about it "
            f"(it would otherwise have been classified {entry['would_have_been_classified']}). "
            f"Reason: {entry['reason']}"
        )
    if "secret_missing" in blocking:
        actions.append("Sync or create canonical Secret Manager values before retrying runtime verification.")
    if "runtime_mount_legacy" in blocking:
        actions.append("Redeploy the changed Cloud Run surface so canonical env names replace legacy mounts.")
    if "runtime_mount_missing" in blocking:
        actions.append("Fix deploy/runtime env injection for the missing canonical keys, then redeploy the affected surface.")
    if "runtime_behavior_failed" in blocking:
        actions.append("Inspect the semantic verification report and fix the live runtime behavior after env parity is green.")
    if "smoke_overlay_dependency_leak" in blocking:
        actions.append("Restore or load the maintainer-only smoke overlay for UAT verification without adding it back to canonical runtime files.")
    if "db_contract_drift" in blocking:
        actions.append("Resolve DB release-contract drift before treating the surface as deployable.")
    if "runtime_contract_drift" in blocking:
        actions.append("Fix the canonical runtime settings contract before relying on CI or deploy verification.")
    if "core_ci_failed" in blocking:
        actions.append("Fix the failing core CI lane and rerun the authoritative checks twice before pushing the branch.")
    return actions


def _clear_stale_reports(*paths: Path) -> None:
    """Remove report files a PREVIOUS run left behind.

    Without this, a durable scratch directory turns "the report file exists"
    into a claim about some earlier invocation rather than this one -- and the
    runner reads that file as evidence. Measured 2026-08-29 on the first live
    re-run after the durability change: a timed-out parity check silently
    inherited a 21-minute-old `status: healthy` and the surface reported
    can_push_branch True.
    """
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # Not fatal: a report that cannot be removed is still detectable as
            # stale downstream, and refusing to run the RCA over it would be a
            # worse trade than proceeding.
            logger_path = str(path)
            print(f"warning: could not clear stale report {logger_path}", file=sys.stderr)


def _verdict(blocking: list[str], unevaluable: list[dict[str, str]]) -> dict[str, Any]:
    """status / can_push_branch, derived once for every surface.

    THREE states, not two. `unevaluable` is deliberately NOT folded into
    `healthy`: a judge that answers green because it could not look is worse than
    no judge, because it is believed. It is equally deliberately not folded into
    `blocked`: that would put a missing dependency in the same column as a real
    contract violation and send an operator to the wrong file, which is exactly
    the failure this whole change is about.

    `can_push_branch` is False for both, because in neither case has anything
    been verified.
    """
    if blocking:
        status = "blocked"
    elif unevaluable:
        status = "unevaluable"
    else:
        status = "healthy"
    return {
        "status": status,
        "can_push_branch": status == "healthy",
        "blocking_classifications": blocking,
        "unevaluable_checks": unevaluable,
    }


def _surface_uat(args: argparse.Namespace, scratch_dir: Path) -> dict[str, Any]:
    project = args.project or DEFAULT_UAT_PROJECT
    region = args.region or DEFAULT_UAT_REGION
    backend_service = args.backend_service or DEFAULT_UAT_BACKEND_SERVICE
    frontend_service = args.frontend_service or DEFAULT_UAT_FRONTEND_SERVICE
    backend_url = args.backend_url or _service_url(project, region, backend_service)
    frontend_url = args.frontend_url or _service_url(project, region, frontend_service)
    parity_report_path = Path(args.parity_report_path or scratch_dir / "uat-runtime-parity.json")
    semantic_report_path = Path(args.semantic_report_path or scratch_dir / "uat-semantic.json")
    db_report_path = Path(args.db_report_path or scratch_dir / "uat-db-contract.json")

    # STALE REPORTS ARE NOT EVIDENCE ABOUT THIS RUN.
    #
    # Making the scratch directory durable (so the next agent can actually open
    # the paths this runner prints) introduced a new way to lie, and it fired on
    # the very first live re-run: the parity check timed out at exit 124, the
    # runner loaded `uat-runtime-parity.json` written 21 minutes earlier by a
    # different invocation, read its `classifications: []` and `status: healthy`,
    # and reported the whole surface healthy with can_push_branch True.
    #
    # A check that did not run had inherited a previous run's verdict. That is
    # the same defect this file exists to remove, reintroduced by the fix for it.
    # Clearing the paths first is what makes "the file exists afterwards" mean
    # "this run wrote it", which is the only reading that is safe.
    _clear_stale_reports(parity_report_path, semantic_report_path, db_report_path)

    python_cmd, python_source = _project_python()

    parity_cmd = [
        *python_cmd,
        str(VERIFY_PARITY),
        "--project",
        project,
        "--region",
        region,
        "--backend-service",
        backend_service,
        "--frontend-service",
        frontend_service,
        "--require-gmail",
        "--require-one-email",
        "--require-voice",
        "--assert-runtime-env-contract",
        "--report-path",
        str(parity_report_path),
    ]
    parity_result = _run(parity_cmd)
    parity_report = _load_json(parity_report_path) or {}

    db_cmd = [
        "bash",
        str(VERIFY_RUNTIME_DB_CONTRACT),
        "--project",
        project,
        "--region",
        region,
        "--service",
        backend_service,
        "--contract-file",
        str(DEFAULT_UAT_CONTRACT),
        # The wrapper defaults RELEASE_ENVIRONMENT to "production"
        # (verify_runtime_db_contract.sh:31), and this surface never said
        # otherwise -- so the UAT contract file was being graded under production
        # policy. That is a wrong ANSWER, not merely a wrong reason for one, and
        # it would have survived every epistemic fix above it.
        "--release-environment",
        "uat",
        "--report-path",
        str(db_report_path),
    ]
    # ACROSS THE BASH BOUNDARY. Every other check on this surface takes the
    # resolved interpreter as argv[0]; this one shells out to a script, so the
    # interpreter has to travel as an environment variable or the fix silently
    # does not reach it. It did not, at first: the runner chose the project venv
    # for parity, semantic, runtime and ci, and `verify_runtime_db_contract.sh`
    # went on invoking a hardcoded `python3` that could not import asyncpg. The
    # runner became honest about the failure without curing it, which is a real
    # improvement and not the same thing as a fix.
    db_env = dict(os.environ)
    db_env["PYTHON"] = python_cmd[0] if len(python_cmd) == 1 else sys.executable
    db_result = _run(db_cmd, env=db_env)
    db_report = _load_json(db_report_path) or {}

    semantic_env = dict(os.environ)
    loaded_overlay = _maybe_load_smoke_overlay(project, semantic_env)
    overlay_available = all(
        semantic_env.get(key) for key in ("REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE")
    )
    semantic_cmd = [
        *python_cmd,
        str(VERIFY_UAT_RELEASE),
        "--backend-url",
        backend_url,
        "--frontend-url",
        frontend_url,
        "--report-path",
        str(semantic_report_path),
    ]
    # An empty URL means `gcloud run services describe` could not answer, not
    # that the service is down. Handing "" to the verifier makes it report
    # failing live runtime behaviour for a service it never contacted.
    urls_resolved = bool(backend_url and frontend_url)
    if urls_resolved:
        semantic_result = _run(semantic_cmd, env=semantic_env)
    else:
        semantic_result = {
            "cmd": semantic_cmd,
            "returncode": 127,
            "stdout": "",
            "stderr": (
                "could not resolve the Cloud Run service URLs "
                f"(backend={backend_url!r}, frontend={frontend_url!r}); "
                "the semantic verifier was not run"
            ),
            "ok": False,
            "outcome": OUTCOME_UNEVALUABLE,
        }
    semantic_report = _load_json(semantic_report_path) or {}

    blocking: list[str] = []
    advisory: list[str] = []
    unevaluable: list[dict[str, str]] = []

    # PARITY. Ordered so the epistemic question is settled BEFORE the report is
    # mined. The previous shape (`unevaluable AND not parity_report`) let the
    # mere existence of a file suppress the "did not run" verdict, which is how
    # a stale artifact silenced a timeout.
    if parity_result["outcome"] == OUTCOME_UNEVALUABLE:
        _note_unevaluable(
            unevaluable,
            check="parity",
            result=parity_result,
            would_have_been="runtime_mount_missing",
        )
    elif parity_report:
        _append_unique(blocking, list(parity_report.get("classifications") or []))
    elif parity_result["outcome"] == OUTCOME_FAILURE:
        # Ran, failed, wrote nothing to read.
        _append_unique(blocking, ["runtime_mount_missing"])

    # SEMANTIC. Three outcomes, matching what deploy-uat.yml already does: the
    # verifier reported failures, the verifier itself failed, or it is clean.
    # This used to read ONLY `semantic_report["status"]`, so a verifier that died
    # at import wrote no report, `.get("status")` returned None, and a crashed
    # release check was indistinguishable from a clean one. Silence, not drift --
    # the opposite lie from the one six lines below, in the same function.
    if semantic_report.get("status") == "blocked":
        _append_unique(blocking, ["runtime_behavior_failed"])
        failures = set(semantic_report.get("failures") or [])
        if "smoke_auth" in failures:
            # This class asserts that a maintainer-only overlay leaked back into
            # canonical runtime files. Only say it when the overlay was actually
            # available: if Secret Manager could not be read, smoke auth fails
            # for a reason that has nothing to do with file hygiene, and naming
            # the wrong cause sends someone editing runtime config that is fine.
            if overlay_available:
                _append_unique(blocking, ["smoke_overlay_dependency_leak"])
            else:
                _note_unevaluable(
                    unevaluable,
                    check="smoke_overlay",
                    result={
                        "returncode": 1,
                        "stderr": "the maintainer smoke overlay could not be read "
                        "from Secret Manager, so smoke auth could not be attempted",
                    },
                    would_have_been="smoke_overlay_dependency_leak",
                )
    elif semantic_result["outcome"] == OUTCOME_UNEVALUABLE:
        _note_unevaluable(
            unevaluable,
            check="semantic",
            result=semantic_result,
            would_have_been="runtime_behavior_failed",
        )
    elif not semantic_result["ok"] and not semantic_report:
        # Ran, failed, produced nothing to read. The gate calls this
        # `semantic_verifier_failed`; same name here so the two agree.
        _append_unique(blocking, ["semantic_verifier_failed"])

    # DB CONTRACT. The line that started this: `returncode != 0` sent an operator
    # to hunt database drift because `asyncpg` was not importable.
    if db_result["outcome"] == OUTCOME_UNEVALUABLE:
        _note_unevaluable(
            unevaluable,
            check="db_contract",
            result=db_result,
            would_have_been="db_contract_drift",
        )
    elif db_result["outcome"] == OUTCOME_FAILURE:
        _append_unique(blocking, ["db_contract_drift"])


    return {
        "surface": "uat",
        **_verdict(blocking, unevaluable),
        "advisory_classifications": advisory,
        "next_actions": _build_next_actions(blocking, unevaluable),
        "context": {
            "interpreter": python_source,
            "project": project,
            "region": region,
            "backend_service": backend_service,
            "frontend_service": frontend_service,
            "backend_url": backend_url,
            "frontend_url": frontend_url,
            "backend_revision": _service_revision(project, region, backend_service),
            "frontend_revision": _service_revision(project, region, frontend_service),
            "loaded_overlay": loaded_overlay,
        },
        "reports": {
            "parity": {
                "report_path": str(parity_report_path),
                "returncode": parity_result["returncode"],
            },
            "semantic": {
                "report_path": str(semantic_report_path),
                "returncode": semantic_result["returncode"],
            },
            "db_contract": {
                "report_path": str(db_report_path),
                "returncode": db_result["returncode"],
            },
        },
        "raw": {
            "parity": {"result": parity_result, "report": parity_report},
            "semantic": {"result": semantic_result, "report": semantic_report},
            "db_contract": {"result": db_result, "report": db_report},
        },
    }


def _surface_runtime(_: argparse.Namespace, scratch_dir: Path) -> dict[str, Any]:
    python_cmd, python_source = _project_python()
    runtime_contract = _run([*python_cmd, str(VERIFY_RUNTIME_CONTRACT)])
    release_contract = _run([*python_cmd, str(VERIFY_RELEASE_CONTRACT)])
    audit_report_path = scratch_dir / "codex-audit.json"
    audit_result = _run(
        [*python_cmd, str(REPO_SCAN), "audit", "--json"],
    )
    audit_payload = None
    if audit_result["ok"]:
        try:
            audit_payload = json.loads(audit_result["stdout"])
        except json.JSONDecodeError:
            audit_payload = None
    if audit_payload is not None:
        audit_report_path.write_text(json.dumps(audit_payload, indent=2), encoding="utf-8")

    blocking: list[str] = []
    advisory: list[str] = []
    unevaluable: list[dict[str, str]] = []
    for name, result, classification in (
        ("runtime_contract", runtime_contract, "runtime_contract_drift"),
        ("release_contract", release_contract, "db_contract_drift"),
    ):
        if result["outcome"] == OUTCOME_UNEVALUABLE:
            _note_unevaluable(
                unevaluable, check=name, result=result, would_have_been=classification
            )
        elif result["outcome"] == OUTCOME_FAILURE:
            _append_unique(blocking, [classification])
    # The audit is advisory, and its silence used to be indistinguishable from a
    # clean scan: `if audit_result["ok"]` with no else, so a crashed scanner
    # produced no advisory at all.
    if audit_result["outcome"] == OUTCOME_UNEVALUABLE:
        _note_unevaluable(
            unevaluable, check="codex_audit", result=audit_result, would_have_been="doc_skill_drift"
        )
    _append_unique(advisory, _advisory_from_audit(audit_payload))

    return {
        "surface": "runtime",
        **_verdict(blocking, unevaluable),
        "advisory_classifications": advisory,
        "next_actions": _build_next_actions(blocking, unevaluable),
        "context": {"interpreter": python_source},
        "reports": {
            "runtime_contract": {"returncode": runtime_contract["returncode"]},
            "release_contract": {"returncode": release_contract["returncode"]},
            "codex_audit": {"report_path": str(audit_report_path) if audit_payload else ""},
        },
        "raw": {
            "runtime_contract": runtime_contract,
            "release_contract": release_contract,
            "codex_audit": {"result": audit_result, "report": audit_payload},
        },
    }


def _surface_ci(_: argparse.Namespace, scratch_dir: Path) -> dict[str, Any]:
    python_cmd, python_source = _project_python()
    ci_result = _run(["./bin/hushh", "ci"], cwd=REPO_ROOT)
    audit_report_path = scratch_dir / "codex-audit.json"
    audit_result = _run([*python_cmd, str(REPO_SCAN), "audit", "--json"])
    audit_payload = None
    if audit_result["ok"]:
        try:
            audit_payload = json.loads(audit_result["stdout"])
        except json.JSONDecodeError:
            audit_payload = None
    if audit_payload is not None:
        audit_report_path.write_text(json.dumps(audit_payload, indent=2), encoding="utf-8")

    blocking: list[str] = []
    advisory: list[str] = []
    unevaluable: list[dict[str, str]] = []
    if ci_result["outcome"] == OUTCOME_UNEVALUABLE:
        # `./bin/hushh ci` not being runnable here is not a failing CI lane.
        _note_unevaluable(
            unevaluable, check="ci", result=ci_result, would_have_been="core_ci_failed"
        )
    elif ci_result["outcome"] == OUTCOME_FAILURE:
        _append_unique(blocking, ["core_ci_failed"])
    if audit_result["outcome"] == OUTCOME_UNEVALUABLE:
        _note_unevaluable(
            unevaluable, check="codex_audit", result=audit_result, would_have_been="doc_skill_drift"
        )
    _append_unique(advisory, _advisory_from_audit(audit_payload))

    return {
        "surface": "ci",
        **_verdict(blocking, unevaluable),
        "advisory_classifications": advisory,
        "next_actions": _build_next_actions(blocking, unevaluable),
        "context": {"interpreter": python_source},
        "reports": {
            "ci": {"returncode": ci_result["returncode"]},
            "codex_audit": {"report_path": str(audit_report_path) if audit_payload else ""},
        },
        "raw": {
            "ci": ci_result,
            "codex_audit": {"result": audit_result, "report": audit_payload},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run structured Codex RCA for core runtime surfaces.")
    parser.add_argument("--surface", required=True, choices=("uat", "runtime", "ci"))
    parser.add_argument("--project")
    parser.add_argument("--region")
    parser.add_argument("--backend-service")
    parser.add_argument("--frontend-service")
    parser.add_argument("--backend-url")
    parser.add_argument("--frontend-url")
    parser.add_argument("--parity-report-path")
    parser.add_argument("--semantic-report-path")
    parser.add_argument("--db-report-path")
    parser.add_argument("--report-path")
    parser.add_argument(
        "--scratch-dir",
        help="where sub-reports are written; defaults to tmp/rca/<surface>/ so a "
        "later agent can read them instead of rediscovering the same blocker",
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    # DURABLE BY DEFAULT. This used to be a TemporaryDirectory, so every
    # sub-report the runner printed a path to was deleted the instant it exited:
    # the text output named `/var/folders/.../uat-db-contract.json`, and opening
    # it gave FileNotFoundError. The skill's own deliverable is a "resume-safe
    # RCA artifact" so the next agent does not rediscover the same blocker, and
    # a path that evaporates is the opposite of that.
    #
    # `tmp/` is gitignored (.gitignore:178), so this leaves nothing to commit.
    scratch_dir = Path(args.scratch_dir) if args.scratch_dir else DEFAULT_SCRATCH / args.surface
    scratch_dir.mkdir(parents=True, exist_ok=True)

    if args.surface == "uat":
        payload = _surface_uat(args, scratch_dir)
    elif args.surface == "runtime":
        payload = _surface_runtime(args, scratch_dir)
    else:
        payload = _surface_ci(args, scratch_dir)

    report_path = Path(args.report_path) if args.report_path else scratch_dir / "rca.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    payload.setdefault("reports", {})["rca"] = {"report_path": str(report_path)}

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(_render_text(payload))

    # Three exit codes for three states. Collapsing `unevaluable` into 1 would
    # let any caller that only checks `!= 0` repeat the original mistake one
    # layer up.
    if payload["status"] == "healthy":
        return 0
    return 1 if payload["status"] == "blocked" else 2


if __name__ == "__main__":
    raise SystemExit(main())
