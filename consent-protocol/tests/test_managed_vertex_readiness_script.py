from __future__ import annotations

import asyncio
import importlib.util
import json
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROTOCOL_ROOT / "scripts" / "verify_managed_vertex_runtime.py"
LIVE_ASSERTION_PATH = PROTOCOL_ROOT.parent / "scripts" / "ci" / "assert_one_voice_live_probe.py"


def test_production_live_probe_requires_exact_success() -> None:
    spec = importlib.util.spec_from_file_location("live_probe_assertion", LIVE_ASSERTION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    target = "one_voice_live:gemini-live-2.5-flash-native-audio@us-central1"

    def line(probes: list[dict[str, object]]) -> str:
        return "managed_vertex_probe_result " + json.dumps({"probes": probes})

    good = {"probe": target, "ok": True, "classification": "dependency_ok"}
    assert module.live_probe_passed(
        line([good]), model="gemini-live-2.5-flash-native-audio", location="us-central1"
    )
    for verdict in (
        line([{**good, "ok": False, "classification": "provider_unavailable"}]),
        line([{**good, "probe": "one_voice_live:wrong@us-central1"}]),
        line([good, good]),
        line([]),
        "managed_vertex_probe_result invalid-json",
        "",
    ):
        assert not module.live_probe_passed(
            verdict, model="gemini-live-2.5-flash-native-audio", location="us-central1"
        )


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
    monkeypatch.delenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", raising=False)
    monkeypatch.delenv("HUSHH_ONE_CHAT_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("HUSHH_ONE_VOICE_VERTEX_PROJECT", raising=False)
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
            yield SimpleNamespace(
                error_code=None, content=SimpleNamespace(parts=[SimpleNamespace(text="OK")])
            )

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
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding, "from_environment", lambda **kwargs: binding
    )
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
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "build_regional_adk_model",
        lambda self, model: AdkModel(),
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
        lambda: SimpleNamespace(
            enabled=True, model_id="synthetic", location="us-central1", vertex_project=None
        ),
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
    assert len(report["probes"]) == 6
    assert cancelled == ["live"]


def _cold_command_flow_provider_fakes() -> SimpleNamespace:
    first_use_paid: list[bool] = []

    async def provider_reply(**kwargs):
        await asyncio.sleep(0.01)
        return SimpleNamespace(
            error_code=None, content=SimpleNamespace(parts=[SimpleNamespace(text="OK")])
        )

    class AdkModel:
        async def generate_content_async(self, *args, **kwargs):
            yield await provider_reply()

    async def transcribe(self, *args):
        await provider_reply()
        return "Open the Location screen."

    async def assess(self, **kwargs):
        if not first_use_paid:
            first_use_paid.append(True)
            time.sleep(0.5)  # cold imports are synchronous: they hold the shared loop
        if self.adk_model is None:
            await provider_reply()
        return SimpleNamespace(unsupported=False)

    @asynccontextmanager
    async def connect(**kwargs):
        await provider_reply()
        yield None

    return SimpleNamespace(
        first_use_paid=first_use_paid,
        provider_reply=provider_reply,
        AdkModel=AdkModel,
        transcribe=transcribe,
        assess=assess,
        connect=connect,
    )


@pytest.mark.asyncio
async def test_command_flow_first_use_cost_is_paid_before_provider_deadlines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """2026-10-15 UAT: Location's first ADK run imports ~2,400 modules on the loop
    every probe shares. On the 1-vCPU candidate job that synchronous burst outlasted
    the deadlines already armed for text, ADK, One chat and audio, so all of them
    timed out while Vertex served their requests in under 5 s."""
    monkeypatch.delenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", raising=False)
    monkeypatch.delenv("HUSHH_ONE_CHAT_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("HUSHH_ONE_VOICE_VERTEX_PROJECT", raising=False)
    spec = importlib.util.spec_from_file_location("readiness_first_use_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from hushh_mcp.operons.location import capabilities, plan
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import action_gateway

    fakes = _cold_command_flow_provider_fakes()

    monkeypatch.setattr(module, "PROBE_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(module, "_managed_manifest_models", lambda: ("gemini-3.6-flash",))
    binding = module.ManagedGeminiRuntimeBinding(
        project="synthetic", locations=("global",), auth_mode="vertex_adc"
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding, "from_environment", lambda **kwargs: binding
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "build_direct_client",
        lambda self: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=fakes.provider_reply))
        ),
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding, "build_adk_model", lambda self, model: fakes.AdkModel()
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "build_regional_adk_model",
        lambda self, model: fakes.AdkModel(),
    )
    monkeypatch.setattr(LocationCommandBrain, "transcribe", fakes.transcribe)
    monkeypatch.setattr(LocationCommandBrain, "assess", fakes.assess)
    monkeypatch.setattr(action_gateway, "list_action_gateway_actions", lambda: [])
    monkeypatch.setattr(
        capabilities, "compile_location_capabilities", lambda actions: ("synthetic", {})
    )
    monkeypatch.setattr(
        plan, "validate_assessment", lambda *args, **kwargs: SimpleNamespace(steps=[object()])
    )
    monkeypatch.setattr(
        OneVoiceLiveConfig,
        "from_environment",
        lambda: SimpleNamespace(
            enabled=True, model_id="synthetic", location="us-central1", vertex_project=None
        ),
    )
    monkeypatch.setattr(
        factory,
        "build_managed_live_client",
        lambda **kwargs: SimpleNamespace(
            aio=SimpleNamespace(live=SimpleNamespace(connect=fakes.connect))
        ),
    )

    report = await asyncio.wait_for(module.main(), timeout=5)

    assert fakes.first_use_paid
    assert [p["probe"] for p in report["probes"] if not p["ok"]] == []
    assert report["ok"] is True


@pytest.mark.asyncio
async def test_command_rehearsal_runs_the_real_location_flow_without_a_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spec = importlib.util.spec_from_file_location("readiness_rehearsal_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from google.genai import models as genai_models

    async def no_provider(*args, **kwargs):
        raise AssertionError("The readiness rehearsal must never call a provider")

    monkeypatch.setattr(genai_models.AsyncModels, "generate_content", no_provider)
    monkeypatch.setattr(genai_models.AsyncModels, "generate_content_stream", no_provider)

    # Real Location manifest, gateway, ADK runner and flow; only the model is local.
    # A swallowed failure returns None, so this proves the whole flow ran offline.
    assessment = await module._rehearse_command_flow()

    assert assessment is not None
    assert assessment.unsupported is True


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ["success", "billing_denied", "adk_error", "empty_reply"])
async def test_chat_credit_project_requires_a_successful_runtime_identity_probe(
    monkeypatch: pytest.MonkeyPatch, scenario: str
) -> None:
    spec = importlib.util.spec_from_file_location("chat_vertex_readiness_test", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "false")
    monkeypatch.delenv("HUSHH_ONE_VOICE_VERTEX_PROJECT", raising=False)
    monkeypatch.setenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", "scoped")
    monkeypatch.setattr(
        module,
        "_managed_manifest_models",
        lambda: pytest.fail("Chat-only readiness must not probe unrelated models"),
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "from_environment",
        classmethod(
            lambda cls, *, vertex_project=None: cls(
                project=vertex_project or "hushh-vertex-personal54",
                locations=("global",),
                auth_mode="vertex_adc",
            )
        ),
    )

    class AdkModel:
        def __init__(self, project: str):
            self.project = project

        async def generate_content_async(self, *_args, **_kwargs):
            if self.project == "hussh-511311" and scenario == "billing_denied":
                raise RuntimeError("Billing is not enabled")
            if scenario == "adk_error":
                yield SimpleNamespace(error_code="MAX_TOKENS", error_message="", content=None)
            elif scenario == "empty_reply":
                yield SimpleNamespace(
                    error_code=None, content=SimpleNamespace(parts=[SimpleNamespace(text="")])
                )
            else:
                yield SimpleNamespace(
                    error_code=None, content=SimpleNamespace(parts=[SimpleNamespace(text="OK")])
                )

    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "build_regional_adk_model",
        lambda self, _model: AdkModel(self.project),
    )

    report = await module.main()
    chat_probe = next(p for p in report["probes"] if str(p["probe"]).startswith("one_chat:"))
    chat_available = scenario == "success"

    assert report["one_chat_project"] == "hussh-511311"
    assert report["one_chat_probe_ok"] is chat_available
    assert chat_probe["ok"] is chat_available
    assert report["ok"] is chat_available
    assert report["advisory"] is chat_available
    if not chat_available:
        expected_classification = (
            "provider_unavailable" if scenario == "billing_denied" else "candidate_misconfigured"
        )
        assert chat_probe["classification"] == expected_classification
        assert report["classification"] == expected_classification
        assert report["candidate_models_exercised"] is (scenario != "billing_denied")


@pytest.mark.asyncio
@pytest.mark.parametrize("connects", [True, False])
async def test_scoped_voice_probe_requires_the_parth_project_to_connect(
    monkeypatch: pytest.MonkeyPatch, connects: bool
) -> None:
    spec = importlib.util.spec_from_file_location("voice_vertex_readiness_test", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.delenv("HUSHH_ONE_CHAT_VERTEX_PROJECT", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", "scoped")
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", "gemini-live-2.5-flash-native-audio")
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    seen = []

    @asynccontextmanager
    async def connect(**kwargs):
        seen.append(kwargs)
        if not connects:
            raise RuntimeError("Billing is not enabled")
        yield None

    def build_client(**kwargs):
        assert kwargs["vertex_project"] == "hussh-511311"
        return SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=connect)))

    from unittest.mock import AsyncMock

    from hushh_mcp.runtime_providers import factory

    monkeypatch.setattr(module, "_probe_adk_response", AsyncMock())
    monkeypatch.setattr(factory, "build_managed_live_client", build_client)
    report = await module.main()
    assert report["one_voice_project"] == "hussh-511311"
    assert report["one_voice_probe_ok"] is connects
    assert report["ok"] is connects
    assert seen and seen[0]["model"] == "gemini-live-2.5-flash-native-audio"
