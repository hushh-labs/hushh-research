from __future__ import annotations

import asyncio
import importlib.util
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROTOCOL_ROOT / "scripts" / "verify_managed_vertex_runtime.py"


def test_readiness_script_imports_from_an_uninstalled_container_checkout() -> None:
    result = subprocess.run(  # noqa: S603 - fixed interpreter and local script path
        [
            sys.executable,
            "-I",
            "-c",
            (
                "import runpy; "
                f"runpy.run_path({str(SCRIPT_PATH)!r}, run_name='readiness_import_test')"
            ),
        ],
        cwd=PROTOCOL_ROOT,
        capture_output=True,
        check=False,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_readiness_probe_has_cold_response_headroom() -> None:
    assert "PROBE_TIMEOUT_SECONDS = 25" in SCRIPT_PATH.read_text(encoding="utf-8")


@pytest.mark.asyncio
@pytest.mark.parametrize("hard_failure", [False, True])
async def test_stalled_live_preserves_slower_command_verdicts(
    monkeypatch: pytest.MonkeyPatch, hard_failure: bool
) -> None:
    spec = importlib.util.spec_from_file_location("readiness_timeout_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from hushh_mcp.operons.location import capabilities, plan
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import action_gateway

    async def completed(**kwargs):
        return None

    class AdkModel:
        async def generate_content_async(self, *args, **kwargs):
            yield None

    cancelled = []

    async def stall():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append("live")

    async def transcribe(self, *args):
        await asyncio.sleep(0.06)
        return "Open the Location screen."

    async def assess(self, **kwargs):
        # Command probes own a longer budget than text/Live. A hard fault
        # within that budget must survive the earlier Live timeout.
        await asyncio.sleep(0.06)
        if hard_failure:
            raise AttributeError("Synthetic candidate defect")
        return SimpleNamespace(unsupported=False)

    @asynccontextmanager
    async def connect(**kwargs):
        await stall()
        yield None

    monkeypatch.setattr(module, "PROBE_TIMEOUT_SECONDS", 0.03)
    monkeypatch.setattr(module, "_managed_manifest_models", lambda: ("gemini-3.6-flash",))
    binding = module.ManagedGeminiRuntimeBinding(
        project="synthetic", locations=("global",), auth_mode="vertex_adc"
    )
    monkeypatch.setattr(module.ManagedGeminiRuntimeBinding, "from_environment", lambda: binding)
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "build_direct_client",
        lambda self: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=completed))
        ),
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding, "build_adk_model", lambda self, model: AdkModel()
    )
    monkeypatch.setattr(LocationCommandBrain, "transcribe", transcribe)
    monkeypatch.setattr(LocationCommandBrain, "assess", assess)
    monkeypatch.setattr(action_gateway, "list_action_gateway_actions", lambda: [])
    monkeypatch.setattr(
        capabilities, "compile_location_capabilities", lambda actions: ("synthetic", [])
    )
    monkeypatch.setattr(
        plan, "validate_assessment", lambda *args, **kwargs: SimpleNamespace(steps=[object()])
    )
    monkeypatch.setattr(
        OneVoiceLiveConfig,
        "from_environment",
        lambda: SimpleNamespace(enabled=True, model_id="synthetic", location="us-central1"),
    )
    monkeypatch.setattr(
        factory,
        "build_managed_live_client",
        lambda **kwargs: SimpleNamespace(
            aio=SimpleNamespace(live=SimpleNamespace(connect=connect))
        ),
    )

    # Execute the production orchestration, with only provider adapters faked.
    # This outer deadline fails against the unbounded gather in the old code.
    report = await asyncio.wait_for(module.main(), timeout=1)
    failed = [probe for probe in report["probes"] if not probe["ok"]]
    assert len(failed) == 1 + hard_failure
    timed_out = [probe for probe in failed if probe["error_type"] == "TimeoutError"]
    assert len(timed_out) == 1
    assert timed_out[0]["classification"] == "provider_unavailable"
    assert report["classification"] == (
        "application_broken" if hard_failure else "provider_unavailable"
    )
    assert report["advisory"] is (not hard_failure)
    assert len(report["probes"]) == 5
    assert cancelled == ["live"]
