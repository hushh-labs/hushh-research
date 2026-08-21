from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import requests


def _load_verifier() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / "scripts" / "ops" / "verify_uat_release.py"
    spec = importlib.util.spec_from_file_location("verify_uat_release", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_http_probe_returns_structured_failure_on_transport_error(monkeypatch) -> None:
    verifier = _load_verifier()

    def raise_tls_error(*_args, **_kwargs):
        raise requests.exceptions.SSLError("TLS handshake failed")

    monkeypatch.setattr(verifier.requests, "get", raise_tls_error)

    result = verifier._http_probe("https://uat.one.hushh.ai/login")

    assert result == {
        "url": "https://uat.one.hushh.ai/login",
        "status_code": None,
        "ok": False,
        "error": "TLS handshake failed",
    }


def test_semantic_verifier_probes_the_canonical_one_adk_relay(monkeypatch, tmp_path) -> None:
    verifier = _load_verifier()
    request_paths: list[str] = []

    class _Response:
        def __init__(self, payload: dict[str, object]) -> None:
            self._payload = payload

        def json(self) -> dict[str, object]:
            return self._payload

    class _Smoke:
        user_id = "uat-user"

        def __init__(self, **_kwargs) -> None:
            pass

        def authenticate(self) -> None:
            pass

        def _firebase_auth_headers(self) -> dict[str, str]:
            return {"Authorization": "Bearer test-token"}

        def _request(self, method: str, path: str, **_kwargs) -> _Response:
            request_paths.append(f"{method} {path}")
            if path == "/api/kai/gmail/status/uat-user":
                return _Response({"configured": True, "connected": False})
            if path == "/api/one/adk/relay-session":
                return _Response(
                    {
                        "relay_ticket": "opaque-ticket",
                        "expires_at": 1,
                        "model": "adk",
                        "tier": "full",
                    }
                )
            if path == "/api/ria/onboarding/verify-name":
                return _Response({"status": "verified", "crd_number": "5838118"})
            raise AssertionError(f"Unexpected UAT verifier request: {method} {path}")

    monkeypatch.setattr(verifier, "UatKaiSmoke", _Smoke)
    monkeypatch.setattr(
        verifier,
        "_http_probe",
        lambda url: {"url": url, "status_code": 200, "ok": True},
    )
    report_path = tmp_path / "uat-release.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_uat_release.py",
            "--backend-url",
            "https://backend.example",
            "--frontend-url",
            "https://frontend.example",
            "--report-path",
            str(report_path),
        ],
    )

    assert verifier.main() == 0
    assert "POST /api/one/adk/relay-session" in request_paths
    assert all("/api/kai/voice/" not in path for path in request_paths)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert {check["name"] for check in report["checks"]} >= {"voice_relay_session"}


def _run_verifier_with_ria(
    monkeypatch, tmp_path, ria_payload: dict[str, object]
) -> tuple[int, dict]:
    """Drive the verifier end to end with one configurable RIA Stage-1 answer."""
    verifier = _load_verifier()

    class _Response:
        def __init__(self, payload: dict[str, object]) -> None:
            self._payload = payload

        def json(self) -> dict[str, object]:
            return self._payload

    class _Smoke:
        user_id = "uat-user"

        def __init__(self, **_kwargs) -> None:
            pass

        def authenticate(self) -> None:
            pass

        def _firebase_auth_headers(self) -> dict[str, str]:
            return {"Authorization": "Bearer test-token"}

        def _request(self, method: str, path: str, **_kwargs) -> _Response:
            if path == "/api/kai/gmail/status/uat-user":
                return _Response({"configured": True, "connected": False})
            if path == "/api/one/adk/relay-session":
                return _Response(
                    {"relay_ticket": "t", "expires_at": 1, "model": "adk", "tier": "full"}
                )
            if path == "/api/ria/onboarding/verify-name":
                return _Response(ria_payload)
            raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(verifier, "UatKaiSmoke", _Smoke)
    monkeypatch.setattr(
        verifier, "_http_probe", lambda url: {"url": url, "status_code": 200, "ok": True}
    )
    report_path = tmp_path / "uat-release.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_uat_release.py",
            "--backend-url",
            "https://backend.example",
            "--frontend-url",
            "https://frontend.example",
            "--report-path",
            str(report_path),
        ],
    )
    code = verifier.main()
    return code, json.loads(report_path.read_text(encoding="utf-8"))


def test_provider_outage_degrades_the_release_instead_of_blocking_it(monkeypatch, tmp_path) -> None:
    """An upstream Gemini outage must not withhold a healthy build.

    This is the 2026-08-20 case: RIA Stage-1 returned provider_unavailable
    because its Gemini calls were denied by a billing hold. The release was
    marked blocked, even though the candidate was fine.
    """
    code, report = _run_verifier_with_ria(
        monkeypatch, tmp_path, {"status": "provider_unavailable", "provider": "ria_stage1"}
    )

    assert code == 0, "a provider outage must not fail the release"
    assert report["status"] == "degraded"
    assert report["degraded"] == ["ria_stage1_query_only"]
    assert report["failures"] == []


def test_a_real_negative_result_still_blocks(monkeypatch, tmp_path) -> None:
    """not_verified means the provider answered and the answer was wrong.

    That is a genuine regression signal and must keep blocking, otherwise this
    change would trade one broken gate for a useless one.
    """
    code, report = _run_verifier_with_ria(
        monkeypatch, tmp_path, {"status": "not_verified", "crd_number": None}
    )

    assert code == 1, "a genuine verification failure must still block"
    assert report["status"] == "blocked"
    assert "ria_stage1_query_only" in report["failures"]
    assert report["degraded"] == []


def test_healthy_release_reports_no_degradation(monkeypatch, tmp_path) -> None:
    code, report = _run_verifier_with_ria(
        monkeypatch, tmp_path, {"status": "verified", "crd_number": "5838118"}
    )

    assert code == 0
    assert report["status"] == "healthy"
    assert report["degraded"] == []
