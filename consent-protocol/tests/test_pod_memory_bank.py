"""Memory Bank on the person's own Vertex: created by the pod, recalled first, never fatal.

Founder decision 2026-09-03. The pod's service account is the only principal in a BYOC
project that holds a Vertex role (verified live: the bootstrap account is denied
`reasoningEngines.list`, and the hub cannot mint as the pod), so the POD creates its own
engine, lazily, and the sealed commit log stays the record of record underneath it.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from hushh_mcp.services import pod_memory_bank as mb

# A fake bearer for scripted HTTP; nothing here talks to a real API.
_TOKEN = "t"  # noqa: S105


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    mb.reset_memory_bank_state()
    for name in (
        "POD_MEMORY_BACKEND",
        "POD_MEMORY_BANK_LOCATION",
        "POD_MEMORY_BANK_ENGINE_ID",
        "GOOGLE_CLOUD_PROJECT",
        "HUSSH_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    yield
    mb.reset_memory_bank_state()


def _configure(monkeypatch, **extra):
    monkeypatch.setenv("POD_MEMORY_BACKEND", "memory_bank")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hussh-one-test")
    monkeypatch.setenv("HUSSH_ID", "ha1_test")
    for k, v in extra.items():
        monkeypatch.setenv(k, v)


def test_off_by_default_and_regional_when_on(monkeypatch) -> None:
    assert mb.pod_memory_backend() == "commit_log"
    assert mb.memory_bank_config() is None
    _configure(monkeypatch, POD_MEMORY_BANK_LOCATION="europe-west1")
    cfg = mb.memory_bank_config()
    assert cfg is not None
    assert cfg.project == "hussh-one-test"
    assert cfg.location == "europe-west1", "Agent Engine is regional, never `global`"
    assert cfg.display_name == "one-pod-memory-ha1_test"
    assert cfg.engine_id is None


def test_engine_id_is_read_from_either_resource_or_operation_name() -> None:
    assert mb._engine_id_from_name("projects/p/locations/l/reasoningEngines/123") == "123"
    assert (
        mb._engine_id_from_name("projects/p/locations/l/reasoningEngines/123/operations/9") == "123"
    )
    assert mb._engine_id_from_name("projects/p/locations/l/operations/9") is None


class _Resp:
    def __init__(self, status, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text or json.dumps(body or {})

    def json(self):
        return self._body


class _Http:
    """Scripted HTTP: a list answer, then a create answer, then poll answers."""

    def __init__(self, list_resp, create_resp=None, polls=()):
        self.list_resp = list_resp
        self.create_resp = create_resp
        self.polls = list(polls)
        self.posts: list[dict] = []
        self.gets: list[str] = []

    def get(self, url, **kw):
        self.gets.append(url)
        if "/operations/" in url:
            return self.polls.pop(0)
        return self.list_resp

    def post(self, url, **kw):
        self.posts.append(kw.get("json") or {})
        return self.create_resp


def _cfg():
    return mb.MemoryBankConfig(
        project="p", location="us-central1", display_name="one-pod-memory-ha1_test", engine_id=None
    )


def test_an_existing_engine_is_found_and_nothing_is_created() -> None:
    http = _Http(
        _Resp(
            200,
            {
                "reasoningEngines": [
                    {
                        "name": "projects/p/locations/us-central1/reasoningEngines/77",
                        "displayName": "one-pod-memory-ha1_test",
                    }
                ]
            },
        )
    )
    assert mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN) == "77"
    assert http.posts == []


def test_a_missing_engine_is_created_and_the_operation_is_followed_to_done() -> None:
    http = _Http(
        _Resp(200, {"reasoningEngines": []}),
        _Resp(
            200,
            {
                "name": "projects/p/locations/us-central1/reasoningEngines/88/operations/1",
                "done": False,
            },
        ),
        polls=[
            _Resp(200, {"done": False}),
            _Resp(
                200,
                {
                    "done": True,
                    "response": {"name": "projects/p/locations/us-central1/reasoningEngines/88"},
                },
            ),
        ],
    )
    engine = mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN, sleep=lambda _s: None)
    assert engine == "88"
    body = http.posts[0]
    assert body["displayName"] == "one-pod-memory-ha1_test"
    # A Memory-Bank-only engine, on the person's own publisher models.
    spec = body["contextSpec"]["memoryBankConfig"]
    assert spec["generationConfig"]["model"].startswith(
        "projects/p/locations/us-central1/publishers/google/models/"
    )
    assert "similaritySearchConfig" in spec


def test_a_denied_project_raises_a_named_refusal_instead_of_guessing() -> None:
    http = _Http(_Resp(403, {"error": {"message": "Permission denied"}}, text="Permission denied"))
    with pytest.raises(mb.MemoryBankUnavailable, match="list 403"):
        mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN)


class _Store:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    async def get(self, key):
        return self.objects.get(key)

    async def put_if_generation(self, key, data, expected):
        if expected == 0 and key in self.objects:
            return None
        self.objects[key] = data
        return 1


@pytest.mark.asyncio
async def test_ensure_creates_once_persists_the_record_and_reuses_it(monkeypatch) -> None:
    _configure(monkeypatch)
    calls: list[str] = []

    def _fake_find_or_create(cfg, **kw):
        calls.append(cfg.display_name)
        return "555"

    monkeypatch.setattr(mb, "find_or_create_engine", _fake_find_or_create)
    store = _Store()
    assert await mb.ensure_memory_bank(store=store) == "555"
    assert json.loads(store.objects[mb.MEMORY_BANK_RECORD_KEY])["engineId"] == "555"
    assert mb.memory_bank_status() == {"memoryBankEngine": "555"}

    # A fresh process with the record present never talks to the API again.
    mb.reset_memory_bank_state()
    assert await mb.ensure_memory_bank(store=store) == "555"
    assert calls == ["one-pod-memory-ha1_test"]


@pytest.mark.asyncio
async def test_ensure_never_raises_and_reports_why_it_fell_back(monkeypatch) -> None:
    _configure(monkeypatch)

    def _refuse(cfg, **kw):
        raise mb.MemoryBankUnavailable("create 403: quota")

    monkeypatch.setattr(mb, "find_or_create_engine", _refuse)
    assert await mb.ensure_memory_bank(store=_Store()) is None
    status = mb.memory_bank_status()
    assert "memoryBankEngine" not in status
    assert "create 403" in status["memoryBankError"]
    assert mb.resolve_memory_bank_service() is None, "no engine, no service: the log answers"


@pytest.mark.asyncio
async def test_ensure_is_a_no_op_when_this_pod_uses_the_commit_log(monkeypatch) -> None:
    monkeypatch.setattr(
        mb, "find_or_create_engine", lambda *a, **k: pytest.fail("must not be called")
    )
    assert await mb.ensure_memory_bank(store=_Store()) is None
    assert mb.memory_bank_status() == {}


# ---- the composite: sealed log under, Memory Bank on top -------------------------


class _Bank:
    def __init__(self, hits=(), fail=False):
        self.hits = list(hits)
        self.fail = fail
        self.added = 0
        self.searched: list[str] = []

    async def add_session_to_memory(self, session):
        if self.fail:
            raise RuntimeError("bank down")
        self.added += 1

    async def search_memory(self, *, app_name, user_id, query):
        self.searched.append(query)
        if self.fail:
            raise RuntimeError("bank down")
        return SimpleNamespace(memories=list(self.hits))


def _session(*texts):
    from google.genai import types as genai_types

    events = [
        SimpleNamespace(
            invocation_id=f"inv_{i}",
            author="user",
            content=genai_types.Content(role="user", parts=[genai_types.Part(text=t)]),
        )
        for i, t in enumerate(texts)
    ]
    return SimpleNamespace(events=events)


@pytest.mark.asyncio
async def test_every_turn_reaches_both_and_recall_prefers_the_bank() -> None:
    from hushh_mcp.services.pod_memory_service import build_pod_memory_service

    bank = _Bank(hits=[SimpleNamespace(content="banked memory")])
    service = build_pod_memory_service(hushh_id="ha1_x", pod_key=b"k" * 32, bank=bank)
    await service.add_session_to_memory(_session("my dog is called Biscuit"))
    assert bank.added == 1
    found = await service.search_memory(app_name="one", user_id="ha1_x", query="dog")
    assert [m.content for m in found.memories] == ["banked memory"]
    assert bank.searched == ["dog"]


@pytest.mark.asyncio
async def test_a_failing_bank_never_fails_a_turn_and_the_log_still_answers() -> None:
    from hushh_mcp.services.pod_memory_service import build_pod_memory_service

    bank = _Bank(fail=True)
    service = build_pod_memory_service(hushh_id="ha1_x", pod_key=b"k" * 32, bank=bank)
    await service.add_session_to_memory(_session("my dog is called Biscuit"))
    found = await service.search_memory(app_name="one", user_id="ha1_x", query="dog Biscuit")
    assert found.memories, "the sealed store recalled what the bank could not"


@pytest.mark.asyncio
async def test_an_empty_bank_answer_falls_through_to_the_log() -> None:
    from hushh_mcp.services.pod_memory_service import build_pod_memory_service

    bank = _Bank(hits=[])
    service = build_pod_memory_service(hushh_id="ha1_x", pod_key=b"k" * 32, bank=bank)
    await service.add_session_to_memory(_session("my dog is called Biscuit"))
    found = await service.search_memory(app_name="one", user_id="ha1_x", query="dog Biscuit")
    assert found.memories


def test_the_pod_reports_its_engine_on_the_beat(monkeypatch) -> None:
    from pod_server import _self_report

    monkeypatch.delenv("HUSSH_POD_IMAGE_TAG", raising=False)
    monkeypatch.delenv("K_REVISION", raising=False)
    mb._STATE["engine_id"] = "555"
    assert _self_report() == {"memoryBankEngine": "555"}


def test_the_hub_accepts_the_engine_id_and_nothing_else_new() -> None:
    from api.routes.one.pod_heartbeat import _SELF_REPORT_FIELDS

    assert set(_SELF_REPORT_FIELDS) == {"imageTag", "revision", "memoryBankEngine"}


class _HttpSeq:
    """Scripted create answers in order, after one list miss."""

    def __init__(self, creates):
        self.creates = list(creates)
        self.posts: list[dict] = []

    def get(self, url, **kw):
        return _Resp(200, {"reasoningEngines": []})

    def post(self, url, **kw):
        self.posts.append(kw.get("json") or {})
        return self.creates.pop(0)


def test_a_refused_model_choice_retries_with_the_service_defaults() -> None:
    http = _HttpSeq(
        [
            _Resp(400, {"error": {"message": "generationConfig.model is not supported"}}),
            _Resp(
                200,
                {
                    "name": "projects/p/locations/us-central1/reasoningEngines/91",
                    "done": True,
                    "response": {"name": "projects/p/locations/us-central1/reasoningEngines/91"},
                },
            ),
        ]
    )
    assert mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN) == "91"
    assert "generationConfig" in http.posts[0]["contextSpec"]["memoryBankConfig"]
    assert http.posts[1]["contextSpec"]["memoryBankConfig"] == {}, (
        "the retry lets the service choose"
    )


def test_a_double_refusal_names_both_reasons() -> None:
    http = _HttpSeq(
        [
            _Resp(400, {"error": {"message": "generationConfig.model is not supported"}}),
            _Resp(400, {"error": {"message": "Memory Bank is not available in this region"}}),
        ]
    )
    with pytest.raises(mb.MemoryBankUnavailable) as exc:
        mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN)
    text = str(exc.value)
    assert "not available in this region" in text and "not supported" in text
