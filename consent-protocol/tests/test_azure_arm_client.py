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

    def request(self, method, url, headers=None, json=None, timeout=None, allow_redirects=None):
        self.sent.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers or {}),
                "json": json,
                "allow_redirects": allow_redirects,
            }
        )
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


@pytest.mark.parametrize(
    "status,body",
    [
        (429, {}),
        (409, {"error": {"code": "AnotherOperationInProgress"}}),
    ],
)
def test_fenced_write_cannot_dispatch_an_internal_retry(status, body):
    session = _Session(_Response(status, body), _Response(200, {"id": _PATH}))
    admitted = True

    def guard():
        if not admitted:
            raise PermissionError("setup is fenced")

    def fence(_seconds):
        nonlocal admitted
        admitted = False

    client = ArmClient(_BEARER, session=session, sleep=fence, before_write=guard)
    with pytest.raises(PermissionError, match="setup is fenced"):
        client.put(_PATH, api_version="v", body={})
    assert len(session.sent) == 1
    # Observing the resource is still allowed; it cannot create another resource.
    assert client.get(_PATH, api_version="v") == {"id": _PATH}


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


def test_files_scaler_uses_managed_identity_supported_api():
    """The older live ARM schema refused CustomScaleRule.identity with HTTP 400."""
    from types import SimpleNamespace

    from hushh_mcp.services.pod_files.azure_provisioning import configure_files

    group = "/subscriptions/s/resourceGroups/g"
    identity = group + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pod"
    body = {"properties": {"template": {"containers": [{"env": []}], "scale": {}}}}
    configure_files(
        body,
        SimpleNamespace(
            files_storage_resource_id=group + "/providers/Microsoft.Storage/storageAccounts/owner",
            identity_id=identity,
            blob_url="https://owner.blob.core.windows.net/pod",
        ),
    )
    session = _Session(_Response(200, {"id": _PATH}))
    client, _ = _client(session)
    client.put(_PATH, api_version=API_VERSIONS["container_apps"], body=body)
    request = session.sent[0]
    assert request["url"].endswith("?api-version=2025-01-01")
    rule = request["json"]["properties"]["template"]["scale"]["rules"][1]["custom"]
    assert rule["identity"] == identity and "auth" not in rule


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirect_cannot_forward_owner_authority_or_private_request_body(status):
    session = _Session(_Response(status, {}, {"Location": "https://foreign.example/collect"}))
    client, _ = _client(session)
    with pytest.raises(ArmError) as refused:
        client.put(_PATH, api_version="v", body={"value": "synthetic-private-value"})
    assert refused.value.code == "UnsafeRedirect"
    assert len(session.sent) == 1 and session.sent[0]["allow_redirects"] is False
    assert "synthetic-private-value" not in str(refused.value)


@pytest.mark.parametrize(
    "url",
    [
        "https://user:private@management.azure.com/operation",
        "https://management.azure.com:8443/operation",
        "https://management.azure.com/operation#private",
        "https://management.azure.com:bad/operation",
        "https://management.azure.com/operation\n",
    ],
)
def test_unqualified_poll_authority_is_refused_without_echoing_its_contents(url):
    session = _Session(_Response(202, {}, {"Location": url}))
    client, _ = _client(session)
    with pytest.raises(ArmError) as refused:
        client.put(_PATH, api_version="v", body={})
    assert refused.value.code == "UntrustedPollUrl"
    assert len(session.sent) == 1 and url not in str(refused.value)


@pytest.mark.parametrize("initial", [201, 202])
def test_location_with_nonterminal_resource_is_polled_before_completion(initial):
    location = "https://management.azure.com/subscriptions/s/operations/create"
    session = _Session(
        _Response(
            initial, {"properties": {"provisioningState": "Creating"}}, {"Location": location}
        ),
        _Response(200, {"properties": {"provisioningState": "Succeeded"}}),
        _Response(200, {"id": _PATH}),
    )
    client, _ = _client(session)
    assert client.put(_PATH, api_version="v", body={}) == {"id": _PATH}
    assert session.sent[1]["url"] == location and len(session.sent) == 3


@pytest.mark.parametrize(
    "body,status",
    [
        ({"properties": {"provisioningState": "Creating"}}, 201),
        ({}, 202),
    ],
)
def test_missing_async_reference_cannot_report_success(body, status):
    client, _ = _client(_Session(_Response(status, body)))
    with pytest.raises(ArmError) as refused:
        client.put(_PATH, api_version="v", body={})
    assert refused.value.code == "OperationReferenceMissing"


@pytest.mark.parametrize("state", ["Failed", "Canceled"])
def test_resource_terminal_failure_is_not_a_successful_write(state):
    client, _ = _client(_Session(_Response(200, {"properties": {"provisioningState": state}})))
    with pytest.raises(ArmError) as refused:
        client.put(_PATH, api_version="v", body={})
    assert refused.value.kind == "failed"


class _MutationJournal:
    def __init__(self, *, refuse=""):
        self.events = []
        self.refuse = refuse

    def admit(self, request_id, request):
        self.events.append(("intent", request_id, request))
        return self.refuse != "intent"

    def acknowledge(self, request_id, receipt):
        self.events.append(("acknowledgement", request_id, receipt))
        return self.refuse != "acknowledgement"

    def terminal(self, request_id, outcome):
        self.events.append(("terminal", request_id, outcome))
        return self.refuse != "terminal"


def test_async_write_is_admitted_before_dispatch_and_settles_only_after_provider_completion():
    journal = _MutationJournal()
    location = "https://management.azure.com/subscriptions/s/operations/one?monitor=true&api-version=2023-05-01"

    class ObservedSession(_Session):
        def request(self, method, url, **kwargs):
            if method == "PUT":
                assert journal.events[-1][0] == "intent"
                assert kwargs["headers"]["x-ms-client-request-id"] == journal.events[-1][1]
            else:
                assert (
                    not any(event[0] == "terminal" for event in journal.events) or url != location
                )
            return super().request(method, url, **kwargs)

    session = ObservedSession(
        _Response(202, {}, {"Location": location}),
        _Response(202, {}),
        _Response(200, {}),
        _Response(200, {"id": _PATH}),
    )
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None, mutations=journal)
    assert client.put(_PATH, api_version="v", body={"private": "synthetic-private-value"}) == {
        "id": _PATH
    }
    assert [event[0] for event in journal.events] == ["intent", "acknowledgement", "terminal"]
    assert journal.events[1][2].operation_url == location
    assert journal.events[-1][2] == "succeeded"
    assert "synthetic-private-value" not in repr(journal.events) and _BEARER not in repr(
        journal.events
    )


@pytest.mark.parametrize(
    "refuse,expected_calls,code",
    [
        ("intent", 0, "MutationAdmissionUnconfirmed"),
        ("acknowledgement", 1, "MutationAcknowledgementUnconfirmed"),
        ("terminal", 1, "MutationTerminalUnconfirmed"),
    ],
)
def test_unretained_mutation_receipt_never_reports_a_successful_write(refuse, expected_calls, code):
    journal = _MutationJournal(refuse=refuse)
    session = _Session(_Response(200, {"id": _PATH}))
    client = ArmClient(_BEARER, session=session, mutations=journal)
    with pytest.raises(ArmError) as refused:
        client.put(_PATH, api_version="v", body={})
    assert refused.value.code == code and len(session.sent) == expected_calls


def test_server_error_does_not_replay_an_uncertain_mutation():
    journal = _MutationJournal()
    session = _Session(_Response(503, {}), _Response(200, {"id": _PATH}))
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None, mutations=journal)
    with pytest.raises(ArmError) as refused:
        client.put(_PATH, api_version="v", body={})
    assert refused.value.kind == "server"
    assert len(session.sent) == 1
    assert [event[0] for event in journal.events] == ["intent", "acknowledgement"]


def test_throttled_mutation_has_separate_ids_for_each_definitely_refused_attempt():
    journal = _MutationJournal()
    session = _Session(_Response(429, {}), _Response(200, {"id": _PATH}))
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None, mutations=journal)
    assert client.put(_PATH, api_version="v", body={}) == {"id": _PATH}
    admitted = [event[1] for event in journal.events if event[0] == "intent"]
    settled = [event for event in journal.events if event[0] == "terminal"]
    assert len(set(admitted)) == 2
    assert [(event[1], event[2]) for event in settled] == list(
        zip(admitted, ["refused", "succeeded"], strict=True)
    )


@pytest.mark.parametrize("method", ["PUT", "POST", "DELETE"])
def test_successful_raw_mutation_settles_without_requiring_a_wrapper(method):
    journal = _MutationJournal()
    session = _Session(_Response(200, {"id": _PATH}))
    client = ArmClient(_BEARER, session=session, mutations=journal)
    assert client.request(method, _PATH, api_version="v").body == {"id": _PATH}
    assert [event[0] for event in journal.events] == ["intent", "acknowledgement", "terminal"]


def test_fence_after_admission_records_no_dispatch_and_does_not_contact_arm():
    journal = _MutationJournal()
    session = _Session()

    def fence():
        raise PermissionError("owner execution fenced")

    client = ArmClient(_BEARER, session=session, mutations=journal, before_write=fence)
    with pytest.raises(PermissionError):
        client.put(_PATH, api_version="v", body={})
    assert session.sent == []
    assert [event[0] for event in journal.events] == ["intent", "terminal"]
    assert journal.events[-1][2] == "not_dispatched"


@pytest.mark.parametrize(
    "query",
    [
        "opaque=synthetic-value",
        "api-version=synthetic-value",
        "monitor=synthetic-value",
        "api-version=2023-05-01&api-version=2024-01-01",
        "monitor=true&monitor=false",
    ],
)
def test_opaque_poll_query_is_not_copied_into_durable_receipts(query):
    journal = _MutationJournal()
    location = "https://management.azure.com/subscriptions/s/operations/one?" + query
    session = _Session(
        _Response(202, {}, {"Location": location}), _Response(200, {}), _Response(200, {})
    )
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None, mutations=journal)
    assert client.put(_PATH, api_version="v", body={}) == {}
    receipt = journal.events[1][2]
    assert receipt.operation_url is None and len(receipt.operation_url_sha256) == 64
    assert "synthetic-value" not in repr(journal.events)


@pytest.mark.parametrize("properties", ["malformed", [], {"provisioningState": 1}])
def test_malformed_provisioning_state_does_not_complete_a_write(properties):
    journal = _MutationJournal()
    session = _Session(_Response(200, {"properties": properties}))
    client = ArmClient(_BEARER, session=session, mutations=journal)
    with pytest.raises(ArmError, match="InvalidOperationBody"):
        client.put(_PATH, api_version="v", body={})
    assert not any(event[0] == "terminal" for event in journal.events)


@pytest.mark.parametrize(
    "state",
    ["Running", "InProgress", "Accepted", {"properties": {"provisioningState": "Creating"}}],
)
def test_location_http_200_with_running_status_keeps_polling(state):
    journal = _MutationJournal()
    url = "https://management.azure.com/subscriptions/s/operations/one"
    session = _Session(
        _Response(202, {}, {"Location": url}),
        _Response(200, state if isinstance(state, dict) else {"status": state}),
        _Response(200, {"status": "Succeeded"}),
        _Response(200, {}),
    )
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None, mutations=journal)
    assert client.put(_PATH, api_version="v", body={}) == {}
    assert len(session.sent) == 4 and journal.events[-1][2] == "succeeded"


@pytest.mark.parametrize("body", [["unexpected"], {"status": "Unknown"}, {"status": []}])
def test_unrecognized_location_body_does_not_settle_mutation(body):
    journal = _MutationJournal()
    session = _Session(
        _Response(202, {}, {"Location": "https://management.azure.com/operations/one"}),
        _Response(200, body),
    )
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None, mutations=journal)
    with pytest.raises(ArmError):
        client.put(_PATH, api_version="v", body={})
    assert not any(event[0] == "terminal" for event in journal.events)


@pytest.mark.parametrize(
    "status,kind",
    [("Running", "timeout"), ("Failed", "failed"), ("Unknown", "timeout"), ([], "failed")],
)
def test_initial_operation_status_cannot_claim_synchronous_success(status, kind):
    journal = _MutationJournal()
    client = ArmClient(
        _BEARER, session=_Session(_Response(200, {"status": status})), mutations=journal
    )
    with pytest.raises(ArmError) as refused:
        client.post(_PATH, api_version="v", body={})
    assert refused.value.kind == kind
    assert not any(event[0] == "terminal" and event[2] == "succeeded" for event in journal.events)


@pytest.mark.parametrize(
    "code,settled", [("RoleAssignmentExists", True), ("AnotherOperationInProgress", False)]
)
def test_only_explicit_role_conflict_is_a_terminal_refusal(code, settled):
    journal = _MutationJournal()
    session = _Session(_Response(409, {"error": {"code": code}}))
    client = ArmClient(_BEARER, session=session).with_mutations(journal)
    with pytest.raises(ArmError):
        client.put(_PATH, api_version="v", body={}, op="assigning_roles")
    terminals = [event for event in journal.events if event[0] == "terminal"]
    assert len(session.sent) == 1
    assert [event[2] for event in terminals] == (["refused"] if settled else [])


@pytest.mark.parametrize("verdict", ["live", "failed", "unconfirmed"])
def test_exact_replacement_verdict_settles_original_request_after_lost_poll(verdict):
    from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
    from hushh_mcp.services.azure_upgrade_confirmation import confirm_replacement

    journal = _MutationJournal()
    poll = (
        "https://management.azure.com/subscriptions/s/operations/replacement?api-version=2025-01-01"
    )
    session = _Session(_Response(202, {}, {"Azure-AsyncOperation": poll}), _Response(503, {}))
    client = ArmClient(_BEARER, session=session, sleep=lambda _: None).with_mutations(journal)
    response = client.request("PUT", _PATH, api_version="v", body={}, op="deploying_agent")

    def exact_verdict():
        if verdict != "live":
            code = "UPGRADE_REVISION_FAILED" if verdict == "failed" else "UPGRADE_UNCONFIRMED"
            raise AzureSetupRefused("synthetic", code=code)
        return {"exact-incarnation-revision-and-digest": True}

    if verdict == "live":
        assert confirm_replacement(client, response, read_verdict=exact_verdict)
    else:
        with pytest.raises(AzureSetupRefused):
            confirm_replacement(client, response, read_verdict=exact_verdict)
    terminals = [event for event in journal.events if event[0] == "terminal"]
    assert [event[2] for event in terminals] == (
        [] if verdict == "unconfirmed" else ["succeeded" if verdict == "live" else "failed"]
    )
    assert (
        len(session.sent) == 2
        and session.sent[0]["headers"]["x-ms-client-request-id"] == journal.events[0][1]
    )
