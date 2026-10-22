"""Private commands are reported unavailable exactly where the command gate refuses them.

On an agent whose own model is the person's Azure deployment, or an OpenAI key the
owner sealed to it, ``pod_commands`` refuses voice transcription and location
commands with a typed 503 ``COMMAND_MODEL_UNAVAILABLE``. ``/pod/info`` says so up
front as ``privateCommands``, so the app can explain it before anyone tries. Every
case drives the real gate beside the report, so the two cannot drift apart unseen:
a report that said "available" where the gate refuses is the false promise this
capability exists to remove.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one import pod_commands
from api.routes.one.pod_capabilities import pod_capabilities, private_commands_capability
from hushh_mcp.services import pod_ai_selection
from hushh_mcp.services.pod_ai_selection import AiSelection

AVAILABLE = {"available": True, "reason": None}
UNAVAILABLE = {"available": False, "reason": "requires_gemini_model"}
_MODEL_ENV = (
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT",
    "HUSSH_POD_USER_ADC_ENABLED",
    "HUSSH_POD_MANAGED_MODEL_ENABLED",
)


@pytest.fixture(autouse=True)
def _no_ambient_model(monkeypatch):
    for name in _MODEL_ENV:
        monkeypatch.delenv(name, raising=False)
    pod_ai_selection.set_active_ai_selection(None)
    yield
    pod_ai_selection.set_active_ai_selection(None)


def _azure(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://owner-ai.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")


def _seal(provider: str) -> None:
    pod_ai_selection.set_active_ai_selection(
        AiSelection(
            provider=provider,
            model=None,
            api_key="synthetic-owner-key",
            transport="developer_api" if provider == "gemini" else None,
            vertex_project=None,
            vertex_location=None,
            issued_at_ms=1,
            selection_id="sel-1",
            checked_at_ms=1,
        )
    )


def _azure_model(monkeypatch) -> None:
    _azure(monkeypatch)


def _azure_model_beside_a_fleet_flag(monkeypatch) -> None:
    _azure(monkeypatch)
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")


def _half_rendered_azure_model(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")


def _sealed_openai_key(monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "true")
    _seal("openai")


def _sealed_gemini_key_on_an_azure_pod(monkeypatch) -> None:
    _azure(monkeypatch)
    _seal("gemini")


def _own_vertex(monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "true")


def _managed_gemini(monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")


async def _gate_refusal() -> Any:
    """The command gate's typed refusal for a request with no key of its own, or None.

    ``_command_target`` decides before any builder runs, so an admitted case reaches
    no model and no network.
    """
    try:
        await pod_commands._command_target(
            pod_commands.CommandModel(), "owner-uid", {"hushh_id": "p"}
        )
    except HTTPException as exc:
        return exc.detail
    return None


_REFUSED_ON_AZURE = {"code": "COMMAND_MODEL_UNAVAILABLE", "runtimeMode": "user_azure_mi"}


@pytest.mark.parametrize(
    ("arrange", "expected", "refusal"),
    [
        (_azure_model, UNAVAILABLE, _REFUSED_ON_AZURE),
        (_azure_model_beside_a_fleet_flag, UNAVAILABLE, _REFUSED_ON_AZURE),
        (_half_rendered_azure_model, UNAVAILABLE, {"code": "AZURE_MODEL_TOPOLOGY_INVALID"}),
        (
            _sealed_openai_key,
            UNAVAILABLE,
            {"code": "COMMAND_MODEL_UNAVAILABLE", "runtimeMode": "byok"},
        ),
        (_sealed_gemini_key_on_an_azure_pod, AVAILABLE, None),
        (_own_vertex, AVAILABLE, None),
        (_managed_gemini, AVAILABLE, None),
    ],
    ids=lambda value: getattr(value, "__name__", "").lstrip("_") or None,
)
async def test_the_report_matches_the_command_gate(
    monkeypatch, arrange: Callable[[Any], None], expected: dict, refusal: Any
) -> None:
    arrange(monkeypatch)

    assert private_commands_capability() == expected
    assert await _gate_refusal() == refusal
    # The invariant the app relies on, stated once for every case above.
    assert expected["available"] is (refusal is None)


def test_pod_info_carries_private_commands_for_the_app(monkeypatch) -> None:
    _azure(monkeypatch)
    assert pod_capabilities()["privateCommands"] == UNAVAILABLE

    for name in _MODEL_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "owner-project")
    assert pod_capabilities()["privateCommands"] == AVAILABLE, "negative control: Gemini"


def test_the_report_never_raises_on_an_unreadable_selection(monkeypatch) -> None:
    """A selection that failed to load refuses turns, but a report must still answer."""
    _azure(monkeypatch)
    monkeypatch.setattr(pod_ai_selection, "_LOAD_FAILED", True)
    assert private_commands_capability() == UNAVAILABLE
