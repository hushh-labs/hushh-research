#!/usr/bin/env python3
"""Run semantic UAT verification against the live deployed release."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_ROOT = REPO_ROOT / "consent-protocol"
WEB_ROOT = REPO_ROOT / "hushh-webapp"
if str(PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(PROTOCOL_ROOT))

from importlib.util import module_from_spec, spec_from_file_location

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


def _http_probe(url: str) -> dict[str, Any]:
    response = requests.get(url, timeout=30)
    return {
        "url": url,
        "status_code": response.status_code,
        "ok": 200 <= response.status_code < 500,
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
            "error": str(exc),
        }
    )
    failures.append(name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-url", required=True)
    parser.add_argument("--frontend-url", required=True)
    parser.add_argument("--protocol-env", default=DEFAULT_PROTOCOL_ENV)
    parser.add_argument("--web-env", default=DEFAULT_WEBAPP_ENV)
    parser.add_argument("--report-path", required=True)
    parser.add_argument(
        "--include-signed-in-routes",
        action="store_true",
        help="Run the heavy signed-in route browser sweep and include it in the report.",
    )
    args = parser.parse_args()

    report: dict[str, Any] = {
        "backend_url": args.backend_url,
        "frontend_url": args.frontend_url,
        "checks": [],
        "status": "healthy",
    }

    failures: list[str] = []

    backend_probe = _http_probe(f"{args.backend_url.rstrip('/')}/health")
    report["checks"].append({"name": "backend_health", **backend_probe})
    if not backend_probe["ok"]:
        failures.append("backend_health")

    frontend_probe = _http_probe(f"{args.frontend_url.rstrip('/')}/login")
    report["checks"].append({"name": "frontend_login", **frontend_probe})
    if not frontend_probe["ok"]:
        failures.append("frontend_login")

    smoke: UatKaiSmoke | None = None
    try:
        smoke = UatKaiSmoke(
            backend_url=args.backend_url,
            protocol_env=args.protocol_env,
            web_env=args.web_env,
        )
        smoke.authenticate()
        report["checks"].append({"name": "smoke_auth", "ok": True, "user_id": smoke.user_id})
    except Exception as exc:  # pragma: no cover - exercised in live verification
        _record_exception(report, failures, name="smoke_auth", exc=exc)

    if smoke is not None:
        try:
            gmail_response = smoke._request(  # noqa: SLF001
                "GET",
                f"/api/kai/gmail/status/{smoke.user_id}",
                headers=smoke._firebase_auth_headers(),  # noqa: SLF001
                expected=200,
            ).json()
            gmail_ok = bool(gmail_response.get("configured"))
            report["checks"].append(
                {
                    "name": "gmail_status",
                    "ok": gmail_ok,
                    "configured": bool(gmail_response.get("configured")),
                    "connected": bool(gmail_response.get("connected")),
                }
            )
            if not gmail_ok:
                failures.append("gmail_status")
        except Exception as exc:  # pragma: no cover - exercised in live verification
            _record_exception(report, failures, name="gmail_status", exc=exc)

        try:
            voice_capability = smoke._request(  # noqa: SLF001
                "POST",
                "/api/kai/voice/capability",
                headers=smoke._vault_headers(),  # noqa: SLF001
                json_body={"user_id": smoke.user_id},
                expected=200,
            ).json()
            voice_capability_ok = bool(
                voice_capability.get("voice_enabled") and voice_capability.get("realtime_enabled")
            )
            report["checks"].append(
                {
                    "name": "voice_capability",
                    "ok": voice_capability_ok,
                    "voice_enabled": bool(voice_capability.get("voice_enabled")),
                    "execution_allowed": bool(voice_capability.get("execution_allowed")),
                    "realtime_enabled": bool(voice_capability.get("realtime_enabled")),
                }
            )
            if not voice_capability_ok:
                failures.append("voice_capability")
        except Exception as exc:  # pragma: no cover - exercised in live verification
            _record_exception(report, failures, name="voice_capability", exc=exc)

        try:
            realtime_session = smoke._request(  # noqa: SLF001
                "POST",
                "/api/kai/voice/realtime/session",
                headers=smoke._vault_headers(),  # noqa: SLF001
                json_body={"user_id": smoke.user_id, "voice": "alloy"},
                expected=200,
            ).json()
            realtime_ok = bool(realtime_session.get("client_secret")) and bool(
                realtime_session.get("session_id")
            )
            report["checks"].append(
                {
                    "name": "voice_realtime_session",
                    "ok": realtime_ok,
                    "model": realtime_session.get("model"),
                    "voice": realtime_session.get("voice"),
                }
            )
            if not realtime_ok:
                failures.append("voice_realtime_session")
        except Exception as exc:  # pragma: no cover - exercised in live verification
            _record_exception(report, failures, name="voice_realtime_session", exc=exc)

    if args.include_signed_in_routes:
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
                "ok": True,
                "skipped": True,
                "reason": "non_blocking_postdeploy_surface",
            }
        )

    if failures:
        report["status"] = "blocked"
        report["failures"] = failures

    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if failures:
        print(json.dumps(report, indent=2))
        return 1

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
