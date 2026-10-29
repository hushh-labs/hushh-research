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
SUMMARY_PATH = PROTOCOL_ROOT.parent / "scripts" / "ci" / "summarize_uat_managed_vertex_logs.py"


@pytest.mark.asyncio
@pytest.mark.parametrize("ready", [True, False])
async def test_uat_requires_complete_vertex_bundle_without_duplicate_legacy_probes(
    monkeypatch, ready
):
    from unittest.mock import AsyncMock

    from hushh_mcp.managed_ai_config import PROFILE_PATH, load_profile
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from scripts import probe_managed_capabilities, probe_managed_text, verify_azure_pwm_runtime
    from tests.test_uat_deploy_no_traffic_contract import _capability_results_fixture

    spec = importlib.util.spec_from_file_location("full_uat_readiness", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", "full")
    profile = load_profile("uat")
    binding = SimpleNamespace(project=profile["project"])
    monkeypatch.setattr(module, "_readiness_bindings", lambda: (binding, binding.project, binding))
    monkeypatch.setattr(module, "_managed_manifest_models", lambda: (profile["text_model"],))
    monkeypatch.setattr(
        module, "_run_paced_probes", lambda *_a, **_k: pytest.fail("duplicate probes")
    )
    monkeypatch.setattr(verify_azure_pwm_runtime, "_initialize_synthetic_runtime", lambda: None)
    core = {
        "scopes": {
            scope: {
                "ready": True,
                "model": profile["text_model"],
                "location": profile["text_locations"][0],
            }
            for scope in ("one_text_chat", "drive_document_requests")
        }
    }
    text_probe = AsyncMock(return_value=core)
    monkeypatch.setattr(probe_managed_text, "probe_managed_text", text_probe)
    capabilities = _capability_results_fixture(
        json.loads(PROFILE_PATH.read_text())["managed_runtime_uat"]
    )
    if not ready:
        capabilities["one_text_root"] = {
            "ready": False,
            "elapsed_ms": 3,
            "classification": "candidate_misconfigured",
            "error_type": "ValueError",
            "failure_reason": "root.roundtrip_failed",
        }
    complete = AsyncMock(return_value={"ready": ready, "capabilities": capabilities})
    monkeypatch.setattr(probe_managed_capabilities, "probe_managed_capabilities", complete)
    monkeypatch.setattr(
        OneVoiceLiveConfig,
        "from_environment",
        lambda: SimpleNamespace(
            model_id=profile["live_model"],
            location=profile["live_location"],
            vertex_project=binding.project,
        ),
    )
    report = await module.main()
    text_probe.assert_awaited_once_with("vertex")
    complete.assert_awaited_once()
    assert (
        complete.call_args.kwargs["deadline"] <= module.monotonic() + module.PROBE_SEQUENCE_SECONDS
    )
    assert report["one_chat_probe_ok"] is True
    assert report["ok"] is report["managed_runtime_capabilities_ready"] is ready
    if not ready:
        assert (
            next(p for p in report["probes"] if p["probe"] == "capability:one_text_root")["ok"]
            is False
        )


@pytest.mark.parametrize("transport", ["textPayload", "jsonPayload", "prefixed_text"])
@pytest.mark.parametrize("probe_name", ["one_chat:gemini-test@global", "capability:one_text_root"])
def test_vertex_log_summary_emits_only_validated_diagnostic_fields(tmp_path, transport, probe_name):
    marker = "SYNTHETIC_PRIVATE_ERROR_DO_NOT_PRINT"
    receipt = {
        "check": "managed_vertex_runtime",
        "config_hash": "a" * 64,
        "classification": "provider_unavailable",
        "ok": False,
        "resource_exhausted": True,
        "error_type": "ClientError",
        "error": marker,
        "owner": marker,
        "probes": [
            {
                "probe": probe_name,
                "ok": False,
                "classification": "provider_unavailable",
                "resource_exhausted": True,
                "error_type": "ClientError",
                "error": marker,
                "prompt": marker,
                "attempts": [
                    {
                        "ok": False,
                        "classification": "provider_unavailable",
                        "elapsed_ms": 25000,
                        "dispatched": False,
                        "error_type": marker,
                        "error": marker,
                    }
                ],
            }
        ],
    }
    if transport == "prefixed_text":
        receipt["probes"][0]["error_type"] = marker
    payload = (
        receipt
        if transport == "jsonPayload"
        else ("managed_vertex_probe_result " + json.dumps(receipt))
    )
    if transport == "prefixed_text":
        payload = "synthetic log wrapper " + payload
    probe_path = tmp_path / "probe.json"
    key = "jsonPayload" if transport == "jsonPayload" else "textPayload"
    probe_path.write_text(json.dumps([{key: payload}, {"textPayload": marker}]))
    build_path = tmp_path / "build.json"
    build_path.write_text(
        json.dumps(
            [
                {
                    "textPayload": 'Step #4 - "verify-managed-vertex-runtime": '
                    "Required UAT runtime probe did not fully pass: " + marker
                },
                {"textPayload": marker},
            ]
        )
    )
    result = subprocess.run(  # noqa: S603 - fixed local CLI, synthetic log files, no providers
        [sys.executable, str(SUMMARY_PATH), str(probe_path), "--build-logs", str(build_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert marker not in result.stdout + result.stderr
    assert json.loads(result.stdout) == {
        "receipt": {
            "check": "managed_vertex_runtime",
            "config_hash": "a" * 64,
            "classification": "provider_unavailable",
            "ok": False,
            "resource_exhausted": True,
            "error_type": "ClientError",
            "probes": [
                {
                    "probe": probe_name,
                    "ok": False,
                    "classification": "provider_unavailable",
                    "resource_exhausted": True,
                    "error_type": "OtherError" if transport == "prefixed_text" else "ClientError",
                    "attempts": [
                        {
                            "ok": False,
                            "classification": "provider_unavailable",
                            "elapsed_ms": 25000,
                            "dispatched": False,
                            "error_type": "OtherError",
                        }
                    ],
                }
            ],
        },
        "gate_failures": ["Required UAT runtime probe"],
    }


@pytest.mark.parametrize(
    "defect",
    [
        "missing",
        "malformed",
        "duplicate",
        "wrong_type",
        "unsafe_name",
        "unsafe_hash",
        "unsafe_duration",
    ],
)
def test_invalid_vertex_log_summary_fails_closed_but_retains_safe_build_reason(tmp_path, defect):
    marker = "SYNTHETIC_PRIVATE_ERROR_DO_NOT_PRINT"
    receipt = {
        "check": "managed_vertex_runtime",
        "config_hash": "a" * 64,
        "classification": "provider_unavailable",
        "ok": False,
        "probes": [
            {
                "probe": "one_chat:gemini-test@global",
                "ok": False,
                "classification": "provider_unavailable",
                "error": marker,
            }
        ],
    }
    if defect == "wrong_type":
        receipt["ok"] = marker
    elif defect == "unsafe_name":
        receipt["probes"][0]["probe"] = marker
    elif defect == "unsafe_hash":
        receipt["config_hash"] = marker
    elif defect == "unsafe_duration":
        receipt["probes"][0]["attempts"] = [
            {"ok": False, "classification": "provider_unavailable", "elapsed_ms": marker}
        ]
    entry = {"textPayload": "managed_vertex_probe_result " + json.dumps(receipt)}
    raw = (
        marker
        if defect == "malformed"
        else json.dumps(
            [] if defect == "missing" else [entry, entry] if defect == "duplicate" else [entry]
        )
    )
    build_path = tmp_path / "build.json"
    build_path.write_text(json.dumps([{"textPayload": "One chat Vertex target failed " + marker}]))
    result = subprocess.run(  # noqa: S603 - local diagnostic CLI with synthetic stdin
        [sys.executable, str(SUMMARY_PATH), "--build-logs", str(build_path)],
        input=raw,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert marker not in result.stdout + result.stderr
    assert json.loads(result.stdout) == {"receipt": None, "gate_failures": ["One chat Vertex"]}


def test_malformed_vertex_build_logs_do_not_echo_parser_input(tmp_path):
    marker = "SYNTHETIC_PRIVATE_ERROR_DO_NOT_PRINT"
    build_path = tmp_path / "build.json"
    build_path.write_text(marker)
    receipt = {
        "check": "managed_vertex_runtime",
        "ok": False,
        "classification": "application_broken",
        "probes": [],
    }
    result = subprocess.run(  # noqa: S603 - local CLI with synthetic diagnostic JSON
        [sys.executable, str(SUMMARY_PATH), "--build-logs", str(build_path)],
        input=json.dumps([{"jsonPayload": receipt}]),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert marker not in result.stdout + result.stderr
    assert json.loads(result.stdout) == {"receipt": receipt, "gate_failures": []}


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
@pytest.mark.parametrize("response_kind", ["valid", "empty", "thought_only", "truncated"])
async def test_direct_text_probe_requires_a_complete_non_thought_reply(monkeypatch, response_kind):
    monkeypatch.delenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", raising=False)
    spec = importlib.util.spec_from_file_location("direct_probe_validation_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from unittest.mock import AsyncMock

    from hushh_mcp.one_voice.config import OneVoiceLiveConfig

    response = module.types.GenerateContentResponse(
        candidates=[]
        if response_kind == "empty"
        else [
            module.types.Candidate(
                content=module.types.Content(
                    parts=[module.types.Part(text="OK", thought=response_kind == "thought_only")]
                ),
                finish_reason="MAX_TOKENS" if response_kind == "truncated" else "STOP",
            )
        ]
    )
    client = SimpleNamespace(
        aio=SimpleNamespace(
            models=SimpleNamespace(generate_content=AsyncMock(return_value=response))
        )
    )
    binding = module.ManagedGeminiRuntimeBinding(
        project="synthetic", locations=("global",), auth_mode="vertex_adc"
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding, "from_environment", lambda **kw: binding
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding, "build_direct_client", lambda self: client
    )
    monkeypatch.setattr(
        module, "managed_ai_settings", lambda: SimpleNamespace(project=None, config_hash="a" * 64)
    )
    monkeypatch.setattr(module, "_managed_manifest_models", lambda: ("gemini-3.6-flash",))
    monkeypatch.setattr(module, "_rehearse_command_flow", AsyncMock())
    monkeypatch.setattr(
        OneVoiceLiveConfig,
        "from_environment",
        lambda: SimpleNamespace(
            enabled=False, model_id="synthetic", location="global", vertex_project=None
        ),
    )

    async def only_direct_probe(labelled, *, attempts=None, deadline=None):
        outcomes = []
        for name, probe in labelled:
            error = None
            if name.startswith("text:"):
                try:
                    await probe()
                except Exception as caught:
                    error = caught
            outcomes.append(error)
            if attempts is not None:
                attempts[name] = []
        return outcomes

    monkeypatch.setattr(module, "_run_paced_probes", only_direct_probe)
    report = await module.main()
    direct = next(p for p in report["probes"] if p["probe"].startswith("text:"))
    assert direct["ok"] is (response_kind == "valid")
    assert report["ok"] is (response_kind == "valid")
    client.aio.models.generate_content.assert_awaited_once()


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
    monkeypatch.setattr(module, "PROBE_START_INTERVAL_SECONDS", 0)

    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from hushh_mcp.operons.location import capabilities, plan
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import action_gateway

    async def completed(**kwargs):
        return module.types.GenerateContentResponse(
            candidates=[
                module.types.Candidate(
                    content=module.types.Content(parts=[module.types.Part(text="OK")]),
                    finish_reason="STOP",
                )
            ]
        )

    class AdkModel:
        async def generate_content_async(self, *args, **kwargs):
            yield SimpleNamespace(
                error_code=None, content=SimpleNamespace(parts=[SimpleNamespace(text="OK")])
            )

    cancelled = []
    active = 0
    max_active = 0

    @asynccontextmanager
    async def tracked_probe():
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        try:
            yield
        finally:
            active -= 1

    async def stall():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append("live")

    async def transcribe(self, *args):
        async with tracked_probe():
            await asyncio.sleep(0.06)
            return "Open the Location screen."

    async def assess(self, **kwargs):
        # Command probes own a longer budget than text/Live. A hard fault
        # within that budget must survive the earlier Live timeout.
        async with tracked_probe():
            await asyncio.sleep(0.06)
            if hard_failure:
                raise AttributeError("Synthetic candidate defect")
            return SimpleNamespace(unsupported=False)

    @asynccontextmanager
    async def connect(**kwargs):
        async with tracked_probe():
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
    assert cancelled == (["live"] if hard_failure else ["live", "live"])
    assert max_active == 1 and active == 0


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
    monkeypatch.setattr(module, "PROBE_START_INTERVAL_SECONDS", 0)

    from hushh_mcp.agents.location.command_brain import LocationCommandBrain
    from hushh_mcp.one_voice.config import OneVoiceLiveConfig
    from hushh_mcp.operons.location import capabilities, plan
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import action_gateway

    first_use_paid: list[bool] = []

    async def provider_reply(**kwargs):
        await asyncio.sleep(0.01)
        return SimpleNamespace(
            error_code=None,
            content=SimpleNamespace(parts=[SimpleNamespace(text="OK")]),
            candidates=[
                module.types.Candidate(
                    content=module.types.Content(parts=[module.types.Part(text="OK")]),
                    finish_reason="STOP",
                )
            ],
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
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=provider_reply))
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
            aio=SimpleNamespace(live=SimpleNamespace(connect=connect))
        ),
    )

    report = await asyncio.wait_for(module.main(), timeout=5)

    assert first_use_paid
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
@pytest.mark.parametrize(
    "scenario", ["success", "billing_denied", "resource_exhausted", "adk_error", "empty_reply"]
)
async def test_chat_credit_project_requires_a_successful_runtime_identity_probe(
    monkeypatch: pytest.MonkeyPatch, scenario: str
) -> None:
    spec = importlib.util.spec_from_file_location("chat_vertex_readiness_test", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "PROBE_START_INTERVAL_SECONDS", 0)

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "false")
    monkeypatch.delenv("HUSHH_ONE_VOICE_VERTEX_PROJECT", raising=False)
    monkeypatch.setenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", "scoped")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "vertex")
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
                project=vertex_project or "unscoped-default-project",
                locations=("global",),
                auth_mode="vertex_adc",
            )
        ),
    )

    class AdkModel:
        def __init__(self, project: str):
            self.project = project

        async def generate_content_async(self, *_args, **_kwargs):
            if self.project == "hushh-gemini-bridge" and scenario == "billing_denied":
                raise RuntimeError("Billing is not enabled")
            if scenario == "resource_exhausted":
                error = RuntimeError("Synthetic structured provider response")
                error.status_code = 429
                raise error
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

    assert report["one_chat_project"] == "hushh-gemini-bridge"
    assert report["one_chat_probe_ok"] is chat_available
    assert chat_probe["ok"] is chat_available
    assert report["ok"] is chat_available
    assert report["advisory"] is chat_available
    if not chat_available:
        expected_classification = (
            "provider_unavailable"
            if scenario in {"billing_denied", "resource_exhausted"}
            else "candidate_misconfigured"
        )
        assert chat_probe["classification"] == expected_classification
        assert report["classification"] == expected_classification
        assert chat_probe["resource_exhausted"] is (scenario == "resource_exhausted")
        assert report["candidate_models_exercised"] is (
            scenario not in {"billing_denied", "resource_exhausted"}
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("connects", [True, False])
async def test_scoped_voice_probe_requires_the_parth_project_to_connect(
    monkeypatch: pytest.MonkeyPatch, connects: bool
) -> None:
    spec = importlib.util.spec_from_file_location("voice_vertex_readiness_test", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "PROBE_START_INTERVAL_SECONDS", 0)
    monkeypatch.delenv("HUSHH_ONE_CHAT_VERTEX_PROJECT", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_MANAGED_VERTEX_PROBE_MODE", "scoped")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "vertex")
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
        assert kwargs["vertex_project"] == "hushh-gemini-bridge"
        return SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=connect)))

    from unittest.mock import AsyncMock

    from hushh_mcp.runtime_providers import factory

    monkeypatch.setattr(module, "_probe_adk_response", AsyncMock())
    monkeypatch.setattr(factory, "build_managed_live_client", build_client)
    report = await module.main()
    assert report["one_voice_project"] == "hushh-gemini-bridge"
    assert report["one_voice_probe_ok"] is connects
    assert report["ok"] is connects
    assert seen and seen[0]["model"] == "gemini-live-2.5-flash-native-audio"
