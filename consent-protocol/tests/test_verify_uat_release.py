from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import httpx
import pytest
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
        "error": "SSLError",
        "retryable": False,
    }


def test_semantic_verifier_probes_location_command_recovery(monkeypatch, tmp_path) -> None:
    verifier = _load_verifier()
    request_paths: list[str] = []

    class _Response:
        def __init__(self, payload: dict[str, object]) -> None:
            self._payload = payload
            self.status_code = 200

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

        def _vault_headers(self) -> dict[str, str]:
            return {"Authorization": "Bearer vault-owner-token"}

        def _request(self, method: str, path: str, **_kwargs) -> _Response:
            request_paths.append(f"{method} {path}")
            if path == "/api/kai/gmail/status/uat-user":
                return _Response({"configured": True, "connected": False})
            if path == "/api/one/action-proposals":
                return _Response({"commands": []})
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
    assert "GET /api/one/action-proposals" in request_paths
    assert "POST /api/ria/onboarding/verify-name" not in request_paths
    assert all("/api/one/adk/" not in path for path in request_paths)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert {check["name"] for check in report["checks"]} >= {"location_command_recovery"}
    assert report["run_live_model_checks"] is False
    ria_check = next(
        check for check in report["checks"] if check["name"] == "ria_stage1_query_only"
    )
    assert ria_check == {
        "name": "ria_stage1_query_only",
        "ok": None,
        "skipped": True,
        "reason": "live_model_checks_not_requested",
    }


def _run_verifier_with_ria(
    monkeypatch,
    tmp_path,
    ria_payload: dict[str, object] | requests.RequestException,
    *,
    proposal_status: int = 200,
    proposal_detail: str = "AGENT_PRIVATE_RUNTIME_REQUIRED",
    proposal_mode: str | None = None,
) -> tuple[int, dict]:
    """Drive the verifier end to end with one configurable RIA Stage-1 answer."""
    verifier = _load_verifier()

    class _Response:
        def __init__(self, payload: dict[str, object], status_code: int = 200) -> None:
            self._payload = payload
            self.status_code = status_code

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

        def _vault_headers(self) -> dict[str, str]:
            return {"Authorization": "Bearer vault-owner-token"}

        def _request(self, method: str, path: str, **_kwargs) -> _Response:
            if path == "/api/kai/gmail/status/uat-user":
                return _Response({"configured": True, "connected": False})
            if path == "/api/one/action-proposals":
                if proposal_status != 200:
                    detail = {"code": proposal_detail}
                    if proposal_mode is not None:
                        detail.update(
                            {"hostingMode": proposal_mode, "message": "Open your private agent."}
                        )
                    return _Response({"detail": detail}, proposal_status)
                return _Response({"commands": []})
            if path == "/api/ria/onboarding/verify-name":
                assert method == "POST"
                assert _kwargs["json_body"]["force_live_verification"] is True
                if isinstance(ria_payload, requests.RequestException):
                    raise ria_payload
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
            "--run-live-model-checks",
            "true",
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
    assert report["run_live_model_checks"] is True
    ria_check = next(
        check for check in report["checks"] if check["name"] == "ria_stage1_query_only"
    )
    assert ria_check["ok"] is True
    assert not ria_check.get("skipped")


def test_shared_runtime_private_boundary_is_healthy_without_claiming_recovery(
    monkeypatch, tmp_path
) -> None:
    code, report = _run_verifier_with_ria(
        monkeypatch,
        tmp_path,
        {"status": "verified", "crd_number": "5838118"},
        proposal_status=409,
    )

    check = next(item for item in report["checks"] if item["name"] == "location_command_recovery")
    assert code == 0
    assert check["ok"] is True
    assert check["private_runtime_required"] is True
    assert check["recovery_verified"] is False


def test_other_proposal_conflict_still_blocks(monkeypatch, tmp_path) -> None:
    code, report = _run_verifier_with_ria(
        monkeypatch,
        tmp_path,
        {"status": "verified", "crd_number": "5838118"},
        proposal_status=409,
        proposal_detail="UNRELATED_CONFLICT",
    )

    assert code == 1
    assert "location_command_recovery" in report["failures"]


@pytest.mark.parametrize("mode", ["byoc", "pending", "hussh_pods", "unplaced"])
def test_current_private_refusal_proves_boundary_without_claiming_recovery(
    monkeypatch, tmp_path, mode
) -> None:
    code, report = _run_verifier_with_ria(
        monkeypatch,
        tmp_path,
        {"status": "verified", "crd_number": "5838118"},
        proposal_status=409,
        proposal_mode=mode,
    )
    check = next(item for item in report["checks"] if item["name"] == "location_command_recovery")
    assert code == 0
    assert check["private_runtime_required"] is True
    assert check["recovery_verified"] is False
    assert check["status_code"] == 409
    assert check["error_code"] == "AGENT_PRIVATE_RUNTIME_REQUIRED"
    assert check["hosting_mode"] == mode


@pytest.mark.parametrize(
    "status,detail,mode",
    [
        (409, "AGENT_PRIVATE_RUNTIME_REQUIRED", "shared"),
        (409, "AGENT_PRIVATE_RUNTIME_REQUIRED", "unknown"),
        (409, "UNRELATED_CONFLICT", "byoc"),
        (503, "AGENT_HOSTING_UNAVAILABLE", "unknown"),
        (401, "AGENT_PRIVATE_RUNTIME_REQUIRED", "byoc"),
    ],
)
def test_invalid_or_unavailable_proposal_refusal_still_blocks(
    monkeypatch, tmp_path, status, detail, mode
) -> None:
    code, report = _run_verifier_with_ria(
        monkeypatch,
        tmp_path,
        {"status": "verified", "crd_number": "5838118"},
        proposal_status=status,
        proposal_detail=detail,
        proposal_mode=mode,
    )
    assert code == 1
    assert "location_command_recovery" in report["failures"]


def test_requested_live_probe_transport_timeout_still_blocks(monkeypatch, tmp_path) -> None:
    code, report = _run_verifier_with_ria(
        monkeypatch, tmp_path, requests.exceptions.ReadTimeout("Provider response timed out")
    )

    assert code == 1
    assert report["status"] == "blocked"
    assert report["failures"] == ["ria_stage1_query_only"]
    assert report["degraded"] == []


def _load_email_release_verifier():
    path = Path(__file__).resolve().parents[2] / "scripts/ops/email_auth_uat_release.py"
    spec = importlib.util.spec_from_file_location("email_auth_release", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("available", [True, False])
def test_enabled_candidate_must_offer_email_sign_in_before_promotion(monkeypatch, available):
    module = _load_email_release_verifier()
    monkeypatch.setattr(
        module.httpx,
        "get",
        lambda *args, **kwargs: httpx.Response(200, json={"enabled": available}),
    )
    url = "https://candidate---consent-protocol-example-uc.a.run.app"
    if available:
        assert module.verify_candidate(url)["candidate_ready"]
    else:
        with pytest.raises(module.ReleaseError, match="candidate_capabilities"):
            module.verify_candidate(url)


@pytest.mark.parametrize("recovers", [True, False])
@pytest.mark.parametrize("failure", [httpx.ReadTimeout, httpx.ConnectError])
def test_candidate_readiness_retries_only_bounded_transport_reads(monkeypatch, recovers, failure):
    module = _load_email_release_verifier()
    calls, sleeps = [], []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        if recovers and len(calls) == 2:
            return httpx.Response(200, json={"enabled": True})
        raise failure("private diagnostic must not escape")

    monkeypatch.setattr(module.httpx, "get", get)
    monkeypatch.setattr(module.time, "sleep", sleeps.append)
    url = "https://candidate---consent-protocol-example-uc.a.run.app"
    if recovers:
        assert module.verify_candidate(url)["candidate_ready"]
    else:
        stage = "candidate_timeout" if failure is httpx.ReadTimeout else "candidate_transport"
        with pytest.raises(module.ReleaseError, match=f"^{stage}$"):
            module.verify_candidate(url)
    assert len(calls) == 2
    assert all(call == (url + "/api/auth/email/capabilities", {"timeout": 30}) for call in calls)
    assert sleeps == [2]


@pytest.mark.parametrize(
    "response,stage",
    [
        (httpx.Response(200, content=b"not json"), "candidate_response"),
        (httpx.Response(200, json=[]), "candidate_response"),
        (httpx.Response(200, json={"enabled": "true"}), "candidate_capabilities"),
        (httpx.Response(503), "candidate_capabilities"),
    ],
)
def test_candidate_invalid_readiness_is_refused_without_retry(monkeypatch, response, stage):
    module = _load_email_release_verifier()
    calls = []

    def get(*args, **kwargs):
        calls.append(args)
        return response

    monkeypatch.setattr(module.httpx, "get", get)
    with pytest.raises(module.ReleaseError, match=f"^{stage}$"):
        module.verify_candidate("https://candidate---consent-protocol-example-uc.a.run.app")
    assert len(calls) == 1


@pytest.mark.parametrize(
    "scope,configured,code,auth_ok,command_code,expected,required",
    [
        ("all", False, 200, True, 200, 0, False),
        ("all", True, 200, True, 200, 0, False),
        ("all", None, 200, True, 200, 1, False),
        ("backend", False, 200, True, 200, 0, False),
        ("frontend", None, 200, True, 200, 0, False),
        ("all", False, 401, True, 200, 1, False),
        ("all", False, 403, True, 200, 1, False),
        ("all", False, 404, True, 200, 1, False),
        ("all", False, 503, True, 200, 1, False),
        ("all", False, 200, False, 200, 1, False),
        ("frontend", False, 200, False, 200, 1, False),
        ("all", False, 200, True, 403, 1, False),
        ("all", False, 200, True, 200, 1, True),
        ("all", True, 200, True, 200, 0, True),
    ],
)
def test_scoped_uat_verification_keeps_health_auth_and_owner_boundary_blocking(
    monkeypatch, tmp_path, scope, configured, code, auth_ok, command_code, expected, required
):
    verifier = _load_verifier()
    requests_made = []
    probes = []

    class Smoke:
        user_id = "fixture-owner"

        def __init__(self, **_kwargs):
            pass

        def authenticate(self):
            if not auth_ok:
                raise RuntimeError("fixture authentication refused")

        def _firebase_auth_headers(self):
            return {}

        def _vault_headers(self):
            return {}

        def _request(self, method, path, **_kwargs):
            assert auth_ok, "Dependent checks must stop after authentication fails"
            requests_made.append(path)
            response = requests.Response()
            response.status_code = command_code if path.endswith("action-proposals") else 200
            response._content = json.dumps(
                {"configured": configured} if "/gmail/" in path else {"commands": []}
            ).encode()
            return response

    def probe(url, **_kwargs):
        probes.append(url)
        response = requests.Response()
        response.status_code = code
        return response

    monkeypatch.setattr(verifier, "UatKaiSmoke", Smoke)
    monkeypatch.setattr(verifier.requests, "get", probe)
    report_path = tmp_path / "semantic.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify",
            "--backend-url",
            "https://backend.invalid",
            "--frontend-url",
            "https://frontend.invalid",
            "--deployment-scope",
            scope,
            "--require-gmail-configured",
            str(required).lower(),
            "--report-path",
            str(report_path),
        ],
    )
    assert verifier.main() == expected
    report = json.loads(report_path.read_text())
    if scope == "frontend":
        assert probes == ["https://frontend.invalid/login"]
        assert not any("/gmail/" in path for path in requests_made)
    elif scope == "backend":
        assert probes == ["https://backend.invalid/health"]
    if not auth_ok:
        assert requests_made == []
        assert report["failures"] == ["smoke_auth"]
    elif scope != "frontend" and configured is False and not required:
        gmail = next(check for check in report["checks"] if check["name"] == "gmail_status")
        assert gmail["skipped"] is True and gmail["ok"] is None


@pytest.mark.parametrize(
    "status,ok,retryable",
    [
        (200, True, False),
        (204, True, False),
        (301, False, False),
        (401, False, False),
        (403, False, False),
        (404, False, False),
        (408, False, True),
        (429, False, True),
        (500, False, False),
        (502, False, True),
        (503, False, True),
        (504, False, True),
    ],
)
def test_http_health_accepts_only_success_and_classifies_transients(
    monkeypatch, status, ok, retryable
):
    verifier = _load_verifier()
    response = requests.Response()
    response.status_code = status
    monkeypatch.setattr(verifier.requests, "get", lambda *_a, **_k: response)
    result = verifier._http_probe("https://candidate.invalid/health")
    assert result["ok"] is ok
    assert result["retryable"] is retryable


@pytest.mark.parametrize(
    "failure,retryable",
    [
        (requests.Timeout("timeout"), True),
        (requests.ConnectionError("connection refused"), True),
        (requests.exceptions.SSLError("invalid certificate"), False),
        (RuntimeError("fixture-sensitive"), False),
        (RuntimeError("POST /api/consent/vault-owner-token returned 503: fixture-sensitive"), True),
        (
            RuntimeError("POST /api/consent/vault-owner-token returned 403: fixture-sensitive"),
            False,
        ),
    ],
)
def test_auth_failure_stops_browser_and_paid_dependents_and_classifies_retry(
    monkeypatch, tmp_path, failure, retryable
):
    verifier = _load_verifier()

    class Smoke:
        def __init__(self, **_kwargs):
            pass

        def authenticate(self):
            raise failure

        def _request(self, *_a, **_k):
            pytest.fail("Dependent smoke request after failed authentication")

    monkeypatch.setattr(verifier, "UatKaiSmoke", Smoke)
    monkeypatch.setattr(
        verifier, "_http_probe", lambda url: {"url": url, "ok": True, "status_code": 200}
    )
    monkeypatch.setattr(
        verifier,
        "_run_signed_in_routes",
        lambda *_a: pytest.fail("Browser after failed authentication"),
    )
    report, output = tmp_path / "report.json", tmp_path / "output"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify",
            "--backend-url",
            "https://backend.invalid",
            "--frontend-url",
            "https://frontend.invalid",
            "--report-path",
            str(report),
            "--github-output",
            str(output),
            "--run-live-model-checks",
            "true",
            "--include-signed-in-routes",
        ],
    )
    assert verifier.main() == 1
    result = json.loads(report.read_text())
    assert result["failures"] == ["smoke_auth"]
    assert result["retryable"] is retryable
    assert output.read_text() == f"retryable={str(retryable).lower()}\n"
    assert "fixture-sensitive" not in report.read_text()
    browser = next(check for check in result["checks"] if check["name"] == "signed_in_routes")
    assert browser["skipped"] is True and browser["reason"] == "authentication_failed"
