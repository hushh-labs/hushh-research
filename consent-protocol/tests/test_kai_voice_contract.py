from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

if "asyncpg" not in sys.modules:
    asyncpg_stub = types.ModuleType("asyncpg")

    class _Pool:  # pragma: no cover - import-time stub only
        pass

    asyncpg_stub.Pool = _Pool
    sys.modules["asyncpg"] = asyncpg_stub

if "db" not in sys.modules:
    db_pkg = types.ModuleType("db")
    db_pkg.__path__ = []
    sys.modules["db"] = db_pkg

if "db.db_client" not in sys.modules:
    db_client_stub = types.ModuleType("db.db_client")

    def _noop_get_db():  # pragma: no cover - import-time stub only
        raise RuntimeError("db not available in unit test")

    db_client_stub.get_db = _noop_get_db
    sys.modules["db.db_client"] = db_client_stub

ROOT = Path(__file__).resolve().parents[1]
if "hushh_mcp.services" not in sys.modules:
    services_pkg = types.ModuleType("hushh_mcp.services")
    services_pkg.__path__ = [str(ROOT / "hushh_mcp" / "services")]
    sys.modules["hushh_mcp.services"] = services_pkg

from hushh_mcp.services.voice_intent_service import (  # noqa: E402
    _ALLOWED_COMMANDS,
    _ALLOWED_TOOL_NAMES,
    _UNCLEAR_STT_MESSAGE,
    VoiceIntentService,
    _compact_context,
)


def _app_state(
    *,
    signed_in: bool = True,
    vault_ok: bool = True,
    token_available: bool | None = None,
    token_valid: bool | None = None,
    voice_available: bool | None = None,
    runtime: dict | None = None,
) -> dict:
    resolved_token_available = vault_ok if token_available is None else token_available
    resolved_token_valid = vault_ok if token_valid is None else token_valid
    resolved_voice_available = vault_ok if voice_available is None else voice_available
    runtime_payload = {
        "analysis_active": False,
        "analysis_ticker": None,
        "analysis_run_id": None,
        "import_active": False,
        "import_run_id": None,
        "busy_operations": [],
    }
    if isinstance(runtime, dict):
        runtime_payload.update(runtime)
    return {
        "auth": {
            "signed_in": signed_in,
            "user_id": "user_a",
        },
        "vault": {
            "unlocked": vault_ok,
            "token_available": resolved_token_available,
            "token_valid": resolved_token_valid,
        },
        "route": {"pathname": "/kai", "screen": "kai_home"},
        "runtime": runtime_payload,
        "portfolio": {"has_portfolio_data": True},
        "voice": {"available": resolved_voice_available, "tts_playing": False},
    }


@pytest.fixture
def voice_service(monkeypatch: pytest.MonkeyPatch) -> VoiceIntentService:
    monkeypatch.setenv("OPENAI_API_KEY", "test_key")
    return VoiceIntentService()


@pytest.mark.anyio
async def test_plan_voice_response_stt_unusable_returns_exact_retry(
    voice_service: VoiceIntentService,
):
    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="   ",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "stt_unusable"
    assert response["message"] == _UNCLEAR_STT_MESSAGE
    assert response["execution_allowed"] is False
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_blocks_when_vault_invalid(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="open dashboard",
        user_id="user_a",
        app_state=_app_state(vault_ok=False),
        context={},
    )

    assert response["kind"] == "blocked"
    assert response["reason"] == "vault_required"
    assert response["execution_allowed"] is False
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_analyze_google_executes(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Analyze google",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["execution_allowed"] is True
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "GOOGL"
    assert response["memory"]["allow_durable_write"] is True


@pytest.mark.anyio
async def test_plan_voice_response_analysis_already_running(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze AAPL",
        user_id="user_a",
        app_state=_app_state(),
        context={},
        active_analysis={"run_id": "run_1", "ticker": "NVDA"},
    )

    assert response["kind"] == "already_running"
    assert response["execution_allowed"] is False
    assert response["task"] == "analysis"
    assert response["ticker"] == "NVDA"
    assert response["run_id"] == "run_1"


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_is_deterministic_speak_only(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for screen-explain intents")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)
    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="What is going on on my screen?",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert response["execution_allowed"] is False
    assert "screen" in response["message"].lower()
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_explain_screen_is_deterministic_speak_only(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for screen-explain intents")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)
    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="Explain this screen",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert response["execution_allowed"] is False
    assert "screen" in response["message"].lower()
    assert openai_http_ms == 0
    assert model == "deterministic"


def test_compact_context_keeps_structured_context_and_bounds_memory():
    short_items = [{"turn": idx} for idx in range(12)]
    retrieved_items = [{"id": idx} for idx in range(10)]
    compact = _compact_context(
        {
            "route": "/kai/analysis",
            "structured_screen_context": {"route": {"pathname": "/kai/analysis"}},
            "memory_short": short_items,
            "memory_retrieved": retrieved_items,
            "planner_v2_enabled": True,
            "planner_turn_id": "vturn_123",
            "ignored_key": "drop-me",
        }
    )

    assert compact["structured_screen_context"] == {"route": {"pathname": "/kai/analysis"}}
    assert compact["memory_short"] == short_items[:8]
    assert compact["memory_retrieved"] == retrieved_items[:8]
    assert compact["planner_v2_enabled"] is True
    assert compact["planner_turn_id"] == "vturn_123"
    assert "ignored_key" not in compact


@pytest.mark.anyio
async def test_plan_voice_response_import_already_running(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="import my statement",
        user_id="user_a",
        app_state=_app_state(),
        context={},
        active_import={"run_id": "import_run_1"},
    )

    assert response["kind"] == "already_running"
    assert response["task"] == "import"
    assert response["run_id"] == "import_run_1"


@pytest.mark.anyio
async def test_plan_voice_response_import_routes_to_command(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="open import",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["execution_allowed"] is True
    assert response["tool_call"] == {
        "tool_name": "execute_kai_command",
        "args": {"command": "import"},
    }


@pytest.mark.anyio
async def test_plan_voice_response_optimize_routes_to_canonical_command(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="open optimize",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["execution_allowed"] is True
    assert response["tool_call"] == {
        "tool_name": "execute_kai_command",
        "args": {"command": "optimize"},
    }


@pytest.mark.anyio
async def test_plan_voice_response_rejects_out_of_scope_tool_call(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _fake_llm(*args, **kwargs):
        return (
            {"tool_name": "execute_kai_command", "args": {"command": "delete_account"}},
            9,
            "fake-model",
        )

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _fake_llm)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="please do that",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "stt_unusable"
    assert response["message"] == _UNCLEAR_STT_MESSAGE
    assert response["execution_allowed"] is False
    assert openai_http_ms == 9
    assert model == "fake-model"


@pytest.mark.anyio
async def test_plan_voice_response_blocks_when_signed_out(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="open dashboard",
        user_id="user_a",
        app_state=_app_state(signed_in=False),
        context={},
    )

    assert response["kind"] == "blocked"
    assert response["reason"] == "auth_required"
    assert response["execution_allowed"] is False
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_blocks_when_token_missing(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="open dashboard",
        user_id="user_a",
        app_state=_app_state(vault_ok=True, token_available=False),
        context={},
    )

    assert response["kind"] == "blocked"
    assert response["reason"] == "vault_required"
    assert response["execution_allowed"] is False
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_blocks_when_token_expired(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="open dashboard",
        user_id="user_a",
        app_state=_app_state(vault_ok=True, token_valid=False),
        context={},
    )

    assert response["kind"] == "blocked"
    assert response["reason"] == "vault_required"
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_stt_unusable_for_noise(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="uh",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "stt_unusable"
    assert response["message"] == _UNCLEAR_STT_MESSAGE


@pytest.mark.anyio
async def test_plan_voice_response_stt_unusable_for_non_english(voice_service: VoiceIntentService):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="नमस्ते क्या हाल है",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "stt_unusable"
    assert response["message"] == _UNCLEAR_STT_MESSAGE


@pytest.mark.anyio
async def test_plan_voice_response_analyze_exact_ticker_executes(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    import hushh_mcp.services.voice_intent_service as voice_module

    monkeypatch.setattr(
        voice_module,
        "_resolve_ticker_target",
        lambda _target: {"kind": "exact", "ticker": "NVDA"},
    )

    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze NVDA",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "NVDA"


@pytest.mark.anyio
async def test_plan_voice_response_analyze_alias_executes(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Analyze alphabet",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "GOOGL"


@pytest.mark.anyio
async def test_plan_voice_response_noun_analysis_phrase_executes(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Start the analysis of Google's stock.",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "GOOGL"


@pytest.mark.anyio
async def test_plan_voice_response_analyze_with_polite_suffix_executes(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Can you please analyze NVIDIA for me?",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "NVDA"


@pytest.mark.anyio
async def test_plan_voice_response_start_analysis_without_ticker_clarifies(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Start analysis",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "ticker_unknown"
    assert "stock ticker" in response["message"].lower()


@pytest.mark.anyio
async def test_plan_voice_response_analyze_ambiguous_returns_clarify(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    import hushh_mcp.services.voice_intent_service as voice_module

    monkeypatch.setattr(
        voice_module,
        "_resolve_ticker_target",
        lambda _target: {"kind": "ambiguous", "candidate": None, "matches": ["GOOG", "GOOGL"]},
    )

    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze google",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "ticker_ambiguous"
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_analyze_unknown_returns_clarify(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze zzzxq holding company",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "ticker_unknown"
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_analysis_already_running_same_ticker(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze NVDA",
        user_id="user_a",
        app_state=_app_state(
            runtime={
                "analysis_active": True,
                "analysis_ticker": "NVDA",
                "analysis_run_id": "run_nvda",
            }
        ),
        context={},
    )

    assert response["kind"] == "already_running"
    assert response["task"] == "analysis"
    assert response["ticker"] == "NVDA"
    assert response["run_id"] == "run_nvda"


@pytest.mark.anyio
async def test_plan_voice_response_prefers_authoritative_inactive_analysis_over_runtime_flag(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze google",
        user_id="user_a",
        app_state=_app_state(
            runtime={
                "analysis_active": True,
                "analysis_ticker": "NVDA",
                "analysis_run_id": "stale_run",
            }
        ),
        context={},
        active_analysis={"active": False, "source": "run_manager", "run_id": "stale_run"},
    )

    assert response["kind"] == "execute"
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "GOOGL"


@pytest.mark.anyio
async def test_plan_voice_response_prefers_authoritative_inactive_import_over_runtime_flag(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="import my statement",
        user_id="user_a",
        app_state=_app_state(
            runtime={
                "analysis_active": False,
                "analysis_ticker": None,
                "analysis_run_id": None,
                "import_active": True,
                "import_run_id": "stale_import",
                "busy_operations": [],
            }
        ),
        context={},
        active_import={"active": False, "source": "run_manager", "run_id": "stale_import"},
    )

    assert response["kind"] == "execute"
    assert response["tool_call"] == {
        "tool_name": "execute_kai_command",
        "args": {"command": "import"},
    }


@pytest.mark.anyio
async def test_plan_voice_response_rejects_unknown_tool_call(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _fake_llm(*args, **kwargs):
        return ({"tool_name": "delete_account", "args": {}}, 3, "fake-model")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _fake_llm)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="please do that",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "clarify"
    assert response["reason"] == "stt_unusable"
    assert response["message"] == _UNCLEAR_STT_MESSAGE
    assert openai_http_ms == 3
    assert model == "fake-model"


@pytest.mark.anyio
async def test_plan_voice_response_destructive_phrase_is_not_executable(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="delete my account",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert response["message"] == "That action is not available in voice."
    assert response["memory"]["allow_durable_write"] is False


@pytest.mark.anyio
async def test_plan_voice_response_incomplete_runtime_fails_closed(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="analyze AAPL",
        user_id="user_a",
        app_state={
            **_app_state(),
            "runtime": {"analysis_active": False},
        },
        context={},
    )

    assert response["kind"] == "speak_only"
    assert "couldn't verify app state" in response["message"].lower()


@pytest.mark.anyio
async def test_plan_voice_response_memory_policy_by_kind(voice_service: VoiceIntentService):
    blocked, _, _ = await voice_service.plan_voice_response(
        transcript="open dashboard",
        user_id="user_a",
        app_state=_app_state(vault_ok=False),
        context={},
    )
    clarify_stt, _, _ = await voice_service.plan_voice_response(
        transcript="  ",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )
    already_running, _, _ = await voice_service.plan_voice_response(
        transcript="analyze AAPL",
        user_id="user_a",
        app_state=_app_state(),
        context={},
        active_analysis={"run_id": "run_1", "ticker": "AAPL"},
    )
    execute, _, _ = await voice_service.plan_voice_response(
        transcript="open profile",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert blocked["memory"]["allow_durable_write"] is False
    assert clarify_stt["memory"]["allow_durable_write"] is False
    assert already_running["memory"]["allow_durable_write"] is True
    assert execute["memory"]["allow_durable_write"] is True


def test_voice_tool_policy_whitelist_excludes_destructive_actions():
    assert "delete_account" not in _ALLOWED_TOOL_NAMES
    assert "delete_imported_data" not in _ALLOWED_TOOL_NAMES
    assert "delete_account" not in _ALLOWED_COMMANDS
    assert "delete_imported_data" not in _ALLOWED_COMMANDS
