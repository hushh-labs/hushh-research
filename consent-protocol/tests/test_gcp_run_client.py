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

    def _get(url, headers=None, params=None, timeout=None):
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

    def _get(url, headers=None, params=None, timeout=None):
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
