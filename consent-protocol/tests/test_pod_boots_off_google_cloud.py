"""The same pod image boots with no Google credentials and states what it can do.

The image used to die at import on Azure: the route package built One's intro head,
and building a head resolves the managed Gemini model, which needs Google ADC.
Every head is now built on first use, and the pod reports its Azure version 1
capabilities (sealed-log memory, no voice without a Vertex model, Files background
organization off, Gmail push off) instead of failing when someone tries them.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from api.routes.one.pod_capabilities import pod_capabilities
from hushh_mcp.one_adk.agui_factory import FirstUseAgent

_BACKEND = Path(__file__).resolve().parents[1]

_IMPORT_POD = """
import pod_server
from api.routes.one import agent_chat
assert agent_chat._one_head.cache_info().currsize == 0, "One's head was built at import"
assert agent_chat._intro_head.cache_info().currsize == 0, "the intro head was built at import"
print("booted", pod_server.app.state.runtime_topology)
"""

_GOOGLE_PROJECT = ("GOOGLE_CLOUD_PROJECT", "GENAI_GOOGLE_CLOUD_PROJECT")


def test_the_pod_imports_with_no_google_project_or_credentials(tmp_path):
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(tmp_path),  # no gcloud application-default credentials
        "CLOUDSDK_CONFIG": str(tmp_path / "gcloud"),
        "NO_GCE_CHECK": "True",  # CI must never probe a metadata server
        "PYTHONPATH": str(_BACKEND),
        "PYTHONDONTWRITEBYTECODE": "1",
        "APP_SIGNING_KEY": "test_secret_key_for_ci_only_32chars_min",
        "CONTAINER_APP_NAME": "one-pod-ha1",
        "CONTAINER_APP_REVISION": "one-pod-ha1--r1",
    }
    result = subprocess.run(  # noqa: S603 - fixed interpreter and script, test-owned env
        [sys.executable, "-c", _IMPORT_POD],
        cwd=_BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    assert "booted private_pod" in result.stdout


def test_a_first_use_agent_builds_only_when_used():
    built: list[int] = []
    proxy = FirstUseAgent(lambda: built.append(1) or SimpleNamespace(run="ran"))
    assert not hasattr(proxy, "__aiter__") and built == []
    assert proxy.run == "ran" and built == [1]


def _azure(monkeypatch) -> None:
    for name in (*_GOOGLE_PROJECT, "K_SERVICE", "POD_FILES_ENABLED", "POD_MEMORY_BACKEND"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("AGENT_GEMINI_LIVE_ENABLED", raising=False)
    monkeypatch.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    monkeypatch.setenv("HUSSH_ID", "ha1_owner")


def test_an_azure_pod_states_its_version_one_capabilities(monkeypatch):
    _azure(monkeypatch)
    assert pod_capabilities() == {
        "platform": "azure",
        "memoryRecall": {"source": "sealed_log"},
        "voice": {"available": False, "reason": "no_vertex_model"},
        "filesBackgroundOrganization": {"available": False, "reason": "files_disabled"},
        "gmailPush": {"available": False, "reason": "requires_google_pubsub"},
    }


def test_a_memory_bank_setting_without_a_google_project_still_recalls_from_the_log(monkeypatch):
    _azure(monkeypatch)
    monkeypatch.setenv("POD_MEMORY_BACKEND", "memory_bank")
    assert pod_capabilities()["memoryRecall"] == {"source": "sealed_log"}


def test_a_google_cloud_pod_keeps_voice_and_gmail_push(monkeypatch):
    monkeypatch.delenv("CONTAINER_APP_NAME", raising=False)
    monkeypatch.setenv("K_SERVICE", "one-pod-ha1")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "owner-project")
    monkeypatch.delenv("AGENT_GEMINI_LIVE_ENABLED", raising=False)
    capabilities = pod_capabilities()
    assert capabilities["platform"] == "gcp"
    assert capabilities["voice"] == {"available": True, "reason": None}
    assert capabilities["gmailPush"] == {"available": True, "reason": None}


def test_pod_info_reports_the_capabilities(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    pod_server = pytest.importorskip("pod_server")
    _azure(monkeypatch)
    assert pod_server.pod_info()["capabilities"]["platform"] == "azure"


async def test_voice_without_a_vertex_model_is_refused_before_accept(monkeypatch):
    from api.routes.one import pod_turn

    _azure(monkeypatch)
    monkeypatch.setattr(pod_turn, "_require_enabled", lambda: None)
    validator = AsyncMock(side_effect=AssertionError("consent must not be reached"))
    monkeypatch.setattr(pod_turn, "_validate_consent", validator)
    socket = AsyncMock()
    socket.headers = {"x-consent-token": "synthetic", "x-hussh-voice-session": "voice_" + "a" * 32}
    await pod_turn.pod_live_route(socket)
    socket.accept.assert_not_awaited()
    socket.close.assert_awaited_once_with(code=1008, reason="Private voice unavailable.")
    validator.assert_not_awaited()
