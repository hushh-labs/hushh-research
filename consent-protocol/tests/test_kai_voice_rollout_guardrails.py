from __future__ import annotations

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
    def __init__(self, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}

    async def is_disconnected(self) -> bool:
        return False


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


def test_voice_plan_respects_rollout_allowlist(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_b")
    monkeypatch.setenv("KAI_VOICE_V1_CANARY_PERCENT", "100")
    monkeypatch.setenv("KAI_VOICE_V1_DISABLE_TOOL_EXECUTION", "false")

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
    assert payload["memory"]["allow_durable_write"] is False
    assert called["value"] is False


def test_voice_realtime_session_respects_rollout_allowlist(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_b")
    monkeypatch.setenv("KAI_VOICE_V1_CANARY_PERCENT", "100")

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
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_a")

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


def test_voice_plan_respects_canary_percent(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "")
    monkeypatch.setenv("KAI_VOICE_V1_CANARY_PERCENT", "0")
    monkeypatch.setenv("KAI_VOICE_V1_DISABLE_TOOL_EXECUTION", "false")

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


@pytest.mark.anyio
async def test_voice_understand_rollout_blocks_before_audio_read(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_b")
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
    assert response.memory.allow_durable_write is False
    assert response.model == "deterministic_rollout"


@pytest.mark.anyio
async def test_voice_understand_sanitizes_debug_message_in_error_response(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_a")
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
async def test_voice_stt_rejects_oversized_content_length_before_audio_read(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("KAI_VOICE_UPLOAD_MAX_BYTES", "8")
    guarded_upload = _GuardedUploadFile()

    with pytest.raises(HTTPException) as exc_info:
        await VOICE_ROUTES.kai_voice_stt(
            request=_FakeRequest(headers={"content-length": "70000"}),
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
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_a")
    monkeypatch.setenv("KAI_VOICE_UPLOAD_MAX_BYTES", "8")
    upload = _ChunkedUploadFile(chunks=[b"1234", b"5678", b"9"])

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
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_a")

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
    assert payload["tool_call"]["tool_name"] == "execute_kai_command"
    assert payload["tool_call"]["args"]["command"] == "analyze"
    assert payload["tool_call"]["args"]["params"]["symbol"] == "GOOGL"


def test_voice_plan_kill_switch_downgrades_execute_to_speak_only(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_a")
    monkeypatch.setenv("KAI_VOICE_V1_DISABLE_TOOL_EXECUTION", "true")

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
    assert (
        payload["response"]["message"]
        == "Voice actions are temporarily unavailable. I can still respond and guide you."
    )
    assert payload["memory"]["allow_durable_write"] is False
    assert payload["tool_call"]["tool_name"] == "clarify"


def test_voice_plan_echoes_voice_turn_id_header(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    vault_owner_token_for_user,
):
    token = vault_owner_token_for_user("user_a")
    monkeypatch.setenv("KAI_VOICE_V1_ENABLED", "true")
    monkeypatch.setenv("KAI_VOICE_V1_ALLOWED_USERS", "user_a")
    monkeypatch.setenv("KAI_VOICE_V1_DISABLE_TOOL_EXECUTION", "false")

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

    async def _fake_tts(*args, **kwargs):
        return (
            b"abc",
            "audio/mpeg",
            {"model": "gpt-4o-mini-tts", "voice": "alloy", "format": "mp3"},
        )

    monkeypatch.setattr(VOICE_ROUTES.voice_service, "synthesize_speech", _fake_tts)

    response = client.post(
        "/api/kai/voice/tts",
        json={"user_id": "user_a", "text": "hello"},
        headers={**_auth(token), "X-Voice-Turn-Id": "vturn_test_003"},
    )

    assert response.status_code == 200
    assert response.headers.get("X-Voice-Turn-Id") == "vturn_test_003"
    assert response.headers.get("content-type", "").startswith("audio/mpeg")
    assert response.content == b"abc"
