from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

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

    class _DatabaseExecutionError(Exception):  # pragma: no cover - import-time stub only
        pass

    def _noop_get_db():  # pragma: no cover - import-time stub only
        raise RuntimeError("db not available in unit test")

    db_client_stub.get_db = _noop_get_db
    db_client_stub.DatabaseExecutionError = _DatabaseExecutionError
    sys.modules["db.db_client"] = db_client_stub

if "db.connection" not in sys.modules:
    db_conn_stub = types.ModuleType("db.connection")

    async def _noop_get_pool():  # pragma: no cover - import-time stub only
        return None

    db_conn_stub.get_pool = _noop_get_pool
    sys.modules["db.connection"] = db_conn_stub

if "google" not in sys.modules:
    sys.modules["google"] = types.ModuleType("google")
if "google.genai" not in sys.modules:
    sys.modules["google.genai"] = types.ModuleType("google.genai")
if "google.genai.types" not in sys.modules:
    sys.modules["google.genai.types"] = types.ModuleType("google.genai.types")
sys.modules["google"].genai = sys.modules["google.genai"]
sys.modules["google.genai"].types = sys.modules["google.genai.types"]

if "sse_starlette" not in sys.modules:
    sys.modules["sse_starlette"] = types.ModuleType("sse_starlette")
if "sse_starlette.sse" not in sys.modules:
    sse_mod = types.ModuleType("sse_starlette.sse")

    class _EventSourceResponse:  # pragma: no cover - import-time stub only
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

    sse_mod.EventSourceResponse = _EventSourceResponse
    sys.modules["sse_starlette.sse"] = sse_mod

if "python_multipart" not in sys.modules:
    python_multipart_stub = types.ModuleType("python_multipart")
    python_multipart_stub.__version__ = "0.0.20"
    sys.modules["python_multipart"] = python_multipart_stub

ROOT = Path(__file__).resolve().parents[1]
if "api.routes.kai" not in sys.modules:
    kai_pkg = types.ModuleType("api.routes.kai")
    kai_pkg.__path__ = [str(ROOT / "api" / "routes" / "kai")]
    sys.modules["api.routes.kai"] = kai_pkg

if "api.routes.kai.stream" not in sys.modules:
    stream_stub = types.ModuleType("api.routes.kai.stream")

    class _StubRunManager:
        async def get_run(self, run_id: str):
            return None

    stream_stub._RUN_MANAGER = _StubRunManager()
    sys.modules["api.routes.kai.stream"] = stream_stub

if "api.routes.kai.portfolio" not in sys.modules:
    portfolio_stub = types.ModuleType("api.routes.kai.portfolio")

    class _StubImportRunManager:
        async def get_run(self, run_id: str):
            return None

    portfolio_stub._IMPORT_RUN_MANAGER = _StubImportRunManager()
    sys.modules["api.routes.kai.portfolio"] = portfolio_stub

from api.routes.kai.voice import router as voice_router  # noqa: E402

VOICE_ROUTES = sys.modules["api.routes.kai.voice"]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _set_voice_runtime_config(monkeypatch: pytest.MonkeyPatch, **overrides) -> None:
    raw = os.getenv("VOICE_RUNTIME_CONFIG_JSON", "").strip()
    payload = {}
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {}
        if isinstance(parsed, dict):
            payload = dict(parsed)
    payload.update(overrides)
    monkeypatch.setenv("VOICE_RUNTIME_CONFIG_JSON", json.dumps(payload))


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(voice_router, prefix="/api/kai")
    return TestClient(app)


def _plan_body() -> dict:
    return {
        "user_id": "user_a",
        "transcript": "open dashboard",
        "app_state": {
            "auth": {"signed_in": True, "user_id": "user_a"},
            "vault": {"unlocked": True, "token_available": True, "token_valid": True},
            "route": {"pathname": "/kai", "screen": "home", "subview": None},
            "runtime": {
                "analysis_active": False,
                "analysis_ticker": None,
                "analysis_run_id": None,
                "import_active": False,
                "import_run_id": None,
                "busy_operations": [],
            },
            "portfolio": {"has_portfolio_data": True},
            "voice": {"available": True, "tts_playing": False},
        },
    }


def _realtime_session_body() -> dict:
    return {
        "user_id": "user_a",
        "voice": "alloy",
    }


class _FakeRequest:
    def __init__(
        self,
        headers: dict[str, str] | None = None,
        *,
        disconnect_after_calls: int | None = None,
    ) -> None:
        self.headers = headers or {}
        self._disconnect_after_calls = disconnect_after_calls
        self._disconnect_checks = 0

    async def is_disconnected(self) -> bool:
        self._disconnect_checks += 1
        if self._disconnect_after_calls is None:
            return False
        return self._disconnect_checks > self._disconnect_after_calls


class _ChunkedUploadFile:
    def __init__(
        self,
        *,
        chunks: list[bytes],
        filename: str = "voice.webm",
        content_type: str = "audio/webm",
    ) -> None:
        self._chunks = list(chunks)
        self.filename = filename
        self.content_type = content_type

    async def read(self, size: int = -1) -> bytes:
        if not self._chunks:
            return b""
        if size is None or size < 0:
            data = b"".join(self._chunks)
            self._chunks.clear()
            return data
        chunk = self._chunks.pop(0)
        if len(chunk) > size:
            self._chunks.insert(0, chunk[size:])
            return chunk[:size]
        return chunk


class _GuardedUploadFile:
    def __init__(self) -> None:
        self.filename = "voice.webm"
        self.content_type = "audio/webm"
        self.read_called = False

    async def read(self, size: int = -1) -> bytes:
        self.read_called = True
        raise AssertionError("audio_file.read should not be called")


class _FakeTTSStream:
    def __init__(
        self,
        chunks: list[bytes],
        *,
        model: str = "gpt-4o-mini-tts",
        voice: str = "alloy",
        format_: str = "mp3",
        content_length: int | None = None,
        openai_http_ms: int = 12,
    ) -> None:
        self._chunks = list(chunks)
        self.read_calls = 0
        self.closed = False
        self.meta = {
            "model": model,
            "voice": voice,
            "format": format_,
            "source": "backend_openai_audio",
            "attempts": [
                {
                    "model": model,
                    "status_code": 200,
                    "elapsed_ms": openai_http_ms,
                    "result": "success",
                }
            ],
            "openai_http_ms": openai_http_ms,
            "audio_bytes": 0,
            "content_length": content_length,
            "completed": False,
            "aborted": False,
        }

    async def read_next_chunk(self) -> bytes | None:
        self.read_calls += 1
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


def test_voice_plan_respects_rollout_allowlist(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_b"],
        canary_percent=100,
        tool_execution_disabled=False,
    )

    called = {"value": False}

    async def _never_called(*args, **kwargs):
        called["value"] = True
        return (
            {
                "kind": "execute",
                "message": "Opening dashboard.",
                "speak": True,
                "tool_call": {"tool_name": "execute_kai_command", "args": {"command": "dashboard"}},
                "memory": {"allow_durable_write": True},
            },
            0,
            "fake",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _never_called)

    response = client.post(
        "/api/kai/voice/plan",
        json=_plan_body(),
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["response"]["kind"] == "speak_only"
    assert payload["response"]["message"] == "Voice is not enabled for this account yet."
    assert payload["response"]["execution_allowed"] is False
    assert payload["execution_allowed"] is False
    assert payload["memory"]["allow_durable_write"] is False
    assert called["value"] is False


def test_voice_plan_surfaces_canonical_fields_alongside_legacy_contract(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        canary_percent=100,
        tool_execution_disabled=False,
    )

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "speak_only",
                "message": "Opening Gmail.",
                "speak": True,
                "execution_allowed": True,
                "memory": {"allow_durable_write": True},
                "schema_version": "kai_voice_plan.v1",
                "mode": "execute_and_wait",
                "action_id": "nav.profile_gmail_panel",
                "slots": {},
                "guards": [],
                "reply_strategy": "llm",
            },
            4,
            "deterministic",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = client.post(
        "/api/kai/voice/plan",
        json={**_plan_body(), "transcript": "open gmail"},
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["response"]["kind"] == "speak_only"
    assert payload["response"]["execution_allowed"] is True
    assert payload["execution_allowed"] is True
    assert payload["schema_version"] == "kai_voice_plan.v1"
    assert payload["mode"] == "execute_and_wait"
    assert payload["action_id"] == "nav.profile_gmail_panel"
    assert payload["reply_strategy"] == "llm"
    assert payload["guards"] == []
    assert payload["tool_call"]["tool_name"] == "clarify"
    assert payload["intent"]["name"] == "execute_and_wait"
    assert payload["intent"]["legacy_kind"] == "speak_only"
    assert payload["action"]["type"] == "canonical"
    assert payload["action"]["payload"]["action_id"] == "nav.profile_gmail_panel"
    assert payload["action"]["payload"]["mode"] == "execute_and_wait"
    assert payload["action"]["payload"].get("legacy_tool_call") is None


def test_voice_plan_kill_switch_downgrades_canonical_only_execute_and_wait(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=True,
    )

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "speak_only",
                "message": "Opening Gmail.",
                "speak": True,
                "execution_allowed": True,
                "memory": {"allow_durable_write": True},
                "schema_version": "kai_voice_plan.v1",
                "mode": "execute_and_wait",
                "action_id": "nav.profile_gmail_panel",
                "slots": {},
                "guards": [],
                "reply_strategy": "llm",
            },
            2,
            "deterministic",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = client.post(
        "/api/kai/voice/plan",
        json={**_plan_body(), "transcript": "open gmail"},
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["response"]["kind"] == "speak_only"
    assert payload["response"]["execution_allowed"] is False
    assert payload["execution_allowed"] is False
    assert payload["response"]["message"] == (
        "Voice actions are temporarily unavailable. I can still respond and guide you."
    )
    assert payload["mode"] == "answer_now"
    assert payload["action_id"] is None
    assert payload["tool_call"]["tool_name"] == "clarify"
    assert payload["action"]["type"] == "none"


def test_voice_plan_manual_only_response_strips_stale_executable_tool_call(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=False,
    )

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "speak_only",
                "message": "Kai can cancel the active analysis, but this step still needs the on-screen confirmation.",
                "speak": True,
                "execution_allowed": False,
                "reason": "manual_user_execution_required",
                "tool_call": {"tool_name": "cancel_active_analysis", "args": {"confirm": True}},
                "memory": {"allow_durable_write": False},
                "schema_version": "kai_voice_plan.v1",
                "mode": "answer_now",
                "action_id": "analysis.cancel_active",
                "slots": {},
                "guards": [
                    "active_analysis_required",
                    "explicit_user_confirmation",
                    "manual_user_execution",
                ],
                "reply_strategy": "llm",
            },
            3,
            "deterministic",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = client.post(
        "/api/kai/voice/plan",
        json={**_plan_body(), "transcript": "cancel analysis"},
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["response"]["kind"] == "speak_only"
    assert payload["response"]["execution_allowed"] is False
    assert payload["response"]["tool_call"] is None
    assert payload["tool_call"]["tool_name"] == "clarify"
    assert payload["needs_confirmation"] is False
    assert payload["action"]["type"] == "canonical"
    assert payload["action"]["payload"]["action_id"] == "analysis.cancel_active"
    assert payload["action"]["payload"].get("legacy_tool_call") is None


def test_voice_realtime_session_respects_rollout_allowlist(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_b"],
        canary_percent=100,
    )

    called = {"value": False}

    async def _never_called(*args, **kwargs):
        called["value"] = True
        return {}

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "create_realtime_session", _never_called)

    response = client.post(
        "/api/kai/voice/realtime/session",
        json=_realtime_session_body(),
        headers=_auth(token),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Voice is not enabled for this account yet."
    assert called["value"] is False


def test_voice_realtime_session_allows_rollout_included_user(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
    )

    async def _fake_session(*args, **kwargs):
        return {
            "session_id": "sess_123",
            "client_secret": "ephemeral_secret",
            "client_secret_expires_at": 2_000_000_000,
            "model": "gpt-realtime",
            "voice": "alloy",
            "server_vad_enabled": True,
            "silence_duration_ms": 800,
            "auto_response_enabled": False,
            "barge_in_enabled": True,
        }

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "create_realtime_session", _fake_session)

    response = client.post(
        "/api/kai/voice/realtime/session",
        json=_realtime_session_body(),
        headers={**_auth(token), "X-Voice-Turn-Id": "vturn_test_realtime_001"},
    )
    payload = response.json()

    assert response.status_code == 200
    assert response.headers.get("X-Voice-Turn-Id") == "vturn_test_realtime_001"
    assert payload["session_id"] == "sess_123"
    assert payload["model"] == "gpt-realtime"
    assert payload["voice"] == "alloy"
    assert payload["client_secret"] == "ephemeral_secret"  # noqa: S105


def test_voice_capability_reports_rollout_and_execution_state(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=True,
    )

    response = client.post(
        "/api/kai/voice/capability",
        json={"user_id": "user_a"},
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["voice_enabled"] is True
    assert payload["execution_allowed"] is False
    assert payload["tool_execution_disabled"] is True
    assert payload["tts_timeout_ms"] == 20000
    assert payload["tts_model"] == VOICE_ROUTES.voice_service.tts_model


def test_voice_plan_respects_canary_percent(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=[],
        canary_percent=0,
        tool_execution_disabled=False,
    )

    async def _should_not_run(*args, **kwargs):
        raise AssertionError("planner should not run when user is excluded by canary")

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _should_not_run)

    response = client.post(
        "/api/kai/voice/plan",
        json=_plan_body(),
        headers=_auth(token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response"]["kind"] == "speak_only"
    assert payload["response"]["message"] == "Voice is not enabled for this account yet."
    assert payload["response"]["execution_allowed"] is False
    assert payload["execution_allowed"] is False


@pytest.mark.anyio
async def test_voice_stt_rollout_blocks_before_audio_read(monkeypatch: pytest.MonkeyPatch):
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_b"],
    )
    guarded_upload = _GuardedUploadFile()

    async def _never_transcribe(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("transcribe_audio should not run for rollout-blocked STT requests")

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "transcribe_audio", _never_transcribe)

    with pytest.raises(HTTPException) as exc_info:
        await VOICE_ROUTES.kai_voice_stt(
            request=_FakeRequest(),
            http_response=Response(),
            user_id="user_a",
            audio_file=guarded_upload,
            audio_mime_type="audio/webm",
            token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Voice is not enabled for this account yet."
    assert guarded_upload.read_called is False


@pytest.mark.anyio
async def test_voice_understand_rollout_blocks_before_audio_read(monkeypatch: pytest.MonkeyPatch):
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_b"],
    )
    guarded_upload = _GuardedUploadFile()

    async def _never_transcribe(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("transcribe_audio should not be called for rollout-blocked requests")

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "transcribe_audio", _never_transcribe)

    response = await VOICE_ROUTES.kai_voice_understand(
        request=_FakeRequest(),
        http_response=Response(),
        user_id="user_a",
        audio_file=guarded_upload,
        audio_mime_type="audio/webm",
        context_json=None,
        app_state_json=None,
        token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
    )

    assert guarded_upload.read_called is False
    assert response.transcript == ""
    assert response.stt_elapsed_ms == 0
    assert response.stt_openai_http_ms == 0
    assert response.stt_audio_read_ms == 0
    assert response.stt_audio_bytes == 0
    assert response.response.kind == "speak_only"
    assert response.response.message == "Voice is not enabled for this account yet."
    assert response.response.execution_allowed is False
    assert response.execution_allowed is False
    assert response.memory.allow_durable_write is False
    assert response.model == "deterministic_rollout"


def test_voice_tts_rollout_blocks_before_upstream_call(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_b"],
    )

    async def _never_tts(*args, **kwargs):
        raise AssertionError("open_tts_stream should not run for rollout-blocked TTS requests")

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "open_tts_stream", _never_tts)

    response = client.post(
        "/api/kai/voice/tts",
        json={"user_id": "user_a", "text": "hello"},
        headers=_auth(token),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Voice is not enabled for this account yet."


@pytest.mark.anyio
async def test_voice_understand_sanitizes_debug_message_in_error_response(
    monkeypatch: pytest.MonkeyPatch,
):
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
    )
    upload = _ChunkedUploadFile(chunks=[b"\x1a\x45\xdf\xa3voice-bytes"])

    async def _raise_stt_error(*args, **kwargs):
        raise VOICE_ROUTES.VoiceServiceError(502, "raw upstream detail: secret-token")

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "transcribe_audio", _raise_stt_error)

    with pytest.raises(HTTPException) as exc_info:
        await VOICE_ROUTES.kai_voice_understand(
            request=_FakeRequest(),
            http_response=Response(),
            user_id="user_a",
            audio_file=upload,
            audio_mime_type="audio/webm",
            context_json=None,
            app_state_json=None,
            token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
        )

    detail = exc_info.value.detail
    assert exc_info.value.status_code == 502
    assert detail["error_code"] == "stt_upstream_error"
    assert detail["message"] == "Speech recognition failed. Please try again."
    assert "debug_message" not in detail


@pytest.mark.anyio
async def test_voice_understand_kill_switch_downgrades_execute_to_speak_only(
    monkeypatch: pytest.MonkeyPatch,
):
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=True,
    )
    upload = _ChunkedUploadFile(chunks=[b"\x1a\x45\xdf\xa3voice-bytes"])

    async def _fake_transcribe(*args, **kwargs):
        return ("open dashboard", 3, "gpt-4o-mini-transcribe")

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "execute",
                "message": "Opening dashboard.",
                "speak": True,
                "execution_allowed": True,
                "tool_call": {"tool_name": "execute_kai_command", "args": {"command": "dashboard"}},
                "memory": {"allow_durable_write": True},
            },
            5,
            "fake-model",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "transcribe_audio", _fake_transcribe)
    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = await VOICE_ROUTES.kai_voice_understand(
        request=_FakeRequest(),
        http_response=Response(),
        user_id="user_a",
        audio_file=upload,
        audio_mime_type="audio/webm",
        context_json=None,
        app_state_json=None,
        token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
    )

    assert response.response.kind == "speak_only"
    assert response.response.execution_allowed is False
    assert response.execution_allowed is False
    assert response.tool_call["tool_name"] == "clarify"
    assert response.memory.allow_durable_write is False


@pytest.mark.anyio
async def test_voice_stt_rejects_oversized_content_length_before_audio_read(
    monkeypatch: pytest.MonkeyPatch,
):
    _set_voice_runtime_config(monkeypatch, upload_max_bytes=1024 * 1024)
    guarded_upload = _GuardedUploadFile()

    with pytest.raises(HTTPException) as exc_info:
        await VOICE_ROUTES.kai_voice_stt(
            request=_FakeRequest(headers={"content-length": str(2 * 1024 * 1024)}),
            http_response=Response(),
            user_id="user_a",
            audio_file=guarded_upload,
            audio_mime_type="audio/webm",
            token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
        )

    detail = exc_info.value.detail
    assert exc_info.value.status_code == 413
    assert guarded_upload.read_called is False
    assert detail["error_code"] == "audio_too_large"
    assert "debug_message" not in detail


@pytest.mark.anyio
async def test_voice_understand_rejects_oversized_audio_during_read(
    monkeypatch: pytest.MonkeyPatch,
):
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        upload_max_bytes=1024 * 1024,
    )
    upload = _ChunkedUploadFile(chunks=[b"1" * 600000, b"2" * 600000])

    async def _never_transcribe(*args, **kwargs):  # pragma: no cover - safety assertion
        raise AssertionError("transcribe_audio should not run after upload size rejection")

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "transcribe_audio", _never_transcribe)

    with pytest.raises(HTTPException) as exc_info:
        await VOICE_ROUTES.kai_voice_understand(
            request=_FakeRequest(),
            http_response=Response(),
            user_id="user_a",
            audio_file=upload,
            audio_mime_type="audio/webm",
            context_json=None,
            app_state_json=None,
            token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
        )

    detail = exc_info.value.detail
    assert exc_info.value.status_code == 413
    assert detail["error_code"] == "audio_too_large"
    assert detail["message"].startswith("Audio upload is too large")
    assert "debug_message" not in detail


def test_voice_plan_prefers_run_manager_truth_over_stale_runtime_flag(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
    )

    async def _no_active_run(run_id: str):
        return None

    monkeypatch.setattr(VOICE_ROUTES._RUN_MANAGER, "get_run", _no_active_run)

    response = client.post(
        "/api/kai/voice/plan",
        json={
            **_plan_body(),
            "transcript": "analyze google",
            "app_state": {
                **_plan_body()["app_state"],
                "runtime": {
                    "analysis_active": True,
                    "analysis_ticker": "NVDA",
                    "analysis_run_id": "stale_run",
                    "import_active": False,
                    "import_run_id": None,
                    "busy_operations": [],
                },
            },
        },
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["response"]["kind"] == "execute"
    assert payload["response"]["execution_allowed"] is True
    assert payload["execution_allowed"] is True
    assert payload["tool_call"]["tool_name"] == "execute_kai_command"
    assert payload["tool_call"]["args"]["command"] == "analyze"
    assert payload["tool_call"]["args"]["params"]["symbol"] == "GOOGL"


def test_voice_plan_kill_switch_downgrades_execute_to_speak_only(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=True,
    )

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "execute",
                "message": "Opening dashboard.",
                "speak": True,
                "tool_call": {"tool_name": "execute_kai_command", "args": {"command": "dashboard"}},
                "memory": {"allow_durable_write": True},
            },
            7,
            "fake-model",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = client.post(
        "/api/kai/voice/plan",
        json=_plan_body(),
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["response"]["kind"] == "speak_only"
    assert payload["response"]["execution_allowed"] is False
    assert payload["execution_allowed"] is False
    assert (
        payload["response"]["message"]
        == "Voice actions are temporarily unavailable. I can still respond and guide you."
    )
    assert payload["memory"]["allow_durable_write"] is False
    assert payload["tool_call"]["tool_name"] == "clarify"


def test_voice_plan_marks_analysis_start_as_long_running_from_canonical_mode(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=False,
    )

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "execute",
                "message": "Starting analysis for GOOGL.",
                "speak": True,
                "execution_allowed": True,
                "tool_call": {
                    "tool_name": "execute_kai_command",
                    "args": {"command": "analyze", "params": {"symbol": "GOOGL"}},
                },
                "memory": {"allow_durable_write": True},
                "schema_version": "kai_voice_plan.v1",
                "mode": "start_background_and_ack",
                "action_id": "analysis.start",
                "slots": {"command": "analyze", "symbol": "GOOGL"},
                "guards": ["analysis_idle_required"],
                "reply_strategy": "llm",
            },
            5,
            "deterministic",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = client.post(
        "/api/kai/voice/plan",
        json={**_plan_body(), "transcript": "analyze google"},
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["mode"] == "start_background_and_ack"
    assert payload["is_long_running"] is True
    assert payload["ack_text"] == "Starting analysis for GOOGL."
    assert payload["final_text"] == "Starting analysis for GOOGL."
    assert payload["execution_allowed"] is True
    assert payload["tool_call"]["tool_name"] == "execute_kai_command"


def test_voice_compose_returns_backend_llm_spoken_reply(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")

    async def _fake_compose(*args, **kwargs):
        return (
            {
                "text": "You're on Profile now. Manage your investor identity and connected data here.",
                "segment_type": "final",
            },
            9,
            "gpt-4o-mini",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "compose_voice_reply", _fake_compose)

    response = client.post(
        "/api/kai/voice/compose",
        json={
            "user_id": "user_a",
            "transcript": "take me to profile",
            "response": {
                "kind": "execute",
                "message": "Opening profile.",
                "speak": True,
                "execution_allowed": True,
            },
            "app_state": _plan_body()["app_state"],
            "mode": "execute_and_wait",
            "action_id": "nav.profile",
            "reply_strategy": "llm",
            "action_result": {
                "status": "succeeded",
                "action_id": "nav.profile",
                "route_after": "/profile",
                "screen_after": "profile_account",
                "result_summary": "Opened your profile.",
            },
        },
        headers=_auth(token),
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["text"] == (
        "You're on Profile now. Manage your investor identity and connected data here."
    )
    assert payload["segment_type"] == "final"
    assert payload["openai_http_ms"] == 9
    assert payload["model"] == "gpt-4o-mini"


def test_voice_plan_echoes_voice_turn_id_header(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
        tool_execution_disabled=False,
    )

    async def _fake_plan(*args, **kwargs):
        return (
            {
                "kind": "speak_only",
                "message": "No active analysis is running right now.",
                "speak": True,
                "memory": {"allow_durable_write": True},
            },
            0,
            "deterministic",
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "plan_voice_response", _fake_plan)

    response = client.post(
        "/api/kai/voice/plan",
        json=_plan_body(),
        headers={**_auth(token), "X-Voice-Turn-Id": "vturn_test_001"},
    )

    assert response.status_code == 200
    assert response.headers.get("X-Voice-Turn-Id") == "vturn_test_001"


def test_voice_tts_echoes_voice_turn_id_header(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
    )

    async def _fake_tts(*args, **kwargs):
        stream = _FakeTTSStream([b"abc"], content_length=3, openai_http_ms=12)
        return stream, "audio/mpeg", stream.meta

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "open_tts_stream", _fake_tts)

    response = client.post(
        "/api/kai/voice/tts",
        json={"user_id": "user_a", "text": "hello"},
        headers={**_auth(token), "X-Voice-Turn-Id": "vturn_test_003"},
    )

    assert response.status_code == 200
    assert response.headers.get("X-Voice-Turn-Id") == "vturn_test_003"
    assert response.headers.get("content-type", "").startswith("audio/mpeg")
    assert response.headers.get("X-Kai-TTS-Timeout-Ms") == "20000"
    assert response.headers.get("X-Kai-TTS-Audio-Bytes") == "3"
    assert response.content == b"abc"


@pytest.mark.anyio
async def test_voice_tts_stops_streaming_after_client_disconnect(
    monkeypatch: pytest.MonkeyPatch,
):
    _set_voice_runtime_config(
        monkeypatch,
        hosted_voice_enabled=True,
        allowed_users=["user_a"],
    )

    stream = _FakeTTSStream([b"ab", b"c"], content_length=3, openai_http_ms=12)

    async def _fake_tts(*args, **kwargs):
        return stream, "audio/mpeg", stream.meta

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "open_tts_stream", _fake_tts)

    response = await VOICE_ROUTES.kai_voice_tts(
        request=_FakeRequest(disconnect_after_calls=1),
        http_response=Response(),
        body=VOICE_ROUTES.VoiceTTSRequest(user_id="user_a", text="hello"),
        token_data={"user_id": "user_a", "scope": "vault_owner", "token": "test"},
    )

    assert response.headers.get("X-Kai-TTS-Audio-Bytes") == "3"
    receive_calls = 0

    async def _receive() -> dict[str, object]:
        nonlocal receive_calls
        receive_calls += 1
        if receive_calls == 1:
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def _send(message: dict[str, object]) -> None:
        _ = message

    await response(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/kai/voice/tts",
            "raw_path": b"/api/kai/voice/tts",
            "query_string": b"",
            "headers": [],
            "client": ("testclient", 1234),
            "server": ("testserver", 80),
        },
        _receive,
        _send,
    )

    assert stream.read_calls == 1
    assert stream.closed is True
    assert stream.meta["aborted"] is True
