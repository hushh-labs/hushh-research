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
    assert status["memoryBankError"] == "MemoryBankUnavailable"
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


def test_a_double_refusal_keeps_status_without_provider_bodies() -> None:
    http = _HttpSeq(
        [
            _Resp(400, {"error": {"message": "generationConfig.model is not supported"}}),
            _Resp(400, {"error": {"message": "Memory Bank is not available in this region"}}),
        ]
    )
    with pytest.raises(mb.MemoryBankUnavailable) as exc:
        mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN)
    text = str(exc.value)
    assert "HTTP 400" in text
    assert "not available in this region" not in text
    assert "not supported" not in text


# ---- the REST service: generate after a turn, retrieve on recall ---------------------


class _RestHttp:
    def __init__(self, retrieve_body=None, status=200):
        self.retrieve_body = retrieve_body or {"retrievedMemories": []}
        self.status = status
        self.posts: list[tuple[str, dict]] = []

    def post(self, url, headers=None, json=None, timeout=None):
        self.posts.append((url, json))
        assert headers["Authorization"].startswith("Bearer ")
        if url.endswith("memories:retrieve"):
            return _Resp(self.status, self.retrieve_body)
        return _Resp(self.status, {"name": "projects/p/locations/us-central1/operations/1"})


class _Token:
    def get(self):
        return "t"


def _rest_session(*texts, user_id="ha1_test"):
    from google.genai import types as genai_types

    events = [
        SimpleNamespace(
            invocation_id="inv_1",
            author="user" if i % 2 == 0 else "one",
            content=genai_types.Content(role="user", parts=[genai_types.Part(text=t)]),
        )
        for i, t in enumerate(texts)
    ]
    events.append(
        SimpleNamespace(
            invocation_id="history_3",
            author="user",
            content=genai_types.Content(role="user", parts=[genai_types.Part(text="old")]),
        )
    )
    return SimpleNamespace(events=events, user_id=user_id)


@pytest.mark.asyncio
async def test_generate_carries_the_turn_and_never_the_carried_history() -> None:
    http = _RestHttp()
    service = mb.build_rest_memory_bank_service(_cfg(), "91", session=http, token=_Token())
    await service.add_session_to_memory(_rest_session("my dog is Biscuit", "Noted."))
    url, body = http.posts[0]
    assert url.endswith("/reasoningEngines/91/memories:generate")
    events = body["directContentsSource"]["events"]
    assert [e["content"]["parts"][0]["text"] for e in events] == ["my dog is Biscuit", "Noted."]
    assert [e["content"]["role"] for e in events] == ["user", "model"]
    assert body["scope"] == {"user_id": "ha1_test"}


@pytest.mark.asyncio
async def test_retrieve_returns_facts_as_memory_entries() -> None:
    http = _RestHttp(
        {
            "retrievedMemories": [
                {
                    "memory": {
                        "fact": "The dog is called Biscuit",
                        "updateTime": "2026-09-03T00:00:00Z",
                    },
                    "distance": 0.1,
                }
            ]
        }
    )
    service = mb.build_rest_memory_bank_service(_cfg(), "91", session=http, token=_Token())
    out = await service.search_memory(app_name="one", user_id="ha1_test", query="dog")
    assert [m.content.parts[0].text for m in out.memories] == ["The dog is called Biscuit"]
    url, body = http.posts[0]
    assert url.endswith("/reasoningEngines/91/memories:retrieve")
    assert body["similaritySearchParams"]["searchQuery"] == "dog"
    assert body["scope"] == {"user_id": "ha1_test"}


@pytest.mark.asyncio
async def test_a_refused_call_raises_and_is_visible_on_pod_info() -> None:
    http = _RestHttp(status=403)
    service = mb.build_rest_memory_bank_service(_cfg(), "91", session=http, token=_Token())
    with pytest.raises(mb.MemoryBankUnavailable):
        await service.search_memory(app_name="one", user_id="ha1_test", query="dog")
    assert "memories:retrieve 403" in mb.memory_bank_status()["memoryBankError"]


def test_the_resolver_builds_the_rest_service_without_the_aiplatform_package(monkeypatch) -> None:
    _configure(monkeypatch)
    mb._STATE["engine_id"] = "91"
    service = mb.resolve_memory_bank_service()
    assert service is not None and service.engine_id_ == "91"
    assert mb.resolve_memory_bank_service() is service, "built once per process"


# -- a create that never reported done is not a created engine ------------------


def test_a_create_that_times_out_is_unavailable_not_an_engine_id() -> None:
    """The operation's NAME is not evidence an engine exists, only that one was asked
    for.

    This used to return the id parsed from the create operation when the poll loop ran
    out of time, on the reasoning that "a slow LRO is not a failure". But a slow LRO and
    a FAILING one are indistinguishable at that point. When the operation later
    completed with an error -- quota, or a model not offered in the person's region,
    the class 5e97f3ba1 exists for -- the id was already cached, /pod/info reported
    memoryBankEngine, and every memories:generate and memories:retrieve 404'd against
    an engine that was never created. The pod claimed a Memory Bank while recall
    silently returned nothing.
    """
    http = _Http(
        _Resp(200, {"reasoningEngines": []}),
        _Resp(
            200,
            # A well-formed operation carrying a parseable id, and no `done`.
            {"name": "projects/p/locations/us-central1/reasoningEngines/99/operations/1"},
        ),
    )
    with pytest.raises(mb.MemoryBankUnavailable) as caught:
        mb.find_or_create_engine(
            _cfg(), session=http, token=_TOKEN, wait_seconds=0, sleep=lambda _s: None
        )
    assert "timed out" in str(caught.value)


def test_the_next_boot_adopts_an_engine_that_did_finish() -> None:
    """Why raising costs nothing: this call is find-FIRST.

    The engine may well have been created after the wait elapsed. The next boot lists
    by display name and adopts it, which is the recovery the timeout raise depends on --
    so the honest answer never strands a real engine.
    """
    http = _Http(
        _Resp(
            200,
            {
                "reasoningEngines": [
                    {
                        "name": "projects/p/locations/us-central1/reasoningEngines/99",
                        "displayName": "one-pod-memory-ha1_test",
                    }
                ]
            },
        )
    )
    assert mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN) == "99"
    assert http.posts == [], "it created a second engine instead of adopting the first"


def test_done_with_no_engine_name_fails_without_polling_a_finished_operation() -> None:
    """Polling an operation that already said done cannot change the answer."""
    http = _Http(
        _Resp(200, {"reasoningEngines": []}),
        _Resp(200, {"done": True, "name": "operations/1"}),
    )
    with pytest.raises(mb.MemoryBankUnavailable) as caught:
        mb.find_or_create_engine(_cfg(), session=http, token=_TOKEN, sleep=lambda _s: None)
    assert "without an engine name" in str(caught.value)
    assert [g for g in http.gets if "/operations/" in g] == []


@pytest.mark.asyncio
async def test_foreign_owner_cannot_hydrate_or_call_memory_provider() -> None:
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_memory_service import PodMemoryError, build_pod_memory_service

    bank = _Bank(hits=[SimpleNamespace(content="owner-only memory")])
    log = SimpleNamespace(replay=AsyncMock(return_value=[]), append=AsyncMock())
    service = build_pod_memory_service(hushh_id="ha1_owner", pod_key=b"k" * 32, bank=bank, log=log)
    with pytest.raises(PodMemoryError):
        await service.search_memory(app_name="one", user_id="ha1_other", query="private")
    session = _session("foreign information")
    session.user_id = "ha1_other"
    with pytest.raises(PodMemoryError):
        await service.add_session_to_memory(session)
    log.replay.assert_not_awaited()
    log.append.assert_not_awaited()
    assert bank.searched == []
    assert bank.added == 0


@pytest.mark.asyncio
async def test_provider_error_content_is_not_logged(caplog) -> None:
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_memory_service import build_pod_memory_service

    marker = "synthetic-private-provider-payload"
    bank = SimpleNamespace(
        search_memory=AsyncMock(side_effect=RuntimeError(marker)),
        add_session_to_memory=AsyncMock(side_effect=RuntimeError(marker)),
    )
    service = build_pod_memory_service(hushh_id="ha1_owner", pod_key=b"k" * 32, bank=bank)
    await service.add_session_to_memory(_session("a remembered preference"))
    found = await service.search_memory(app_name="one", user_id="ha1_owner", query="preference")
    assert found.memories
    assert marker not in caplog.text
    assert "RuntimeError" in caplog.text
