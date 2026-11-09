#!/usr/bin/env python3
"""Run semantic UAT verification against the live deployed release."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from importlib.util import module_from_spec, spec_from_file_location
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_ROOT = REPO_ROOT / "consent-protocol"
WEB_ROOT = REPO_ROOT / "hushh-webapp"
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

_UAT_SMOKE_PATH = PROTOCOL_ROOT / "scripts" / "uat_kai_regression_smoke.py"
_UAT_SPEC = spec_from_file_location("uat_kai_regression_smoke", _UAT_SMOKE_PATH)
if _UAT_SPEC is None or _UAT_SPEC.loader is None:
    raise RuntimeError(f"Unable to load UAT smoke module from {_UAT_SMOKE_PATH}")
_UAT_MODULE = module_from_spec(_UAT_SPEC)
sys.modules[_UAT_SPEC.name] = _UAT_MODULE
_UAT_SPEC.loader.exec_module(_UAT_MODULE)

DEFAULT_PROTOCOL_ENV = _UAT_MODULE.DEFAULT_PROTOCOL_ENV
DEFAULT_WEBAPP_ENV = _UAT_MODULE.DEFAULT_WEBAPP_ENV
UatKaiSmoke = _UAT_MODULE.UatKaiSmoke
RIA_STAGE1_SMOKE_QUERY = "JOSEPH KIRKLAND"
RIA_STAGE1_SMOKE_CRD = "5838118"
TRANSIENT_HTTP_STATUSES = {408, 429, 502, 503, 504}


def _exception_http_status(exc: Exception) -> int | None:
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return exc.response.status_code
    # The existing smoke client wraps unexpected HTTP responses in this fixed
    # prefix. Read only its status; never render the response body or tokens.
    if isinstance(exc, RuntimeError):
        match = re.match(
            r"^(?:GET|POST|PUT|PATCH|DELETE) /\S+ returned ([0-9]{3}):", str(exc)
        )
        if match:
            return int(match[1])
    return None


def _transient_exception(exc: Exception) -> bool:
    if isinstance(exc, requests.exceptions.SSLError):
        return False
    if isinstance(exc, (requests.Timeout, requests.ConnectionError)):
        return True
    return _exception_http_status(exc) in TRANSIENT_HTTP_STATUSES


def _http_probe(url: str, *, timeout: int = 30) -> dict[str, Any]:
    try:
        response = requests.get(url, timeout=timeout, allow_redirects=False)
    except requests.RequestException as exc:
        return {
            "url": url,
            "status_code": None,
            "ok": False,
            "error": type(exc).__name__,
            "retryable": _transient_exception(exc),
        }
    return {
        "url": url,
        "status_code": response.status_code,
        "ok": 200 <= response.status_code < 300,
        "retryable": response.status_code in TRANSIENT_HTTP_STATUSES,
    }


def _run_signed_in_routes(frontend_url: str, route_filter: str) -> dict[str, Any]:
    cmd = [
        "node",
        str(WEB_ROOT / "scripts" / "testing" / "verify-signed-in-routes.mjs"),
    ]
    env = {
        **os.environ,
        "HUSHH_APP_ORIGIN": frontend_url.rstrip("/"),
        "HUSHH_ROUTE_FILTER": route_filter,
        "HUSHH_VIEWPORT_FILTER": "desktop",
    }
    result = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        text=True,
        capture_output=True,
    )
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def _record_exception(
    report: dict[str, Any],
    failures: list[str],
    *,
    name: str,
    exc: Exception,
) -> None:
    report["checks"].append(
        {
            "name": name,
            "ok": False,
            "error": type(exc).__name__,
            "retryable": _transient_exception(exc),
            "http_status": _exception_http_status(exc),
        }
    )
    failures.append(name)


def _command_recovery_check(response: requests.Response) -> dict[str, Any]:
    """A private-placement refusal proves the hub boundary, not pod recovery."""
    commands = response.json()
    commands = commands if isinstance(commands, dict) else {}
    detail = commands.get("detail")
    detail = detail if isinstance(detail, dict) else {}
    error_code = detail.get("code")
    hosting_mode = detail.get("hostingMode")
    private_modes = ("byoc", "pending", "hussh_pods", "unplaced")
    private_runtime_required = (
        response.status_code == 409
        and error_code == "AGENT_PRIVATE_RUNTIME_REQUIRED"
        and ("hostingMode" not in detail or hosting_mode in private_modes)
    )
    commands_ok = response.status_code == 200 and isinstance(
        commands.get("commands"), list
    )
    return {
        "name": "location_command_recovery",
        "ok": commands_ok or private_runtime_required,
        "recovery_verified": commands_ok,
        "private_runtime_required": private_runtime_required,
        "status_code": response.status_code,
        "error_code": error_code
        if error_code in ("AGENT_PRIVATE_RUNTIME_REQUIRED", "AGENT_HOSTING_UNAVAILABLE")
        else "unrecognized"
        if error_code is not None
        else None,
        "hosting_mode": hosting_mode
        if hosting_mode in (*private_modes, "shared", "unknown")
        else "unrecognized"
        if hosting_mode is not None
        else None,
        "command_count": len(commands["commands"]) if commands_ok else 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-url", required=True)
    parser.add_argument("--frontend-url", required=True)
    parser.add_argument("--protocol-env", default=DEFAULT_PROTOCOL_ENV)
    parser.add_argument("--web-env", default=DEFAULT_WEBAPP_ENV)
    parser.add_argument("--report-path", required=True)
    parser.add_argument(
        "--run-live-model-checks",
        choices=("true", "false"),
        default="false",
        help="Opt into the paid live RIA probe selected by the release verification plan.",
    )
    parser.add_argument(
        "--include-signed-in-routes",
        action="store_true",
        help="Run the heavy signed-in route browser sweep and include it in the report.",
    )
    parser.add_argument(
        "--deployment-scope",
        choices=("backend", "frontend", "all"),
        help="UAT CD: probe deployed surfaces with strict successful HTTP status codes.",
    )
    parser.add_argument(
        "--require-gmail-configured",
        choices=("true", "false"),
        default="true",
        help="UAT CD: require Gmail when the selected runtime parity report requires it.",
    )
    parser.add_argument(
        "--github-output", type=Path, help="UAT CD retry decision output."
    )
    args = parser.parse_args()
    run_live_model_checks = args.run_live_model_checks == "true"

    report: dict[str, Any] = {
        "backend_url": args.backend_url,
        "frontend_url": args.frontend_url,
        "checks": [],
        "status": "healthy",
        "run_live_model_checks": run_live_model_checks,
    }

    failures: list[str] = []
    # Checks that failed because an EXTERNAL provider is unavailable, not because
    # this release is bad. They are reported, never hidden, but they must not
    # block: a Google billing hold is not a reason to withhold healthy code.
    degraded: list[str] = []

    for name, selected, url in (
        (
            "backend_health",
            args.deployment_scope != "frontend",
            f"{args.backend_url.rstrip('/')}/health",
        ),
        (
            "frontend_login",
            args.deployment_scope != "backend",
            f"{args.frontend_url.rstrip('/')}/login",
        ),
    ):
        if not selected:
            report["checks"].append(
                {
                    "name": name,
                    "ok": None,
                    "skipped": True,
                    "reason": "service_not_deployed",
                }
            )
            continue
        probe = _http_probe(url)
        report["checks"].append({"name": name, **probe})
        if not probe["ok"]:
            failures.append(name)

    smoke: UatKaiSmoke | None = None
    try:
        smoke = UatKaiSmoke(
            backend_url=args.backend_url,
            protocol_env=args.protocol_env,
            web_env=args.web_env,
        )
        smoke.authenticate()
        report["checks"].append(
            {"name": "smoke_auth", "ok": True, "user_id": smoke.user_id}
        )
    except Exception as exc:  # pragma: no cover - exercised in live verification
        _record_exception(report, failures, name="smoke_auth", exc=exc)
        if getattr(smoke, "session", None) is not None:
            smoke.session.close()
        smoke = None

    if smoke is not None:
        if args.deployment_scope == "frontend":
            report["checks"].append(
                {
                    "name": "gmail_status",
                    "ok": None,
                    "skipped": True,
                    "reason": "service_not_deployed",
                }
            )
        else:
            try:
                gmail_response = smoke._request(  # noqa: SLF001
                    "GET",
                    f"/api/kai/gmail/status/{smoke.user_id}",
                    headers=smoke._firebase_auth_headers(),  # noqa: SLF001
                    expected=200,
                ).json()
                gmail_ok = (
                    gmail_response.get("configured") is True
                    if args.deployment_scope is not None
                    else bool(gmail_response.get("configured"))
                )
                unconfigured = (
                    args.require_gmail_configured == "false"
                    and gmail_response.get("configured") is False
                )
                report["checks"].append(
                    {
                        "name": "gmail_status",
                        "ok": None if unconfigured else gmail_ok,
                        **(
                            {"skipped": True, "reason": "integration_not_configured"}
                            if unconfigured
                            else {}
                        ),
                        "configured": bool(gmail_response.get("configured")),
                        "connected": bool(gmail_response.get("connected")),
                    }
                )
                if not gmail_ok and not unconfigured:
                    failures.append("gmail_status")
            except Exception as exc:
                _record_exception(report, failures, name="gmail_status", exc=exc)
        try:
            response = smoke._request(  # noqa: SLF001
                "GET",
                "/api/one/action-proposals",
                headers=smoke._vault_headers(),  # noqa: SLF001
                expected=None,
            )
            command_check = _command_recovery_check(response)
            report["checks"].append(command_check)
            if not command_check["ok"]:
                failures.append("location_command_recovery")
        except Exception as exc:  # pragma: no cover - exercised in live verification
            _record_exception(
                report, failures, name="location_command_recovery", exc=exc
            )

        if run_live_model_checks:
            try:
                ria_stage1 = smoke._request(  # noqa: SLF001
                    "POST",
                    "/api/ria/onboarding/verify-name",
                    headers=smoke._firebase_auth_headers(),  # noqa: SLF001
                    json_body={
                        "query": RIA_STAGE1_SMOKE_QUERY,
                        "force_live_verification": True,
                    },
                    expected=200,
                ).json()
                ria_stage1_ok = (
                    str(ria_stage1.get("status") or "") == "verified"
                    and str(ria_stage1.get("crd_number") or "") == RIA_STAGE1_SMOKE_CRD
                )
                report["checks"].append(
                    {
                        "name": "ria_stage1_query_only",
                        "ok": ria_stage1_ok,
                        "status": ria_stage1.get("status"),
                        "provider": ria_stage1.get("provider"),
                        "matched_name": ria_stage1.get("matched_name"),
                        "crd_number": ria_stage1.get("crd_number"),
                        "reason_code": ria_stage1.get("reason_code"),
                    }
                )
                if not ria_stage1_ok:
                    # The backend already distinguishes "the provider is down" from
                    # "this advisor is not verified" -- ria_verification.py emits
                    # provider_unavailable for a 5xx/denied upstream and not_verified
                    # for a genuine negative. Until now that distinction was recorded
                    # in the check and then thrown away here, so an upstream Gemini
                    # outage read as a release regression.
                    if str(ria_stage1.get("status") or "") == "provider_unavailable":
                        degraded.append("ria_stage1_query_only")
                    else:
                        failures.append("ria_stage1_query_only")
            except Exception as exc:  # pragma: no cover - exercised in live verification
                _record_exception(report, failures, name="ria_stage1_query_only", exc=exc)

    if not run_live_model_checks:
        report["checks"].append(
            {
                "name": "ria_stage1_query_only",
                "ok": None,
                "skipped": True,
                "reason": "live_model_checks_not_requested",
            }
        )

    if args.include_signed_in_routes and smoke is not None:
        route_results = []
        for route_filter in ("consents", "ria/picks"):
            route_result = _run_signed_in_routes(args.frontend_url, route_filter)
            route_results.append({"route_filter": route_filter, **route_result})
            if not route_result["ok"]:
                failures.append(f"signed_in_routes:{route_filter}")
        report["checks"].append(
            {
                "name": "signed_in_routes",
                "ok": all(item["ok"] for item in route_results),
                "routes": route_results,
            }
        )
    else:
        report["checks"].append(
            {
                "name": "signed_in_routes",
                "ok": None if args.include_signed_in_routes else True,
                "skipped": True,
                "reason": "authentication_failed"
                if args.include_signed_in_routes
                else "non_blocking_postdeploy_surface",
            }
        )

    # Three states, not two. A release whose own code is healthy but whose
    # provider is down is neither "healthy" (AI does not work) nor "blocked"
    # (nothing is wrong with the build) -- reporting either one is a lie.
    report["degraded"] = degraded
    if failures:
        report["status"] = "blocked"
        report["failures"] = failures
    elif degraded:
        report["status"] = "degraded"
        report["failures"] = []

    if getattr(smoke, "session", None) is not None:
        smoke.session.close()
    report["retryable"] = bool(failures) and all(
        any(
            check.get("name") == failure and check.get("retryable") is True
            for check in report["checks"]
        )
        for failure in failures
    )
    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"retryable={str(report['retryable']).lower()}\n")

    if failures:
        print(json.dumps(report, indent=2))
        return 1

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
