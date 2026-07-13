from __future__ import annotations

import importlib.util
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
