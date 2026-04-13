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
                            "action_id": "nav.profile_receipts",
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
    assert "receipt sync" in response["message"].lower()
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
                            "action_id": "nav.profile_pkm_agent_lab",
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


def test_voice_tool_policy_whitelist_excludes_destructive_actions():
    assert "delete_account" not in _ALLOWED_TOOL_NAMES
    assert "delete_imported_data" not in _ALLOWED_TOOL_NAMES
    assert "delete_account" not in _ALLOWED_COMMANDS
    assert "delete_imported_data" not in _ALLOWED_COMMANDS
