"""Tests for the pure/guard logic of the Cloud Run REST client.

The HTTP paths are exercised end-to-end by the live GCP validation (dev-only);
here we cover the pure helpers + the fail-closed guards.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.gcp_run_client import GcpRunClient, load_operator_credentials


def test_service_url_extraction():
    assert GcpRunClient.service_url({"status": {"url": "https://x.run.app"}}) == "https://x.run.app"
    assert GcpRunClient.service_url(None) is None
    assert GcpRunClient.service_url({}) is None
    assert GcpRunClient.service_url({"status": {}}) is None


def test_ready_failure_distinguishes_false_from_unknown():
    """`wait_ready` answers (False, svc) for BOTH a definitive startup failure and a
    plain timeout. `ready_failure` is the parser that makes the tri-state legible:
    only Ready=='False' -- the platform's own verdict -- reads as a failure; True,
    Unknown, an absent Ready condition, and no service at all are all None, because
    a slow boot must never be promoted to a dead one."""

    def _svc(status: str, message: str | None = None) -> dict:
        condition: dict = {"type": "Ready", "status": status}
        if message is not None:
            condition["message"] = message
        return {"status": {"conditions": [condition]}}

    assert (
        GcpRunClient.ready_failure(_svc("False", "container failed to start and listen"))
        == "container failed to start and listen"
    )
    # A verdict with no message is still a verdict, with the documented fallback.
    assert GcpRunClient.ready_failure(_svc("False")) == "startup failed"
    assert GcpRunClient.ready_failure(_svc("True")) is None
    assert GcpRunClient.ready_failure(_svc("Unknown")) is None
    assert GcpRunClient.ready_failure({"status": {"conditions": []}}) is None
    assert GcpRunClient.ready_failure(None) is None


def test_load_operator_credentials_requires_env(monkeypatch):
    # With the key env absent AND no attached identity to fall back to -- the
    # outside-GCP / CI case -- the loader must fail closed rather than silently
    # returning nothing. The shipped function tries Application Default Credentials
    # when the key is unset, so patch google.auth.default to stand in for "no
    # attached service account"; without this the contract only holds by accident
    # on a machine where ADC happens to be unconfigured.
    import google.auth
    from google.auth.exceptions import DefaultCredentialsError

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)

    def _no_attached_identity(*_args, **_kwargs):
        raise DefaultCredentialsError("no attached identity")

    monkeypatch.setattr(google.auth, "default", _no_attached_identity)
    with pytest.raises(RuntimeError):
        load_operator_credentials()


def test_client_requires_project():
    # Guard fires before any credential work (credentials passed to skip loading).
    with pytest.raises(RuntimeError):
        GcpRunClient(project="", region="us-central1", credentials=object())


# --- the restart primitive ---------------------------------------------------------------
#
# `merge_for_replace` is the pure half of the in-place replace that backs "restart my
# agent". It is tested here rather than only in the live validation because every one
# of these properties fails SILENTLY: a dropped `resourceVersion` still returns 200, a
# stripped system field is only noticed later, and an unchanged template reports a
# successful heal while restarting nothing at all.


def _live_service() -> dict:
    """A service as the API returns it -- with fields no renderer ever emits."""
    return {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": "one-pod-abc",
            "namespace": "hushh-pda-dev",
            "uid": "1f2e3d4c-0000-0000-0000-abcdefabcdef",
            "resourceVersion": "AAAB1234",
            "creationTimestamp": "2026-08-01T00:00:00Z",
            "labels": {"app": "hussh-one-pod", "set-by-someone-else": "keep-me"},
            "annotations": {
                "serving.knative.dev/creator": "operator@hushh-pda-dev.iam.gserviceaccount.com",
                "run.googleapis.com/ingress": "internal",
            },
        },
        "spec": {"template": {"metadata": {"annotations": {"old": "1"}}, "spec": {}}},
        "status": {"url": "https://one-pod-abc.run.app", "conditions": []},
    }


def _desired() -> dict:
    return {
        "metadata": {
            "name": "one-pod-abc",
            "labels": {"app": "hussh-one-pod", "hussh-tier": "logical"},
            "annotations": {"run.googleapis.com/ingress": "internal"},
        },
        "spec": {"template": {"metadata": {"annotations": {"new": "2"}}, "spec": {}}},
    }


def test_replace_preserves_server_owned_metadata():
    """The rendered config has never heard of uid/creationTimestamp/creator. Posting it
    as if it were the whole object would drop them."""
    merged = GcpRunClient.merge_for_replace(_live_service(), _desired())
    meta = merged["metadata"]
    assert meta["uid"] == "1f2e3d4c-0000-0000-0000-abcdefabcdef"
    assert meta["creationTimestamp"] == "2026-08-01T00:00:00Z"
    assert (
        meta["annotations"]["serving.knative.dev/creator"]
        == "operator@hushh-pda-dev.iam.gserviceaccount.com"
    )


def test_replace_carries_the_resource_version_for_optimistic_concurrency():
    """Without it the PUT is a last-writer-wins clobber of whatever changed since the
    read -- which is exactly the race a heal loop runs into."""
    merged = GcpRunClient.merge_for_replace(_live_service(), _desired())
    assert merged["metadata"]["resourceVersion"] == "AAAB1234"


def test_replace_takes_the_desired_spec_and_merges_labels():
    merged = GcpRunClient.merge_for_replace(_live_service(), _desired())
    assert merged["spec"]["template"]["metadata"]["annotations"]["new"] == "2"
    # Desired labels applied...
    assert merged["metadata"]["labels"]["hussh-tier"] == "logical"
    # ...without stripping one this renderer does not emit.
    assert merged["metadata"]["labels"]["set-by-someone-else"] == "keep-me"


def test_replace_strips_server_owned_status():
    merged = GcpRunClient.merge_for_replace(_live_service(), _desired())
    assert "status" not in merged


def test_a_nonce_makes_the_revision_genuinely_new():
    """THE failure this guards: Cloud Run mints a new revision only when the template
    changes. Replaying an identical template is accepted, changes nothing, and restarts
    nothing -- while the caller records a successful heal against a container that is
    still broken."""
    desired = _desired()
    without = GcpRunClient.merge_for_replace(_live_service(), desired)
    with_nonce = GcpRunClient.merge_for_replace(_live_service(), desired, revision_nonce="heal-1")

    assert without["spec"]["template"] == desired["spec"]["template"], (
        "no nonce means the template is replayed verbatim -- no new revision"
    )
    assert with_nonce["spec"]["template"] != desired["spec"]["template"]
    assert (
        with_nonce["spec"]["template"]["metadata"]["annotations"]["hussh/restart-nonce"] == "heal-1"
    )
    # The nonce is additive: it must not displace what the renderer put there.
    assert with_nonce["spec"]["template"]["metadata"]["annotations"]["new"] == "2"


def test_two_heals_produce_two_different_templates():
    """A second heal has to differ from the first, or the second one is the no-op."""
    desired = _desired()
    first = GcpRunClient.merge_for_replace(_live_service(), desired, revision_nonce="heal-1")
    second = GcpRunClient.merge_for_replace(_live_service(), desired, revision_nonce="heal-2")
    assert first["spec"]["template"] != second["spec"]["template"]


def test_replace_refuses_to_stand_in_for_a_create():
    """A replace is not a create. Conflating them turns "restart my agent" into
    "provision a new one" -- a different act, with a different HusshID at the end of it."""
    client = GcpRunClient.__new__(GcpRunClient)  # no credentials, no network
    client._base = "https://example.invalid"  # type: ignore[attr-defined]
    client.get_service = lambda name: None  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="no such Cloud Run service"):
        client.replace_service("one-pod-missing", _desired())


# --- Idempotent host creation: adopt an existing service on 409 -------------------
# A retry of a stuck 'provisioning' row targets the same DETERMINISTIC service name
# (one-pod-{slug(hushh_id)}) and gets 409 AlreadyExists. Adopting the existing
# service instead of raising forever is what stops a row and its host from
# permanently disagreeing -- the single most likely pod orphan.


class _Resp409:
    status_code = 409

    def json(self):
        return {}

    def raise_for_status(self):
        raise RuntimeError("409 should have been adopted, not raised")


def _client_no_net():
    client = GcpRunClient.__new__(GcpRunClient)
    client._base = "https://example.invalid"  # type: ignore[attr-defined]
    client._headers = lambda: {}  # type: ignore[method-assign,attr-defined]
    return client


def test_create_service_adopts_existing_on_409(monkeypatch):
    import requests

    adopted = {"metadata": {"name": "one-pod-x"}, "status": {"url": "https://x.run.app"}}
    client = _client_no_net()
    client.get_service = lambda name: adopted if name == "one-pod-x" else None  # type: ignore[method-assign]
    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp409())

    result = client.create_service({"metadata": {"name": "one-pod-x"}})
    assert result == adopted  # the existing host is adopted, no raise


def test_exclusive_create_refuses_conflict_before_adoption(monkeypatch):
    import requests

    client = _client_no_net()

    def forbidden_read(name):
        raise AssertionError("exclusive creation must not adopt")

    client.get_service = forbidden_read
    monkeypatch.setattr(requests, "post", lambda *args, **kwargs: _Resp409())
    with pytest.raises(RuntimeError, match="already owned"):
        client.create_service({"metadata": {"name": "synthetic-pod"}}, adopt_existing=False)


@pytest.mark.parametrize("status", [202, 204, 301, 302])
def test_exclusive_create_never_accepts_redirect_or_nonterminal_ack(monkeypatch, status):
    from types import SimpleNamespace

    import requests

    def post(*args, **kwargs):
        assert kwargs["allow_redirects"] is False
        return SimpleNamespace(status_code=status, raise_for_status=lambda: None, json=lambda: {})

    monkeypatch.setattr(requests, "post", post)
    with pytest.raises(RuntimeError, match="not confirmed"):
        _client_no_net().create_service(
            {"metadata": {"name": "synthetic-pod"}}, adopt_existing=False
        )


def _incarnation_client(monkeypatch, observations, delete_status=200):
    from types import SimpleNamespace

    import requests

    client = _client_no_net()
    client._project = "synthetic-project"
    client._region = "us-central1"
    observed = iter(observations)
    deletes = []

    def get(url, **kwargs):
        assert (
            url
            == "https://run.googleapis.com/v2/projects/synthetic-project/locations/us-central1/services/synthetic-pod"
        )
        assert kwargs["allow_redirects"] is False
        status, body = next(observed)
        return SimpleNamespace(status_code=status, json=lambda: body)

    def delete(url, **kwargs):
        assert kwargs["allow_redirects"] is False
        deletes.append(kwargs["params"])
        return SimpleNamespace(status_code=delete_status)

    monkeypatch.setattr(requests, "get", get)
    monkeypatch.setattr(requests, "delete", delete)
    return client, deletes


def test_incarnation_delete_uses_read_etag_and_waits_for_absence(monkeypatch):
    value = {"uid": "synthetic-uid", "etag": "version-one"}
    client, deletes = _incarnation_client(monkeypatch, [(200, value), (200, value), (404, {})])
    client.delete_service("synthetic-pod", expected_uid="synthetic-uid", interval_s=0)
    assert deletes == [{"etag": "version-one"}]


@pytest.mark.parametrize(
    "observation",
    [
        (200, {"uid": "foreign-uid", "etag": "version-one"}),
        (200, {"uid": "synthetic-uid"}),
        (200, {}),
        (200, []),
        (403, {}),
        (302, {}),
    ],
)
def test_incarnation_delete_refuses_unproven_ownership_without_delete(monkeypatch, observation):
    client, deletes = _incarnation_client(monkeypatch, [observation])
    with pytest.raises(RuntimeError):
        client.delete_service("synthetic-pod", expected_uid="synthetic-uid")
    assert not deletes


def test_already_absent_incarnation_needs_no_delete(monkeypatch):
    client, deletes = _incarnation_client(monkeypatch, [(404, {})])
    client.delete_service("synthetic-pod", expected_uid="synthetic-uid")
    assert not deletes


def test_replacement_between_observation_and_delete_fails_etag_precondition(monkeypatch):
    client, deletes = _incarnation_client(
        monkeypatch, [(200, {"uid": "synthetic-uid", "etag": "old-version"})], delete_status=409
    )
    with pytest.raises(RuntimeError, match="not accepted"):
        client.delete_service("synthetic-pod", expected_uid="synthetic-uid")
    assert deletes == [{"etag": "old-version"}]


def test_replacement_during_polling_is_never_deleted(monkeypatch):
    client, deletes = _incarnation_client(
        monkeypatch,
        [
            (200, {"uid": "synthetic-uid", "etag": "old-version"}),
            (200, {"uid": "foreign-uid", "etag": "new-version"}),
        ],
    )
    with pytest.raises(RuntimeError, match="incarnation changed"):
        client.delete_service("synthetic-pod", expected_uid="synthetic-uid")
    assert len(deletes) == 1


def test_delete_acknowledgement_without_absence_remains_incomplete(monkeypatch):
    import requests

    from hushh_mcp.services import gcp_run_client

    value = {"uid": "synthetic-uid", "etag": "version-one"}
    client, deletes = _incarnation_client(monkeypatch, [(200, value), (200, value)])
    clock = [0.0]
    original_get = requests.get
    calls = []

    def get(*args, **kwargs):
        calls.append(kwargs)
        response = original_get(*args, **kwargs)
        if len(calls) == 2:
            clock[0] = 2.0
        return response

    monkeypatch.setattr(requests, "get", get)
    monkeypatch.setattr(gcp_run_client.time, "monotonic", lambda: clock[0])
    with pytest.raises(RuntimeError, match="remains incomplete"):
        client.delete_service("synthetic-pod", expected_uid="synthetic-uid", timeout_s=1)
    assert len(deletes) == 1
    assert all(call["timeout"] <= 1 for call in calls)


@pytest.mark.parametrize("field", ["timeout_s", "interval_s"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), True, "1"])
def test_incarnation_delete_rejects_invalid_time_budgets_before_io(monkeypatch, field, value):
    client, deletes = _incarnation_client(monkeypatch, [])
    with pytest.raises(ValueError):
        client.delete_service("synthetic-pod", expected_uid="synthetic-uid", **{field: value})
    assert not deletes


def test_create_service_409_but_service_gone_still_raises(monkeypatch):
    import requests

    client = _client_no_net()
    client.get_service = lambda name: None  # type: ignore[method-assign]
    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp409())

    # 409 but the service truly is not there (a race) -> fall through and raise.
    with pytest.raises(RuntimeError):
        client.create_service({"metadata": {"name": "one-pod-x"}})


def test_create_service_happy_path_returns_created(monkeypatch):
    import requests

    class _Ok:
        status_code = 200

        def json(self):
            return {"metadata": {"name": "one-pod-new"}}

        def raise_for_status(self):
            return None

    client = _client_no_net()
    monkeypatch.setattr(requests, "post", lambda *a, **k: _Ok())
    result = client.create_service({"metadata": {"name": "one-pod-new"}})
    assert result["metadata"]["name"] == "one-pod-new"


def test_list_services_unwraps_items_and_passes_the_label_selector(monkeypatch):
    import requests

    captured = {}

    class _Ok:
        status_code = 200

        def json(self):
            return {
                "items": [{"metadata": {"name": "one-pod-a"}}, {"metadata": {"name": "one-pod-b"}}]
            }

        def raise_for_status(self):
            return None

    def _get(url, headers=None, params=None, timeout=None, allow_redirects=False):
        captured["url"] = url
        captured["params"] = params
        return _Ok()

    client = _client_no_net()
    monkeypatch.setattr(requests, "get", _get)
    out = client.list_services("app=hushh-one-pod,hussh-tenancy=user-owned")

    assert [s["metadata"]["name"] for s in out] == ["one-pod-a", "one-pod-b"]
    assert captured["url"].endswith("/services")
    # The selector must reach the API server-side; a client-side filter would stream
    # every service in a busy project.
    assert captured["params"] == {"labelSelector": "app=hushh-one-pod,hussh-tenancy=user-owned"}


def test_list_services_no_selector_sends_no_params(monkeypatch):
    import requests

    captured = {}

    class _Empty:
        status_code = 200

        def json(self):
            return {}  # a project with no services returns no `items` key

        def raise_for_status(self):
            return None

    def _get(url, headers=None, params=None, timeout=None, allow_redirects=False):
        captured["params"] = params
        return _Empty()

    client = _client_no_net()
    monkeypatch.setattr(requests, "get", _get)
    assert client.list_services() == []
    assert captured["params"] is None


def test_list_services_surfaces_a_permission_error_never_swallows_it(monkeypatch):
    import requests

    class _Forbidden:
        status_code = 403

        def json(self):
            return {}

        def raise_for_status(self):
            raise RuntimeError("403 Forbidden")

    client = _client_no_net()
    monkeypatch.setattr(requests, "get", lambda *a, **k: _Forbidden())
    # "could not look" must NOT read as "no such pods" -- a reclaim sweep depends on it.
    with pytest.raises(RuntimeError):
        client.list_services("app=hushh-one-pod")


# -- a stale status is not a verdict -------------------------------------------


class _ScriptedRun(GcpRunClient):
    """Enough of the client for wait_ready: a scripted get_service, no credentials."""

    def __init__(self, responses):  # noqa: D107 - deliberately skips credential loading
        self._responses = list(responses)
        self.polls = 0

    def get_service(self, name):  # type: ignore[override]
        self.polls += 1
        return self._responses[min(self.polls - 1, len(self._responses) - 1)]


def _svc(*, generation=None, observed=None, ready=None):
    metadata = {} if generation is None else {"generation": generation}
    status: dict = {}
    if observed is not None:
        status["observedGeneration"] = observed
    if ready is not None:
        status["conditions"] = [{"type": "Ready", "status": ready}]
    return {"metadata": metadata, "status": status}


def test_a_stale_ready_true_is_not_believed():
    """The failure this closes, in one object.

    Both upgrade paths PUT the service and call wait_ready with no delay, and
    get_service runs before the first sleep -- so the first poll can read the
    condition Knative has not yet had a chance to invalidate. Believing it makes the
    caller record upgraded=True, clear the failure marker, tell the person their agent
    updated, and drop the row from the candidate set, while Cloud Run keeps serving the
    old revision and the new one never boots. The three-attempt cap never engages,
    because no failure is ever recorded.
    """
    run = _ScriptedRun(
        [
            _svc(generation=2, observed=1, ready="True"),  # the PREVIOUS revision's verdict
            _svc(generation=2, observed=2, ready="False"),  # the truth, once reconciled
        ]
    )
    ready, _ = run.wait_ready("one-pod-x", timeout_s=5.0, interval_s=0)
    assert ready is False, "the old revision's Ready=True was read as the new one's"
    assert run.polls >= 2, "it returned on the first poll instead of waiting to be told"


def test_the_verdict_is_taken_once_the_controller_catches_up():
    """Not believing a stale status must not mean never believing one."""
    run = _ScriptedRun(
        [
            _svc(generation=3, observed=2, ready="False"),
            _svc(generation=3, observed=3, ready="True"),
        ]
    )
    ready, _ = run.wait_ready("one-pod-x", timeout_s=5.0, interval_s=0)
    assert ready is True


def test_a_stale_ready_false_is_not_believed_either():
    """Symmetry, and it matters: the previous revision's failure must not fail a
    deploy that has not been looked at yet."""
    run = _ScriptedRun(
        [
            _svc(generation=4, observed=3, ready="False"),
            _svc(generation=4, observed=4, ready="True"),
        ]
    )
    ready, _ = run.wait_ready("one-pod-x", timeout_s=5.0, interval_s=0)
    assert ready is True


def test_a_service_with_no_generation_is_judged_on_the_condition_alone():
    """Cloud Run Admin v1 always sends `metadata.generation`; this branch is for
    fakes and anything that does not report one. Treating an absent generation as
    'not yet observed' would hang every such caller until timeout."""
    run = _ScriptedRun([_svc(ready="True")])
    ready, _ = run.wait_ready("one-pod-x", timeout_s=5.0, interval_s=0)
    assert ready is True
    assert run.polls == 1


class _InventoryResponse:
    status_code = 200

    def __init__(self, body, error=None):
        self.body = body
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise self.error

    def json(self):
        return self.body


def test_service_inventory_reads_all_pages_with_same_filter(monkeypatch):
    import requests

    pages = iter(
        [
            {"items": [{"metadata": {"name": "first"}}], "metadata": {"continue": "opaque-next"}},
            {"items": [{"metadata": {"name": "second"}}]},
        ]
    )
    calls = []

    def get(url, **kwargs):
        assert kwargs["allow_redirects"] is False
        calls.append((url, kwargs["params"]))
        return _InventoryResponse(next(pages))

    monkeypatch.setattr(requests, "get", get)
    result = _client_no_net().list_services("app=hushh-one-pod")
    assert [row["metadata"]["name"] for row in result] == ["first", "second"]
    assert calls[0][0] == calls[1][0]
    assert calls[1][1] == {"labelSelector": "app=hushh-one-pod", "continue": "opaque-next"}


@pytest.mark.parametrize(
    "body",
    [
        [],
        None,
        {"error": {}},
        {"items": {}},
        {"items": [None]},
        {"metadata": []},
        {"metadata": {"continue": 7}},
        {"unreachable": ["synthetic-region"]},
    ],
)
def test_malformed_service_inventory_never_reports_empty_fleet(monkeypatch, body):
    import requests

    monkeypatch.setattr(requests, "get", lambda *_a, **_k: _InventoryResponse(body))
    with pytest.raises(RuntimeError, match="inventory"):
        _client_no_net().list_services()


def test_service_inventory_later_page_failure_never_returns_partial_fleet(monkeypatch):
    import requests

    responses = iter(
        [
            _InventoryResponse(
                {"items": [{"metadata": {"name": "first"}}], "metadata": {"continue": "next"}}
            ),
            _InventoryResponse({}, error=RuntimeError("synthetic denied")),
        ]
    )
    monkeypatch.setattr(requests, "get", lambda *_a, **_k: next(responses))
    with pytest.raises(RuntimeError, match="synthetic denied"):
        _client_no_net().list_services()


def test_service_inventory_repeated_continuation_refuses_partial_result(monkeypatch):
    import requests

    calls = []

    def get(*_a, **_k):
        calls.append(True)
        return _InventoryResponse({"metadata": {"continue": "same"}})

    monkeypatch.setattr(requests, "get", get)
    with pytest.raises(RuntimeError, match="repeated"):
        _client_no_net().list_services()
    assert len(calls) == 2


def test_service_inventory_page_bound_refuses_partial_result(monkeypatch):
    import requests

    from hushh_mcp.services import gcp_run_client

    calls = []

    def get(*_a, **_k):
        calls.append(True)
        return _InventoryResponse({"metadata": {"continue": str(len(calls))}})

    monkeypatch.setattr(gcp_run_client, "_MAX_SERVICE_LIST_PAGES", 2)
    monkeypatch.setattr(requests, "get", get)
    with pytest.raises(RuntimeError, match="page bound"):
        _client_no_net().list_services()
    assert len(calls) == 2


@pytest.mark.parametrize("status", [201, 204, 302, 304, 307])
def test_unexpected_status_cannot_be_an_empty_inventory(monkeypatch, status):
    import requests

    response = _InventoryResponse({})
    response.status_code = status
    monkeypatch.setattr(requests, "get", lambda *_a, **_k: response)
    with pytest.raises(RuntimeError, match="status invalid"):
        _client_no_net().list_services()


@pytest.mark.parametrize(
    "item", [{}, {"metadata": {}}, {"metadata": {"name": None}}, {"metadata": {"name": " "}}]
)
def test_unidentified_service_cannot_be_discarded_as_absence(monkeypatch, item):
    import requests

    monkeypatch.setattr(requests, "get", lambda *_a, **_k: _InventoryResponse({"items": [item]}))
    with pytest.raises(RuntimeError, match="incomplete"):
        _client_no_net().list_services()
