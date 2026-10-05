"""The owner's "Bring your own AI" doors (contract C2): set, read, clear, over real HTTP.

A selection is stored only after the envelope opened AND the provider answered on the
key; a refusal stores nothing and says why in one code. Replays and rollbacks are
refused even across a clear. Admission is settled before the envelope is read. An
unreadable selection refuses turns rather than reading as "none". And the key never
appears in a response, a log line, or a repr.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="hub-consent"` names a test fixture, not a credential.
import asyncio
import base64
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors

from api.routes.one import pod_session, pod_turn
from api.routes.one.pod_ai_selection import run_ai_selection_get, run_ai_selection_put
from api.routes.one.pod_turn import PodTurnRequest
from api.routes.one.pod_turn_target import owner_selected_turn
from hushh_mcp.services import (
    pod_ai_selection,
    pod_ai_selection_check,
    pod_consent_client,
    pod_memory_service,
    pod_self_registration,
)
from hushh_mcp.services.pod_ai_selection_seal import (
    AiSelectionRefused,
    b64url_decode,
    seal_ai_selection,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_connector_keypair_service import PodKeyPair
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_session_authority import (
    LOCAL_TOKEN_PREFIX,
    SCOPE_POD_CONFIG,
    SCOPE_POD_STATUS,
)

with pytest.MonkeyPatch.context() as _pod_import_env:
    _pod_import_env.setenv("HUSSH_POD_MODE", "1")
    import pod_server

VECTOR = json.loads(
    (Path(__file__).parent / "fixtures" / "ai_selection_seal_vector_v1.json").read_text()
)
OWNER = VECTOR["aad"]["hushhId"]
NOW = VECTOR["aad"]["issuedAtMs"]
SECRET = "sk-live-owner-secret-never-echoed"
POD = X25519PrivateKey.from_private_bytes(b64url_decode(VECTOR["podPrivateKey"]))
PATH = "/api/one/pod/ai-selection"


def _envelope(issued_at: int = NOW, **plaintext: Any) -> dict:
    body = {**VECTOR["plaintext"], "apiKey": SECRET, **plaintext}
    return seal_ai_selection(
        body,
        pod_public_key_raw=b64url_decode(VECTOR["podPublicKey"]),
        aad={**VECTOR["aad"], "issuedAtMs": issued_at},
    )


async def _owner_verifier(_token: str, *, expected_scope: str) -> ConsentVerdict:
    return ConsentVerdict(True, True, "owner-uid", OWNER, expected_scope)


async def _answers(_selection: Any, *, gemini_default: str) -> None:
    return None


async def _refuses(_selection: Any, *, gemini_default: str) -> str:
    return "KEY_REFUSED"


@pytest.fixture
def pod(monkeypatch, tmp_path):
    """An enabled pod holding the vector's key, with a real sealed commit log."""
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "store")), b"\x42" * 32, owner_id=OWNER)
    keypair = PodKeyPair(
        private_key=POD,
        public_key_b64=base64.b64encode(b64url_decode(VECTOR["podPublicKey"])).decode(),
        key_id=VECTOR["podKeyId"],
    )
    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.setattr(pod_self_registration, "_STATE", (True, keypair))
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)
    monkeypatch.setattr(pod_consent_client, "verify_consent", _owner_verifier)
    monkeypatch.setattr(pod_ai_selection_check, "live_check", _answers)
    pod_ai_selection.set_active_ai_selection(None)
    pod_ai_selection.note_ai_selection_failure(None)
    yield log
    pod_ai_selection.set_active_ai_selection(None)
    pod_ai_selection.note_ai_selection_failure(None)


def _client() -> TestClient:
    return TestClient(pod_server.app, raise_server_exceptions=False)


#: This pod's own app-role session, the only door these routes open.
OWNER_SESSION = {"Authorization": "Bearer pod-session-fixture"}
#: A hub-relayed consent token valid for the owner: refused on every selection door.
HUB = {"X-Consent-Token": "hub-consent"}
_CLAIMS = {"role": "app", "scopes": [SCOPE_POD_CONFIG, SCOPE_POD_STATUS]}


class _OwnerSession:
    held_checks = 0

    def local_token(self, _claims: dict) -> str:
        return LOCAL_TOKEN_PREFIX + "fixture"

    def local_verifier(self, _claims: dict) -> Any:
        return _owner_verifier

    async def require_held(self) -> None:
        type(self).held_checks += 1


def _local() -> dict:
    """What the route's owner-local door hands a core."""
    return {
        "consent_token": LOCAL_TOKEN_PREFIX + "fixture",
        "verifier": _owner_verifier,
        "session": _CLAIMS,
    }


@pytest.fixture
def owner_session(monkeypatch):
    def _verified(authorization: Any, *, role: str, scope: Any = None) -> tuple:
        assert authorization == OWNER_SESSION["Authorization"] and role == "app"
        assert scope in _CLAIMS["scopes"]
        return _OwnerSession(), _CLAIMS

    _OwnerSession.held_checks = 0
    monkeypatch.setattr(pod_session, "verified_session", _verified)
    return _OwnerSession


async def _records(log) -> list[dict]:
    return [r for r in await log.replay() if r["kind"] == "pod_ai_selection_v1"]


def _now_ms() -> int:
    return int(time.time() * 1000)


async def test_a_checked_selection_is_sealed_into_the_log_and_never_echoed(
    pod, owner_session, caplog
):
    client = _client()

    put = client.put(PATH, json=_envelope(_now_ms()), headers=OWNER_SESSION)
    got = client.get(PATH, headers=OWNER_SESSION)

    assert put.status_code == 200, put.text
    checked = put.json()["checkedAtMs"]
    assert put.json() == {
        "status": "active",
        "provider": "openai",
        "model": None,
        "checkedAtMs": checked,
    }
    assert got.json() == {
        "configured": True,
        "provider": "openai",
        "model": None,
        "checkedAtMs": checked,
        "lastFailure": None,
    }
    records = await _records(pod)
    assert [r["payload"]["apiKey"] for r in records] == [SECRET], "held in the pod's own log"
    assert pod_ai_selection.active_ai_selection().api_key == SECRET, "every turn uses it now"
    for text in (put.text, got.text, caplog.text, repr(pod_ai_selection.active_ai_selection())):
        assert SECRET not in text
    assert owner_session.held_checks == 1, "a write needs a held incarnation, a read does not"


async def test_the_hub_door_can_never_set_read_or_clear_the_selection(pod, owner_session):
    """Negative control for the owner-only door: a valid owner consent token from the hub.

    Anyone can seal to the pod's public key, so a hub-admitted write could swap in a key
    the owner never chose. Before this guard the same request stored the selection.
    """
    client = _client()
    for response in (
        client.put(PATH, json=_envelope(_now_ms()), headers=HUB),
        client.get(PATH, headers=HUB),
        client.delete(PATH, headers=HUB),
        client.put(PATH, json=_envelope(_now_ms()), headers={**HUB, **OWNER_SESSION}),
    ):
        assert response.status_code == 403, response.request.method
        assert response.json() == {"detail": {"code": "OWNER_SESSION_REQUIRED"}}
    assert await _records(pod) == []
    with pytest.raises(HTTPException) as refused:
        await run_ai_selection_put(
            envelope=_envelope(_now_ms()), consent_token="hub-consent", verifier=_owner_verifier
        )
    assert refused.value.status_code == 403, "the core refuses a hub token on its own too"


async def test_a_refused_key_stores_nothing_and_says_why(pod, owner_session, monkeypatch):
    """Negative control for the happy path: the same envelope, a provider that says no."""
    monkeypatch.setattr(pod_ai_selection_check, "live_check", _refuses)
    client = _client()

    put = client.put(PATH, json=_envelope(_now_ms()), headers=OWNER_SESSION)

    assert put.status_code == 422
    assert put.json() == {"code": "KEY_REFUSED"}
    assert await _records(pod) == []
    assert pod_ai_selection.active_ai_selection() is None
    failure = client.get(PATH, headers=OWNER_SESSION).json()["lastFailure"]
    assert failure["code"] == "KEY_REFUSED" and isinstance(failure["atMs"], int)


async def test_a_replay_or_rollback_is_refused_even_after_a_clear(pod, owner_session):
    async def put(issued_at: int) -> Any:
        return await run_ai_selection_put(
            envelope=_envelope(issued_at), check=_answers, now_ms=NOW, **_local()
        )

    assert (await put(NOW))["status"] == "active"
    assert json.loads((await put(NOW)).body) == {"code": "STALE_SELECTION"}, "replay"
    assert (await put(NOW + 1))["status"] == "active"
    delete = _client().delete(PATH, headers=OWNER_SESSION)
    assert delete.json() == {"status": "cleared"}
    assert pod_ai_selection.active_ai_selection() is None
    assert json.loads((await put(NOW + 1)).body) == {"code": "STALE_SELECTION"}, "rollback"
    assert (await put(NOW + 2))["status"] == "active", "a fresh choice after a clear"
    # The store re-checks under its own compare-and-set, so two racing writes that both
    # opened against the same floor cannot both land.
    with pytest.raises(AiSelectionRefused):
        await pod_ai_selection.record_ai_selection(
            pod, hushh_id=OWNER, opened=_opened(issued_at_ms=NOW + 2), checked_at_ms=NOW
        )


async def test_admission_is_settled_before_the_envelope_is_read(pod, monkeypatch):
    read: list[bool] = []

    async def read_envelope() -> dict:
        read.append(True)
        return _envelope()

    with pytest.raises(HTTPException) as refused:
        await run_ai_selection_put(read_envelope=read_envelope, consent_token="")
    assert refused.value.status_code == 401 and read == []

    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: False)
    for method in ("put", "get", "delete"):
        response = getattr(_client(), method)(PATH, headers=OWNER_SESSION)
        assert response.status_code == 404, method
        assert response.json() == {"detail": "pod turn is not available"}


def test_the_door_is_reachable_through_the_wall_and_carries_its_own_refusal(pod, monkeypatch):
    """Without a hub identity the wall answers 404 "not found" to machine routes; this
    door must instead reach its own admission, or the owner's app could never use it."""
    from api.middlewares import pod_ingress

    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", "hub@example.iam.gserviceaccount.com")
    monkeypatch.setattr(pod_ingress, "identity_verifier", None)
    client = _client()
    for response in (client.put(PATH, json=_envelope()), client.get(PATH), client.delete(PATH)):
        assert response.status_code == 401, response.request.method
        assert response.json() == {"detail": "consent token required"}


class _BrokenLog:
    async def replay(self) -> list:
        raise OSError("storage unreachable")


async def test_an_unreadable_selection_refuses_turns_until_a_read_succeeds(pod):
    payload = PodTurnRequest(message="hello", runtimeCredential="AIza-per-turn")

    await pod_ai_selection.load_active_ai_selection(_BrokenLog())
    with pytest.raises(HTTPException) as refused:
        owner_selected_turn(payload, "gemini", "gemini-test")
    assert refused.value.status_code == 503
    assert refused.value.detail == {"code": "OWNER_AI_SELECTION_UNAVAILABLE"}

    # The owner's status read heals it from a readable log; then today's path returns.
    status = await run_ai_selection_get(log=pod, **_local())
    assert status["configured"] is False
    assert owner_selected_turn(payload, "gemini", "gemini-test") is None


async def test_a_damaged_newest_record_refuses_turns_and_a_fresh_choice_repairs_it(
    pod, owner_session
):
    """A newest record that cannot be read is "unreadable", never "no selection".

    Negative control: before the strict read, the same log loaded as no selection and
    turns quietly fell back to the default model path.
    """
    await pod.append(
        pod_ai_selection.POD_AI_SELECTION_RECORD_KIND,
        {"hushh_id": OWNER, "provider": "openai", "issuedAtMs": NOW},
    )
    await pod_ai_selection.load_active_ai_selection(pod)
    payload = PodTurnRequest(message="hello")
    with pytest.raises(HTTPException) as refused:
        owner_selected_turn(payload, "gemini", "gemini-test")
    assert refused.value.detail == {"code": "OWNER_AI_SELECTION_UNAVAILABLE"}

    put = await run_ai_selection_put(envelope=_envelope(_now_ms()), check=_answers, **_local())
    assert put["status"] == "active", "the owner can always replace a damaged record"
    assert pod_ai_selection.active_ai_selection().provider == "openai"


# -- the live check, against each provider's real error types --------------------------

_REQUEST = httpx.Request("POST", "https://api.openai.com/v1/responses")


def _openai_error(cls: type, status: int) -> Exception:
    message = f"Incorrect API key provided: {SECRET}"
    return cls(message, response=httpx.Response(status, request=_REQUEST), body=None)


def _gemini_error(status: int, message: str) -> Exception:
    return genai_errors.ClientError(status, {"error": {"code": status, "message": message}})


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (_openai_error(openai.AuthenticationError, 401), "KEY_REFUSED"),
        (_openai_error(openai.PermissionDeniedError, 403), "KEY_REFUSED"),
        (_openai_error(openai.RateLimitError, 429), "QUOTA_EXCEEDED"),
        (_openai_error(openai.NotFoundError, 404), "MODEL_UNAVAILABLE"),
        (_gemini_error(400, f"API key not valid. {SECRET}"), "KEY_REFUSED"),
        (_gemini_error(429, "Resource has been exhausted"), "QUOTA_EXCEEDED"),
        (_gemini_error(404, "models/gemini-x is not found"), "MODEL_UNAVAILABLE"),
        (openai.APIConnectionError(request=_REQUEST), "PROVIDER_UNREACHABLE"),
    ],
    ids=[
        "openai_401",
        "openai_403",
        "openai_429",
        "openai_404",
        "gemini_bad_key",
        "gemini_429",
        "gemini_404",
        "unreachable",
    ],
)
async def test_the_live_check_names_each_refusal_and_never_echoes_it(error, code, caplog):
    seen: dict[str, Any] = {}

    async def generate(*, model, contents, config):
        seen["model"], seen["tokens"] = model, config.max_output_tokens
        raise error

    check = pod_ai_selection_check.live_check

    assert (
        await check(_opened(provider="openai"), gemini_default="g", client=_fake(generate)) == code
    )
    assert seen == {"model": "gpt-5.6-luna", "tokens": 16}
    assert SECRET not in caplog.text


async def test_the_live_check_passes_an_answer_and_bounds_a_silent_provider():
    """Negative controls: an answer is success; silence past the bound is unreachable."""

    async def answers(**_kwargs):
        return object()

    async def hangs(**_kwargs):
        await asyncio.sleep(5)

    selection = _opened(provider="gemini", model="gemini-test")
    check = pod_ai_selection_check.live_check
    assert await check(selection, gemini_default="g", client=_fake(answers)) is None
    assert (
        await check(selection, gemini_default="g", client=_fake(hangs), timeout_seconds=0.01)
        == "PROVIDER_UNREACHABLE"
    )


def _fake(generate: Any) -> Any:
    return SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))


def _opened(**fields: Any) -> Any:
    from hushh_mcp.services.pod_ai_selection_seal import OpenedSelection

    base = {
        "provider": "openai",
        "model": None,
        "api_key": SECRET,
        "transport": None,
        "vertex_project": None,
        "vertex_location": None,
        "issued_at_ms": NOW,
        "selection_id": VECTOR["aad"]["selectionId"],
    }
    return OpenedSelection(**{**base, **fields})
