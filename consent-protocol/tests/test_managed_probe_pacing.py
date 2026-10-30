"""Readiness pacing, truthful dispatch receipts and bounded quota refusal."""

import asyncio
import importlib.util
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_managed_vertex_runtime.py"


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_probe_pacing_preserves_errors_and_stops_on_cancellation(monkeypatch, cancel):
    spec = importlib.util.spec_from_file_location("paced_probe_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now = [0.0]
    starts = []

    async def sleep(delay):
        now[0] += delay

    async def probe(index):
        starts.append(now[0])
        now[0] += 2
        if index == 1:
            if cancel:
                raise asyncio.CancelledError
            raise RuntimeError("synthetic failed probe")

    monkeypatch.setattr(module, "monotonic", lambda: now[0])
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    labelled = [(str(i), lambda i=i: probe(i)) for i in range(3)]
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await module._run_paced_probes(labelled)
        assert starts == [0, 30]
    else:
        outcomes = await module._run_paced_probes(labelled)
        assert starts == [0, 30, 60]
        assert outcomes[0] is None and outcomes[2] is None
        assert isinstance(outcomes[1], RuntimeError)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scenario",
    ["recovery", "server_recovery", "exhausted", "permission", "schema", "billing", "cancel"],
)
async def test_probe_recovery_requires_success_and_preserves_hard_failures(monkeypatch, scenario):
    spec = importlib.util.spec_from_file_location("probe_recovery_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now = [0.0]
    starts = []
    receipts = {}

    async def sleep(delay):
        now[0] += delay

    async def probe():
        starts.append(now[0])
        now[0] += 2
        if scenario == "cancel":
            raise asyncio.CancelledError
        if scenario == "billing":
            raise RuntimeError("Billing is not enabled")
        if scenario in {"permission", "schema"}:
            cause = ValueError("Synthetic invalid schema")
            if scenario == "permission":
                cause.status_code = 403
            raise TimeoutError("Sanitized caller wrapper") from cause
        if scenario == "exhausted" or len(starts) == 1:
            if scenario == "server_recovery":
                cause = RuntimeError("Synthetic provider failure")
                cause.status_code = 503
                raise cause
            raise TimeoutError()

    monkeypatch.setattr(module, "monotonic", lambda: now[0])
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    if scenario == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await module._run_paced_probes([("synthetic", probe)], attempts=receipts)
        assert starts == [0]
        return
    outcomes = await module._run_paced_probes([("synthetic", probe)], attempts=receipts)
    recovered = scenario in {"recovery", "server_recovery"}
    assert starts == ([0, 30] if recovered or scenario == "exhausted" else [0])
    assert (outcomes[0] is None) is recovered
    assert [r["ok"] for r in receipts["synthetic"]] == (
        [False, True] if recovered else [False] * len(starts)
    )
    assert all(r["elapsed_ms"] == 2000 for r in receipts["synthetic"])
    if scenario in {"permission", "schema"}:
        assert receipts["synthetic"][0]["classification"] == "candidate_misconfigured"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("warmup_seconds", "recovery_succeeds"), [(30, True), (30, False), (99, True)]
)
async def test_gateway_timeout_recovery_requires_positive_reply_and_remaining_budget(
    monkeypatch, warmup_seconds, recovery_succeeds
):
    from google.genai.errors import ServerError

    spec = importlib.util.spec_from_file_location("gateway_probe_recovery_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now = [float(warmup_seconds)]
    starts = []
    receipts = {}
    durations = [0.902, 0.744, 0.899, 2.794, 56.612, 0.161]
    gateway_error = ServerError(504, {"error": {"message": "Synthetic gateway timeout"}})

    async def sleep(delay):
        now[0] += delay

    async def probe(index):
        starts.append((index, now[0]))
        is_recovery = sum(i == index for i, _ in starts) > 1
        now[0] += 0.9 if is_recovery and recovery_succeeds else durations[index]
        if index == 4 and not (is_recovery and recovery_succeeds):
            raise gateway_error

    monkeypatch.setattr(module, "monotonic", lambda: now[0])
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    outcomes = await module._run_paced_probes(
        [(str(i), lambda i=i: probe(i)) for i in range(6)],
        attempts=receipts,
        deadline=330,
    )
    assert [i for i, _ in starts[:6]] == list(range(6))
    assert all(error is None for i, error in enumerate(outcomes) if i != 4)
    assert now[0] < 330
    if warmup_seconds == 99:
        assert len(starts) == 6
        assert outcomes[4] is gateway_error
        assert receipts["4"][-1]["dispatched"] is False
    else:
        assert [i for i, _ in starts] == [0, 1, 2, 3, 4, 5, 4]
        assert starts[-1][1] == pytest.approx(236.612)
        assert (outcomes[4] is None) is recovery_succeeds
        assert [r["ok"] for r in receipts["4"]] == [False, recovery_succeeds]
        assert all(r["dispatched"] is True for r in receipts["4"])
    assert all(r.get("resource_exhausted") is False for r in receipts["4"] if not r["ok"])


@pytest.mark.asyncio
@pytest.mark.parametrize("later_hard_failure", [False, True])
async def test_recovery_budget_preserves_later_verdicts_and_does_not_overschedule(
    monkeypatch, later_hard_failure
):
    spec = importlib.util.spec_from_file_location("probe_sequence_budget_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now = [0.0]
    starts = []
    first_errors = {}
    receipts = {}
    durations = [25, 25, 25, 30, 130, 25]

    async def sleep(delay):
        now[0] += delay

    async def probe(index):
        starts.append(index)
        now[0] += durations[index]
        error = (
            RuntimeError("Synthetic late candidate defect")
            if (later_hard_failure and index == 5)
            else TimeoutError()
        )
        first_errors.setdefault(index, error)
        raise error

    monkeypatch.setattr(module, "monotonic", lambda: now[0])
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    outcomes = await module._run_paced_probes(
        [(str(i), lambda i=i: probe(i)) for i in range(6)], attempts=receipts
    )
    assert starts[:6] == list(range(6))
    assert now[0] <= module.PROBE_SEQUENCE_SECONDS < 420
    assert all(error is not None for error in outcomes)
    assert outcomes[1] is first_errors[1]  # unaffordable recovery retains the real failure
    if later_hard_failure:
        assert starts == list(range(6))
        assert isinstance(outcomes[5], RuntimeError)
        assert module.classify_provider_error(outcomes[5]) == "candidate_misconfigured"
    else:
        assert any(not r["dispatched"] for rs in receipts.values() for r in rs)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failed_index", "wrapped", "recovery"),
    [(0, False, False), (1, False, False), (1, True, False), (0, False, True)],
)
async def test_first_quota_response_stops_all_further_dispatch(
    monkeypatch, failed_index, wrapped, recovery
):
    spec = importlib.util.spec_from_file_location("quota_stop_probe_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls, receipts = [], {}
    clock = [0.0]

    async def sleep(delay):
        clock[0] += delay

    async def probe(index):
        calls.append(index)
        if index != failed_index:
            return
        if recovery and calls.count(index) == 1:
            raise TimeoutError()
        error = RuntimeError("Synthetic structured quota refusal")
        error.status_code = 429
        if wrapped:
            raise RuntimeError("Synthetic ADK presentation wrapper") from error
        raise error

    monkeypatch.setattr(module, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    outcomes = await module._run_paced_probes(
        [(str(i), lambda i=i: probe(i)) for i in range(3)], attempts=receipts
    )
    assert calls == ([0, 1, 2, 0] if recovery else list(range(failed_index + 1)))
    assert module.is_resource_exhausted(outcomes[failed_index])
    assert module._is_transient_probe_error(outcomes[failed_index]) is False
    for index in range(3):
        if index in calls:
            continue
        assert outcomes[index] is not None
        assert module.classify_provider_error(outcomes[index]) == "provider_unavailable"
        assert module.is_resource_exhausted(outcomes[index]) is False
        assert receipts[str(index)] == [
            {
                "ok": False,
                "dispatched": False,
                "elapsed_ms": 0,
                "classification": "provider_unavailable",
                "resource_exhausted": False,
                "blocked_by": "prior_resource_exhausted",
            }
        ]


@pytest.mark.parametrize(
    ("environment", "locations", "refuses"),
    [
        ("dev", ("global",), False),
        ("dev", ("global", "us-central1"), True),
        ("dev", (), True),
        ("uat", ("global", "us-central1"), False),
    ],
)
def test_dev_probe_refuses_regional_quota_failover_before_dispatch(
    monkeypatch, environment, locations, refuses
):
    from types import SimpleNamespace

    spec = importlib.util.spec_from_file_location("probe_location_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setattr(
        module, "managed_ai_settings", lambda: SimpleNamespace(project="synthetic-project")
    )
    monkeypatch.setattr(
        module.ManagedGeminiRuntimeBinding,
        "from_environment",
        classmethod(
            lambda cls, **kwargs: cls(
                project=kwargs.get("vertex_project", "synthetic-project"),
                locations=locations,
                auth_mode="vertex_adc",
            )
        ),
    )
    if refuses:
        with pytest.raises(RuntimeError, match="one location"):
            module._readiness_bindings()
    else:
        binding, _, chat = module._readiness_bindings()
        assert binding.locations == locations and chat.locations == locations


def test_pinned_vertex_sdk_without_retry_options_makes_one_http_attempt(monkeypatch):
    import httpx
    from google import genai
    from google.auth.credentials import AnonymousCredentials
    from google.genai.errors import ClientError

    calls = []

    def quota_response(request):
        calls.append((request.method, str(request.url)))
        return httpx.Response(
            429,
            json={
                "error": {
                    "code": 429,
                    "status": "RESOURCE_EXHAUSTED",
                    "message": "Synthetic quota refusal",
                }
            },
            request=request,
        )

    def refuse_network(*args, **kwargs):
        raise AssertionError("SDK retry test must never access the network")

    import requests

    monkeypatch.setattr(requests.sessions.Session, "request", refuse_network)
    transport = httpx.Client(transport=httpx.MockTransport(quota_response))
    credentials = AnonymousCredentials()
    credentials.token = "synthetic-transport-only"
    client = genai.Client(
        vertexai=True,
        project="synthetic-project",
        location="global",
        credentials=credentials,
        http_options={"httpx_client": transport},
    )
    try:
        with pytest.raises(ClientError) as caught:
            client.models.generate_content(model="gemini-3.7-flash", contents="Synthetic request")
        assert caught.value.code == 429
        assert len(calls) == 1
    finally:
        client.close()
        transport.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("exhausted", [False, True])
async def test_adk_readiness_leaves_answer_budget_and_rejects_truncation(exhausted):
    """Live regression: minimal thinking exhausted 64 tokens before any answer."""
    spec = importlib.util.spec_from_file_location("adk_answer_budget_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    requests = []

    class NativeAdk:
        async def generate_content_async(self, request, *, stream):
            requests.append(request)
            assert stream is False
            if exhausted or request.config.max_output_tokens <= 64:
                yield module.LlmResponse(error_code="MAX_TOKENS", error_message="")
            else:
                yield module.LlmResponse(
                    content=module.types.Content(parts=[module.types.Part(text="OK")])
                )

    if exhausted:
        with pytest.raises(RuntimeError, match="MAX_TOKENS"):
            await module._probe_adk_response(NativeAdk(), "gemini-3.7-flash")
    else:
        await module._probe_adk_response(NativeAdk(), "gemini-3.7-flash")
    assert len(requests) == 1
    assert 256 <= requests[0].config.max_output_tokens <= 1024
