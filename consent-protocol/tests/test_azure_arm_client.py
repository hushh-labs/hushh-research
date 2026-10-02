"""Raw ARM REST: pinned versions, both long-running-operation styles, typed errors."""

from __future__ import annotations

import pytest

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError

_PATH = "/subscriptions/s/resourceGroups/g/providers/Microsoft.Storage/storageAccounts/a"
_BEARER = "bearer-for-tests"  # noqa: S105 - no service exists to authenticate to


class _Response:
    def __init__(self, status: int, body=None, headers=None) -> None:
        self.status_code = status
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.content = b"x" if body is not None else b""

    def json(self):
        return self._body


class _Session:
    """Replays queued responses and records exactly what was sent."""

    def __init__(self, *responses: _Response) -> None:
        self.queue = list(responses)
        self.sent: list[dict] = []

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.sent.append({"method": method, "url": url, "headers": headers, "json": json})
        return self.queue.pop(0)


def _client(session: _Session) -> tuple[ArmClient, list[float]]:
    sleeps: list[float] = []
    return ArmClient(_BEARER, session=session, sleep=sleeps.append), sleeps


def test_every_call_pins_an_api_version_and_carries_the_bearer():
    session = _Session(_Response(200, {"id": _PATH}))
    client, _ = _client(session)
    assert client.get(_PATH, api_version=API_VERSIONS["storage"]) == {"id": _PATH}
    sent = session.sent[0]
    assert sent["url"].startswith("https://management.azure.com/subscriptions/")
    assert sent["url"].endswith(f"?api-version={API_VERSIONS['storage']}")
    assert sent["headers"]["Authorization"] == f"Bearer {_BEARER}"


@pytest.mark.parametrize(
    ("status", "kind"),
    [(401, "unauthorized"), (403, "forbidden"), (404, "not_found"), (409, "conflict"),
     (412, "conflict"), (400, "bad_request"), (500, "server")],
)  # fmt: skip
def test_refusals_are_typed_with_azures_own_code(status, kind):
    body = {"error": {"code": "SomethingAzure", "message": "  why  it  failed  "}}
    client, _ = _client(_Session(_Response(status, body)))
    with pytest.raises(ArmError) as exc:
        client.get(_PATH, api_version="2023-05-01")
    assert exc.value.kind == kind
    assert exc.value.code == "SomethingAzure"
    assert exc.value.message == "why it failed"
    assert _BEARER not in str(exc.value)


def test_get_or_none_answers_none_only_for_not_found():
    client, _ = _client(_Session(_Response(404, {}), _Response(403, {})))
    assert client.get_or_none(_PATH, api_version="v") is None
    with pytest.raises(ArmError) as exc:
        client.get_or_none(_PATH, api_version="v")
    assert exc.value.kind == "forbidden"


def test_throttling_waits_for_retry_after_then_succeeds():
    session = _Session(_Response(429, {}, {"Retry-After": "7"}), _Response(200, {"ok": True}))
    client, sleeps = _client(session)
    assert client.get(_PATH, api_version="v") == {"ok": True}
    assert sleeps == [7.0]


def test_persistent_throttling_is_a_typed_refusal():
    session = _Session(*[_Response(429, {}, {"Retry-After": "1"}) for _ in range(5)])
    client, _ = _client(session)
    with pytest.raises(ArmError) as exc:
        client.get(_PATH, api_version="v")
    assert exc.value.kind == "throttled"


def test_put_polls_azure_async_operation_then_reads_the_resource():
    op = "https://management.azure.com/subscriptions/s/providers/x/operations/1"
    session = _Session(
        _Response(201, {"properties": {"provisioningState": "Creating"}},
                  {"Azure-AsyncOperation": op, "Retry-After": "2"}),
        _Response(200, {"status": "InProgress"}),
        _Response(200, {"status": "Succeeded"}),
        _Response(200, {"properties": {"provisioningState": "Succeeded"}}),
    )  # fmt: skip
    client, sleeps = _client(session)
    body = client.put(_PATH, api_version="v", body={"location": "eastus2"})
    assert body["properties"]["provisioningState"] == "Succeeded"
    assert [s["url"] for s in session.sent[1:3]] == [op, op]
    assert session.sent[3]["method"] == "GET" and _PATH in session.sent[3]["url"]
    assert sleeps[0] == 2.0


def test_a_failed_async_operation_is_a_typed_failure():
    op = "https://management.azure.com/subscriptions/s/providers/x/operations/2"
    session = _Session(
        _Response(201, {}, {"Azure-AsyncOperation": op}),
        _Response(200, {"status": "Failed", "error": {"code": "InsufficientQuota"}}),
    )
    client, _ = _client(session)
    with pytest.raises(ArmError) as exc:
        client.put(_PATH, api_version="v", body={})
    assert (exc.value.kind, exc.value.code) == ("failed", "InsufficientQuota")


def test_post_follows_location_until_it_stops_answering_202():
    location = "https://management.azure.com/subscriptions/s/operationResults/3"
    session = _Session(
        _Response(202, None, {"Location": location}),
        _Response(202, None, {"Location": location}),
        _Response(200, {"done": True}),
    )
    client, _ = _client(session)
    assert client.post(f"{_PATH}/importImage", api_version="v", body={}) == {"done": True}


def test_the_token_is_never_sent_to_a_polling_url_off_the_arm_host():
    session = _Session(_Response(202, None, {"Location": "https://evil.example/collect"}))
    client, _ = _client(session)
    with pytest.raises(ArmError) as exc:
        client.post(f"{_PATH}/importImage", api_version="v", body={})
    assert exc.value.code == "UntrustedPollUrl"
    assert len(session.sent) == 1


def test_a_long_running_operation_has_a_deadline():
    op = "https://management.azure.com/subscriptions/s/providers/x/operations/4"
    session = _Session(_Response(201, {}, {"Azure-AsyncOperation": op}))
    now = iter([0.0, 10_000.0])
    client = ArmClient(_BEARER, session=session, sleep=lambda _s: None, clock=lambda: next(now))
    with pytest.raises(ArmError) as exc:
        client.put(_PATH, api_version="v", body={})
    assert exc.value.kind == "timeout"


def test_delete_is_idempotent():
    client, _ = _client(_Session(_Response(404, {}), _Response(200, {})))
    assert client.delete(_PATH, api_version="v") is False
    assert client.delete(_PATH, api_version="v") is True


@pytest.mark.parametrize(
    "bad", ["subscriptions/s", "/subscriptions/s?x=1", "https://evil/x", "/subscriptions/../x"]
)
def test_only_arm_resource_paths_are_accepted(bad):
    client, _ = _client(_Session())
    with pytest.raises(ValueError):
        client.get(bad, api_version="v")


def test_container_apps_writes_carry_no_if_match():
    """Container Apps returns no ETag (measured); no header pretends otherwise."""
    session = _Session(_Response(200, {"id": _PATH}))
    client, _ = _client(session)
    client.put(_PATH, api_version=API_VERSIONS["container_apps"], body={})
    assert "If-Match" not in session.sent[0]["headers"]
