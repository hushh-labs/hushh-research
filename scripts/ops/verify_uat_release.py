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
RIA_STAGE1_SMOKE_QUERY = "JOSEPH KIRKLAND"
RIA_STAGE1_SMOKE_CRD = "5838118"


def _http_probe(url: str) -> dict[str, Any]:
    try:
        response = requests.get(url, timeout=30)
    except requests.RequestException as exc:
        return {
            "url": url,
            "status_code": None,
            "ok": False,
            "error": str(exc),
        }
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
    # Checks that failed because an EXTERNAL provider is unavailable, not because
    # this release is bad. They are reported, never hidden, but they must not
    # block: a Google billing hold is not a reason to withhold healthy code.
    degraded: list[str] = []

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
            relay_session = smoke._request(  # noqa: SLF001
                "POST",
                "/api/one/adk/relay-session",
                headers=smoke._firebase_auth_headers(),  # noqa: SLF001
                expected=200,
            ).json()
            relay_session_ok = bool(
                isinstance(relay_session.get("relay_ticket"), str)
                and relay_session.get("relay_ticket")
                and isinstance(relay_session.get("expires_at"), int)
                and relay_session.get("expires_at") > 0
            )
            report["checks"].append(
                {
                    "name": "voice_relay_session",
                    "ok": relay_session_ok,
                    "model": relay_session.get("model"),
                    "tier": relay_session.get("tier"),
                }
            )
            if not relay_session_ok:
                failures.append("voice_relay_session")
        except Exception as exc:  # pragma: no cover - exercised in live verification
            _record_exception(report, failures, name="voice_relay_session", exc=exc)

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
