from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest


class _UndefinedColumnError(Exception):  # pragma: no cover - import-time stub only
    pass


class _UndefinedTableError(Exception):  # pragma: no cover - import-time stub only
    pass


if "asyncpg" not in sys.modules:
    asyncpg_stub = types.ModuleType("asyncpg")

    class _Pool:  # pragma: no cover - import-time stub only
        pass

    asyncpg_stub.Pool = _Pool
    sys.modules["asyncpg"] = asyncpg_stub
if not hasattr(sys.modules["asyncpg"], "UndefinedColumnError"):
    sys.modules["asyncpg"].UndefinedColumnError = _UndefinedColumnError
if not hasattr(sys.modules["asyncpg"], "UndefinedTableError"):
    sys.modules["asyncpg"].UndefinedTableError = _UndefinedTableError

if "db" not in sys.modules:
    db_pkg = types.ModuleType("db")
    db_pkg.__path__ = []
    sys.modules["db"] = db_pkg


class _DatabaseExecutionError(Exception):  # pragma: no cover - import-time stub only
    pass


if "db.db_client" not in sys.modules:
    db_client_stub = types.ModuleType("db.db_client")

    def _noop_get_db():  # pragma: no cover - import-time stub only
        raise RuntimeError("db not available in unit test")

    db_client_stub.get_db = _noop_get_db
    db_client_stub.DatabaseExecutionError = _DatabaseExecutionError
    sys.modules["db.db_client"] = db_client_stub
elif not hasattr(sys.modules["db.db_client"], "DatabaseExecutionError"):
    sys.modules["db.db_client"].DatabaseExecutionError = _DatabaseExecutionError

ROOT = Path(__file__).resolve().parents[1]
if "hushh_mcp.services" not in sys.modules:
    services_pkg = types.ModuleType("hushh_mcp.services")
    services_pkg.__path__ = [str(ROOT / "hushh_mcp" / "services")]
    sys.modules["hushh_mcp.services"] = services_pkg

import hushh_mcp.services.voice_intent_service as voice_intent_service_module  # noqa: E402
from hushh_mcp.services.voice_intent_service import (  # noqa: E402
    _ALLOWED_COMMANDS,
    _ALLOWED_TOOL_NAMES,
    _REALTIME_TRANSCRIPTION_PROMPT,
    _UNCLEAR_STT_MESSAGE,
    _VOICE_ENGLISH_ONLY_INPUT_MESSAGE,
    _VOICE_TTS_INSTRUCTIONS,
    VoiceIntentService,
    _compact_context,
)
from hushh_mcp.services.voice_prompt_builder import (  # noqa: E402
    build_voice_planner_context,
    build_voice_planner_system_prompt,
    build_voice_response_composer_context,
    build_voice_response_composer_system_prompt,
)


def _app_state(
    *,
    signed_in: bool = True,
    vault_ok: bool = True,
    token_available: bool | None = None,
    token_valid: bool | None = None,
    voice_available: bool | None = None,
    runtime: dict | None = None,
    route: dict | None = None,
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
        "route": route or {"pathname": "/kai", "screen": "kai_home"},
        "runtime": runtime_payload,
        "portfolio": {"has_portfolio_data": True},
        "voice": {"available": resolved_voice_available, "tts_playing": False},
    }


class _FakeTTSStream:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.closed = False
        self.meta = {
            "model": "gpt-4o-mini-tts",
            "voice": "alloy",
            "format": "mp3",
            "source": "backend_openai_audio",
            "attempts": [
                {
                    "model": "gpt-4o-mini-tts",
                    "status_code": 200,
                    "elapsed_ms": 11,
                    "result": "success",
                }
            ],
            "openai_http_ms": 11,
            "audio_bytes": 0,
            "content_length": 3,
            "completed": False,
            "aborted": False,
        }

    async def read_next_chunk(self) -> bytes | None:
        if not self._chunks:
            self.meta["completed"] = True
            return None
        chunk = self._chunks.pop(0)
        self.meta["audio_bytes"] = int(self.meta.get("audio_bytes") or 0) + len(chunk)
        if not self._chunks:
            self.meta["completed"] = True
        return chunk

    async def aclose(self) -> None:
        self.closed = True


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
async def test_transcribe_audio_pins_openai_stt_to_english(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200

    async def _fake_post_with_model_fallback(**kwargs):
        built = kwargs["body_builder"]("gpt-4o-mini-transcribe")
        captured["data"] = built["data"]
        captured["files"] = built["files"]
        return _FakeResponse(), {"text": "open profile"}, 12, "gpt-4o-mini-transcribe"

    monkeypatch.setattr(
        voice_intent_service_module,
        "_post_with_model_fallback",
        _fake_post_with_model_fallback,
    )

    transcript, openai_http_ms, model = await voice_service.transcribe_audio(
        audio_bytes=b"abc",
        filename="voice.webm",
        content_type="audio/webm",
    )

    assert transcript == "open profile"
    assert openai_http_ms == 12
    assert model == "gpt-4o-mini-transcribe"
    assert captured["data"] == {
        "model": "gpt-4o-mini-transcribe",
        "language": "en",
        "prompt": _REALTIME_TRANSCRIPTION_PROMPT,
    }
    assert "file" in captured["files"]


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


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_only_expands_on_explicit_detail_request(
    voice_service: VoiceIntentService,
):
    concise, _, _ = await voice_service.plan_voice_response(
        transcript="Explain this screen",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )
    detailed, _, _ = await voice_service.plan_voice_response(
        transcript="Explain this screen in detail",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert concise["kind"] == "speak_only"
    assert detailed["kind"] == "speak_only"
    assert "Next actions:" not in concise["message"]
    assert "Next actions:" in detailed["message"]


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_receipts_surface_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is on my screen?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile/receipts", "screen": "profile_receipts"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/receipts",
                    "screen": "profile_receipts",
                },
                "ui": {
                    "active_section": "Receipt memory preview",
                    "available_actions": ["Refresh receipt memory", "Save receipts memory to PKM"],
                },
                "screen_metadata": {
                    "connector_badge_label": "Connected",
                    "receipt_count": 12,
                    "preview_available": True,
                    "preview_stale": False,
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "Receipt Memory Preview" in response["message"]
    assert "12 stored receipts" in response["message"]


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_gmail_panel_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What's happening here?",
        user_id="user_a",
        app_state=_app_state(
            route={
                "pathname": "/profile?tab=account&panel=gmail",
                "screen": "profile_gmail_panel",
            }
        ),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile?tab=account&panel=gmail",
                    "screen": "profile_gmail_panel",
                },
                "screen_metadata": {
                    "gmail_connected": True,
                    "google_email": "i-akshat@hushh.ai",
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "Gmail connector" in response["message"]
    assert "i-akshat@hushh.ai" in response["message"]


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_pkm_agent_lab_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Explain this section",
        user_id="user_a",
        app_state=_app_state(
            route={
                "pathname": "/profile/pkm-agent-lab",
                "screen": "profile_pkm_agent_lab",
            }
        ),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/pkm-agent-lab",
                    "screen": "profile_pkm_agent_lab",
                },
                "screen_metadata": {
                    "domain_count": 4,
                    "preview_card_count": 1,
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "PKM Agent Lab" in response["message"]
    assert "4 PKM domains" in response["message"]


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_market_surface_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is happening here?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/kai", "screen": "kai_market"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/kai",
                    "screen": "kai_market",
                },
                "surface": {
                    "screen_id": "kai_market",
                    "title": "Market",
                    "purpose": "This screen is the market overview workspace for live tape, advisor signals, and discovery.",
                },
                "screen_metadata": {
                    "market_mode": "baseline",
                    "signal_count": 3,
                    "spotlight_count": 5,
                    "connect_portfolio_visible": True,
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "market home" in response["message"].lower()
    assert "baseline market mode" in response["message"].lower()
    assert "3 signals and 5 spotlight names" in response["message"].lower()


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_portfolio_surface_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is on my screen?",
        user_id="user_a",
        app_state=_app_state(
            route={"pathname": "/kai/portfolio", "screen": "kai_portfolio_dashboard"}
        ),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/kai/portfolio",
                    "screen": "kai_portfolio_dashboard",
                },
                "surface": {
                    "screen_id": "kai_portfolio_dashboard",
                    "title": "Portfolio",
                    "purpose": "This screen is the holdings workspace for source switching, portfolio context, and optimization.",
                },
                "screen_metadata": {
                    "flow_state": "dashboard",
                    "active_source": "plaid",
                    "saved_holdings_count": 9,
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "portfolio dashboard" in response["message"].lower()
    assert "plaid source" in response["message"].lower()
    assert "9 holdings" in response["message"].lower()


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_analysis_surface_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Explain this screen",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/kai/analysis", "screen": "kai_analysis"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/kai/analysis",
                    "screen": "kai_analysis",
                },
                "surface": {
                    "screen_id": "kai_analysis_workspace",
                    "title": "Analysis",
                    "purpose": "This screen is the analysis workspace for live debates, summaries, and detailed reasoning.",
                },
                "screen_metadata": {
                    "surface_mode": "workspace",
                    "active_ticker": "NVDA",
                    "workspace_tab": "summary",
                    "has_active_run": True,
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "analysis workspace" in response["message"].lower()
    assert "NVDA" in response["message"]
    assert "Summary" in response["message"]


@pytest.mark.anyio
async def test_plan_voice_response_screen_explain_uses_consents_surface_metadata(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is going on on my screen?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/consents", "screen": "consents"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/consents",
                    "screen": "consents",
                },
                "surface": {
                    "screen_id": "consents",
                    "title": "Consents",
                    "purpose": "This screen is where sharing requests are reviewed and managed.",
                },
                "screen_metadata": {
                    "tab": "active",
                    "pending_count": 2,
                    "active_count": 4,
                    "selected_status": "active",
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "consent center" in response["message"].lower()
    assert "active tab" in response["message"].lower()
    assert "2 pending and 4 active grants" in response["message"].lower()


@pytest.mark.anyio
async def test_plan_voice_response_explains_global_pkm_concept_deterministically(
    voice_service: VoiceIntentService,
):
    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="What is PKM?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert "encrypted personal memory layer" in response["message"]
    assert response["execution_allowed"] is False
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_explains_profile_surface_locally_first(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is on my profile?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile",
                    "screen": "profile_account",
                },
                "surface": {
                    "screen_id": "profile_account",
                    "title": "Profile",
                    "purpose": "This page gives you account settings, Gmail receipts access, support, and PKM access.",
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert response["message"] == (
        "You are on Profile. This page gives you account settings, Gmail receipts access, support, and PKM access."
    )


@pytest.mark.anyio
async def test_plan_voice_response_explains_gmail_receipts_from_profile_surface(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What does Gmail receipts do?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile",
                    "screen": "profile_account",
                },
                "surface": {
                    "screen_id": "profile_account",
                    "title": "Profile",
                    "purpose": "This page gives you account settings, Gmail receipts access, support, and PKM access.",
                    "controls": [
                        {
                            "id": "gmail_receipts",
                            "label": "Gmail receipts",
                            "purpose": "opens Gmail receipt sync and receipt-memory import.",
                            "action_id": "route.profile_receipts",
                            "role": "card",
                            "voice_aliases": ["gmail receipts", "receipts"],
                        }
                    ],
                    "concepts": [
                        {
                            "id": "gmail_receipts",
                            "label": "Gmail receipts",
                            "explanation": "Gmail receipts connects Gmail receipt sync and feeds receipt-memory imports into PKM.",
                            "aliases": ["gmail receipts", "receipt sync"],
                        }
                    ],
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "receipt" in response["message"].lower()
    assert "sync" in response["message"].lower()
    assert "pkm" in response["message"].lower()


@pytest.mark.anyio
async def test_plan_voice_response_explains_current_button_from_surface_definition(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is this button?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile",
                    "screen": "profile_account",
                },
                "surface": {
                    "screen_id": "profile_account",
                    "title": "Profile",
                    "purpose": "This page gives you account settings, Gmail receipts access, support, and PKM access.",
                    "active_control_id": "pkm_agent_lab",
                    "controls": [
                        {
                            "id": "pkm_agent_lab",
                            "label": "PKM Agent Lab",
                            "purpose": "opens the workspace for previewing and saving encrypted PKM captures.",
                            "action_id": "route.profile_pkm_agent_lab",
                            "role": "card",
                            "voice_aliases": ["pkm agent lab", "pkm"],
                        }
                    ],
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert response["message"] == (
        "PKM Agent Lab opens the workspace for previewing and saving encrypted PKM captures."
    )


@pytest.mark.anyio
async def test_plan_voice_response_explains_last_interacted_button_from_surface_definition(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is this button?",
        user_id="user_a",
        app_state=_app_state(
            route={"pathname": "/profile/pkm-agent-lab", "screen": "profile_pkm_agent_lab"}
        ),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/pkm-agent-lab",
                    "screen": "profile_pkm_agent_lab",
                },
                "surface": {
                    "screen_id": "profile_pkm_agent_lab",
                    "title": "PKM Agent Lab",
                    "purpose": "This workspace previews, saves, and inspects encrypted PKM captures and permissions.",
                    "last_interacted_control_id": "save_pkm_capture",
                    "controls": [
                        {
                            "id": "save_pkm_capture",
                            "label": "Save PKM capture",
                            "purpose": "persists the current capture into encrypted PKM storage.",
                            "action_id": "profile.pkm.save_capture",
                            "role": "button",
                            "voice_aliases": ["save pkm capture", "save pkm"],
                        }
                    ],
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert response["message"] == (
        "Save PKM capture persists the current capture into encrypted PKM storage."
    )


@pytest.mark.anyio
async def test_plan_voice_response_explains_current_section_from_surface_definition(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Explain this section",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile/receipts", "screen": "profile_receipts"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/receipts",
                    "screen": "profile_receipts",
                },
                "ui": {
                    "active_section": "Receipt memory",
                },
                "surface": {
                    "screen_id": "profile_receipts",
                    "title": "Gmail receipts",
                    "purpose": "This page manages Gmail receipt sync and receipt-memory import into PKM.",
                    "sections": [
                        {
                            "id": "receipt_memory",
                            "title": "Receipt memory",
                            "purpose": "This section previews and saves the compact receipt snapshot before it reaches PKM.",
                        }
                    ],
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "Receipt memory" in response["message"]
    assert "compact receipt snapshot" in response["message"]


@pytest.mark.anyio
async def test_plan_voice_response_explains_receipts_screen_with_surface_purpose(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="What is this screen?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile/receipts", "screen": "profile_receipts"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/receipts",
                    "screen": "profile_receipts",
                },
                "surface": {
                    "screen_id": "profile_receipts",
                    "title": "Gmail receipts",
                    "purpose": "This page manages Gmail receipt sync, backfill state, stored receipts, and receipt-memory import into PKM.",
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "backfill state" in response["message"]
    assert "receipt-memory import into PKM" in response["message"]


@pytest.mark.anyio
async def test_plan_voice_response_open_gmail_is_deterministic(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for Gmail navigation intents")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="Open Gmail",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert response["message"] == "Opening Gmail."
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_explains_control_with_deterministic_knowledge(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for deterministic control explain")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="What does Save receipts memory to PKM do?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile/receipts", "screen": "profile_receipts"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/receipts",
                    "screen": "profile_receipts",
                },
                "ui": {
                    "active_section": "Receipt memory preview",
                    "available_actions": ["Save receipts memory to PKM"],
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert response["execution_allowed"] is False
    assert "writes the current receipts-memory preview" in response["message"].lower()
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_explains_global_product_concept_deterministically(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for deterministic product knowledge")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="What is PKM?",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert response["execution_allowed"] is False
    assert "encrypted personal memory layer" in response["message"].lower()
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_who_are_you_describes_kai_in_app_voice_interface(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for deterministic identity explain")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="Who are you?",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert "voice assistant" in response["message"].lower()
    assert "kai app" in response["message"].lower()
    assert response["mode"] == "answer_now"
    assert response["action_id"] is None
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_what_can_you_do_here_uses_screen_actions(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for deterministic capability explain")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="What can you do here?",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile",
                    "screen": "profile_account",
                },
                "ui": {
                    "available_actions": ["Open Gmail", "Open receipts", "Open PKM Agent Lab"],
                },
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert "you are on the profile screen" in response["message"].lower()
    assert "open gmail" in response["message"].lower()
    assert response["mode"] == "answer_now"
    assert response["action_id"] is None
    assert openai_http_ms == 0
    assert model == "deterministic"


@pytest.mark.anyio
async def test_plan_voice_response_explains_local_receipts_concept_deterministically(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for deterministic local concept explain")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="Explain merchant affinity",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile/receipts", "screen": "profile_receipts"}),
        context={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile/receipts",
                    "screen": "profile_receipts",
                }
            }
        },
    )

    assert response["kind"] == "speak_only"
    assert response["execution_allowed"] is False
    assert "merchant affinity" in response["message"].lower()
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
    assert response["action_id"] == "route.kai_optimize"


@pytest.mark.anyio
async def test_plan_voice_response_uses_specific_execute_message_for_llm_navigation(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _fake_llm(*args, **kwargs):
        return (
            {"tool_name": "execute_kai_command", "args": {"command": "profile"}},
            4,
            "fake-model",
        )

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _fake_llm)

    response, openai_http_ms, model = await voice_service.plan_voice_response(
        transcript="show me my account area",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["message"] == "Opening profile."
    assert openai_http_ms == 4
    assert model == "fake-model"


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
    assert response["message"] == _VOICE_ENGLISH_ONLY_INPUT_MESSAGE


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
async def test_plan_voice_response_analyze_misspelled_alias_executes(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Please start the analysis of nvida stock for me.",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["action_id"] == "analysis.start"
    assert response["tool_call"]["tool_name"] == "execute_kai_command"
    assert response["tool_call"]["args"]["command"] == "analyze"
    assert response["tool_call"]["args"]["params"]["symbol"] == "NVDA"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "transcript",
    [
        "Take me to the analysis section",
        "Open analysis",
    ],
)
async def test_plan_voice_response_analysis_navigation_executes(
    voice_service: VoiceIntentService,
    transcript: str,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript=transcript,
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["action_id"] == "route.analysis_history"
    assert response["mode"] == "execute_and_wait"
    assert response["tool_call"] == {
        "tool_name": "execute_kai_command",
        "args": {"command": "history"},
    }


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


@pytest.mark.anyio
async def test_synthesize_speech_buffers_streaming_handle(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    stream = _FakeTTSStream([b"ab", b"c"])

    async def _fake_open_tts_stream(*args, **kwargs):
        return stream, "audio/mpeg", stream.meta

    monkeypatch.setattr(voice_service, "open_tts_stream", _fake_open_tts_stream)

    audio_bytes, mime_type, meta = await voice_service.synthesize_speech(
        text="hello world",
        voice="alloy",
    )

    assert audio_bytes == b"abc"
    assert mime_type == "audio/mpeg"
    assert meta["audio_bytes"] == 3
    assert stream.closed is True


@pytest.mark.anyio
async def test_open_tts_stream_sends_english_only_instructions(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        headers = {"content-length": "0"}
        content = b""

        async def aiter_bytes(self):
            if False:  # pragma: no cover - keeps this as an async generator
                yield b""

        async def aclose(self):
            captured["response_closed"] = True

    class _FakeStreamContext:
        async def __aenter__(self):
            return _FakeResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return None

    class _FakeAsyncClient:
        def __init__(self, *, timeout):
            captured["timeout"] = timeout

        def stream(self, method, url, *, headers, json):
            captured["method"] = method
            captured["url"] = url
            captured["json"] = json
            return _FakeStreamContext()

        async def aclose(self):
            captured["closed"] = True

    monkeypatch.setattr(voice_intent_service_module.httpx, "AsyncClient", _FakeAsyncClient)

    stream, mime_type, meta = await voice_service.open_tts_stream(
        text="hello world",
        voice="alloy",
    )

    assert mime_type == "audio/mpeg"
    assert meta["model"] == "gpt-4o-mini-tts"
    assert captured["json"]["instructions"] == _VOICE_TTS_INSTRUCTIONS
    assert captured["json"]["input"] == "hello world"
    await stream.aclose()


def test_voice_tool_policy_whitelist_excludes_destructive_actions():
    assert "delete_account" not in _ALLOWED_TOOL_NAMES
    assert "delete_imported_data" not in _ALLOWED_TOOL_NAMES
    assert "delete_account" not in _ALLOWED_COMMANDS
    assert "delete_imported_data" not in _ALLOWED_COMMANDS


def test_voice_planner_prompt_includes_kai_app_identity_and_manifest_actions():
    planner_context = build_voice_planner_context(
        transcript="open profile",
        runtime_state=_app_state()["runtime"],
        context_payload={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile",
                    "screen": "profile_account",
                },
                "surface": {
                    "screen_id": "profile_account",
                    "controls": [
                        {"id": "gmail", "label": "Gmail", "action_id": "route.profile_gmail_panel"},
                        {"id": "pkm", "label": "PKM", "action_id": "route.profile_pkm_agent_lab"},
                    ],
                },
            }
        },
    )

    prompt = build_voice_planner_system_prompt(planner_context=planner_context)

    assert "Kai is the app" in prompt
    assert "voice assistant" in prompt.lower()
    assert "route.profile" in prompt
    assert "Relevant Manifest Actions" in prompt
    assert "Core Capabilities" in prompt
    assert "manual_only" in prompt
    assert "Language Policy" in prompt
    assert "English-language transcripts only" in prompt
    assert "English only" in prompt


def test_voice_response_composer_prompt_includes_identity_and_execution_grounding():
    composer_context = build_voice_response_composer_context(
        transcript="Take me to my profile",
        runtime_state=_app_state()["runtime"],
        context_payload={
            "structured_screen_context": {
                "route": {
                    "pathname": "/profile",
                    "screen": "profile_account",
                },
                "surface": {
                    "screen_id": "profile_account",
                    "title": "Profile",
                    "purpose": "Manage your investor identity and connected data.",
                    "actions": [
                        {
                            "id": "open_gmail",
                            "label": "Open Gmail",
                            "action_id": "route.profile_gmail_panel",
                        }
                    ],
                },
            }
        },
        plan_payload={
            "mode": "execute_and_wait",
            "action_id": "route.profile",
            "slots": {},
            "guards": [],
            "reply_strategy": "llm",
        },
        response_payload={
            "kind": "execute",
            "message": "Opening profile.",
            "execution_allowed": True,
        },
        action_result={
            "status": "succeeded",
            "action_id": "route.profile",
            "route_after": "/profile",
            "screen_after": "profile_account",
            "result_summary": "Opened your profile.",
        },
    )

    prompt = build_voice_response_composer_system_prompt(composer_context=composer_context)

    assert "voice assistant inside the Kai app" in prompt
    assert "execution result is authoritative" in prompt
    assert "Return JSON only" in prompt
    assert "route.profile" in prompt
    assert "profile_account" in prompt
    assert "Language Policy" in prompt
    assert "spoken reply must be English only" in prompt


@pytest.mark.anyio
async def test_compose_voice_reply_uses_llm_json_result(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    class _FakeResponse:
        status_code = 200

    async def _fake_post_with_model_fallback(**kwargs):
        return (
            _FakeResponse(),
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "text": "You're on Profile now. Manage your investor identity and connected data here.",
                                    "segment_type": "final",
                                }
                            )
                        }
                    }
                ]
            },
            14,
            "gpt-4o-mini",
        )

    monkeypatch.setattr(
        voice_intent_service_module,
        "_post_with_model_fallback",
        _fake_post_with_model_fallback,
    )

    composed, openai_http_ms, model_used = await voice_service.compose_voice_reply(
        transcript="Take me to profile",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={},
        plan_payload={
            "mode": "execute_and_wait",
            "action_id": "route.profile",
            "slots": {},
            "guards": [],
            "reply_strategy": "llm",
        },
        response_payload={
            "kind": "execute",
            "message": "Opening profile.",
            "execution_allowed": True,
        },
        action_result={
            "status": "succeeded",
            "action_id": "route.profile",
            "route_after": "/profile",
            "screen_after": "profile_account",
            "result_summary": "Opened your profile.",
        },
    )

    assert composed == {
        "text": "You're on Profile now. Manage your investor identity and connected data here.",
        "segment_type": "final",
    }
    assert openai_http_ms == 14
    assert model_used == "gpt-4o-mini"


@pytest.mark.anyio
async def test_plan_voice_response_open_gmail_sets_canonical_navigation_contract(
    voice_service: VoiceIntentService,
    monkeypatch: pytest.MonkeyPatch,
):
    async def _llm_should_not_run(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("LLM planner should not run for Gmail navigation intents")

    monkeypatch.setattr(voice_service, "_plan_intent_with_llm_v1", _llm_should_not_run)

    response, _, _ = await voice_service.plan_voice_response(
        transcript="Open Gmail",
        user_id="user_a",
        app_state=_app_state(route={"pathname": "/profile", "screen": "profile_account"}),
        context={},
    )

    assert response["kind"] == "speak_only"
    assert response["execution_allowed"] is True
    assert response["schema_version"] == "kai_voice_plan.v1"
    assert response["mode"] == "execute_and_wait"
    assert response["action_id"] == "route.profile_gmail_panel"
    assert response["reply_strategy"] == "llm"
    assert response["guards"] == []
    assert response.get("tool_call") is None


@pytest.mark.anyio
async def test_plan_voice_response_go_back_sets_manifest_back_contract(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="go back",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["execution_allowed"] is True
    assert response["schema_version"] == "kai_voice_plan.v1"
    assert response["mode"] == "execute_and_wait"
    assert response["action_id"] == "route.back"
    assert response["action_completion"] == "route_settle"
    assert response["tool_call"] == {"tool_name": "navigate_back", "args": {}}


@pytest.mark.anyio
async def test_plan_voice_response_analyze_google_sets_background_action_contract(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Analyze google",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["kind"] == "execute"
    assert response["schema_version"] == "kai_voice_plan.v1"
    assert response["mode"] == "start_background_and_ack"
    assert response["action_id"] == "analysis.start"
    assert response["slots"]["command"] == "analyze"
    assert response["slots"]["symbol"] == "GOOGL"
    assert response["reply_strategy"] == "llm"
    assert response["guards"] == ["analysis_idle_required"]


@pytest.mark.anyio
async def test_plan_voice_response_analyze_still_executes_when_portfolio_is_missing(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Analyze google",
        user_id="user_a",
        app_state={**_app_state(), "portfolio": {"has_portfolio_data": False}},
        context={},
    )

    assert response["kind"] == "execute"
    assert response["execution_allowed"] is True
    assert response["mode"] == "start_background_and_ack"
    assert response["action_id"] == "analysis.start"
    assert response["guards"] == ["analysis_idle_required"]
    assert response["memory"]["allow_durable_write"] is True


@pytest.mark.anyio
async def test_plan_voice_response_analysis_navigation_still_executes_when_portfolio_is_missing(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="Take me to analysis",
        user_id="user_a",
        app_state={**_app_state(), "portfolio": {"has_portfolio_data": False}},
        context={},
    )

    assert response["kind"] == "execute"
    assert response["action_id"] == "route.analysis_history"
    assert response["execution_allowed"] is True
    assert response["mode"] == "execute_and_wait"
    assert response["guards"] == []


@pytest.mark.anyio
async def test_plan_voice_response_cancel_active_analysis_requires_manual_confirmation(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="cancel analysis",
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

    assert response["kind"] == "speak_only"
    assert response["reason"] == "manual_user_execution_required"
    assert "on-screen confirmation" in response["message"].lower()
    assert response["execution_allowed"] is False
    assert response["mode"] == "answer_now"
    assert response["action_id"] == "analysis.cancel_active"
    assert response["memory"]["allow_durable_write"] is False
    assert response.get("tool_call") is None


@pytest.mark.anyio
async def test_plan_voice_response_blank_transcript_sets_clarification_contract(
    voice_service: VoiceIntentService,
):
    response, _, _ = await voice_service.plan_voice_response(
        transcript="   ",
        user_id="user_a",
        app_state=_app_state(),
        context={},
    )

    assert response["mode"] == "clarify"
    assert response["action_id"] is None
    assert response["clarification"] == {
        "reason": "stt_unusable",
        "question": _UNCLEAR_STT_MESSAGE,
    }
