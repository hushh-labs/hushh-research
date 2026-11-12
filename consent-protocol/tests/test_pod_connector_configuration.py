"""Deployment-owned public callbacks and approved existing-pod reconciliation."""

from __future__ import annotations

import base64
import copy
import json
from functools import partial

import pytest

from hushh_mcp.services import user_gcp_backend as ugb
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.gcp_run_client import GcpRunClient
from tests.test_gcp_backend import _backend as hosted_backend
from tests.test_gcp_backend import _spec as hosted_spec
from tests.test_pod_image_upgrade_path import (
    HUSHH_ID,
    NEW,
    SOURCE_NEW,
    FakeRun,
    _backend,
    _service_json,
    _spec,
    copy_log,  # noqa: F401 -- canonical fixture
)  # noqa: F401 -- canonical fixtures


@pytest.mark.parametrize("invalid", ["duplicate", "secret_ref", "foreign", "empty", "private_key"])
def test_owner_feed_verifier_repair_refuses_unreviewed_trust(monkeypatch, invalid):
    from hushh_mcp.consent import token_signing
    from hushh_mcp.services.pod_connector_configuration import (
        expected_connector_environment,
        reconcile_connector_environment,
        validate_connector_environment,
    )

    monkeypatch.setattr(
        token_signing,
        "public_verification_keys",
        lambda _: {"dev": base64.b64encode(b"p" * 32).decode()},
    )
    expected = expected_connector_environment()
    entry = expected[-1]
    assert entry["name"] == "OWNER_FEED_ED25519_PUBLIC_KEYS"
    if invalid == "duplicate":
        entries = [entry, entry]
    elif invalid == "secret_ref":
        entries = [{"name": entry["name"], "secretRef": "must-not-be-trusted"}]
    elif invalid == "foreign":
        entries = [
            {
                "name": entry["name"],
                "value": json.dumps({"other": base64.b64encode(b"q" * 32).decode()}),
            }
        ]
    elif invalid == "empty":
        with pytest.raises(RuntimeError):
            validate_connector_environment([{"name": entry["name"], "value": "{}"}])
        return
    else:
        with pytest.raises(RuntimeError):
            validate_connector_environment(
                [{"name": "OWNER_FEED_ED25519_PRIVATE_KEY", "value": "never-export"}]
            )
        return
    with pytest.raises(RuntimeError):
        reconcile_connector_environment(entries, expected)


def test_owner_feed_verifier_backfill_preserves_legacy_receipts(monkeypatch):
    from hushh_mcp.consent import token_signing
    from hushh_mcp.services.azure_upgrade_configuration import replacement_body
    from hushh_mcp.services.pod_connector_configuration import (
        expected_connector_environment,
        require_connector_environment,
    )

    monkeypatch.setattr(
        token_signing,
        "public_verification_keys",
        lambda _: {"dev": base64.b64encode(b"p" * 32).decode()},
    )
    wanted = expected_connector_environment()
    unrelated = {"name": "AZURE_OPENAI_DEPLOYMENT", "value": "one-chat"}
    app = {"properties": {"template": {"containers": [{"image": "old", "env": [unrelated]}]}}}
    new = replacement_body(app, image="approved", suffix="approved", connector_environment=wanted)
    entries = new["properties"]["template"]["containers"][0]["env"]
    assert all(entry in entries for entry in wanted)
    assert unrelated in entries
    assert any(entry["name"] == "OWNER_FEED_ED25519_PUBLIC_KEYS" for entry in entries)
    require_connector_environment(entries, wanted)
    with pytest.raises(RuntimeError):
        require_connector_environment([unrelated], wanted)
    # Old accepted operations keep their frozen, smaller public configuration.
    require_connector_environment([unrelated], [])


@pytest.mark.parametrize("provider", ["gcp", "azure"])
def test_pod_rendering_carries_only_public_connector_origin_and_sandbox_pin(monkeypatch, provider):
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.ai/")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "acct_SyntheticSandbox")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_LIVEMODE", "false")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_SECRET_KEY", "synthetic-private-sdk-key")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET", "synthetic-private-webhook-key")
    if provider == "gcp":
        render = partial(hosted_backend().render_deploy_config, hosted_spec())
        body = render()
        entries = body["spec"]["template"]["spec"]["containers"][0]["env"]
    else:
        from hushh_mcp.services.azure_container_app_renderer import render_container_app
        from tests.test_azure_container_app_renderer import _coords

        render = partial(render_container_app, hosted_spec(), _coords())
        body = render()
        entries = body["properties"]["template"]["containers"][0]["env"]
    env = {entry["name"]: entry.get("value") for entry in entries}
    assert env["APP_FRONTEND_ORIGIN"] == "https://dev.one.hussh.ai"
    assert env["SCOPE_COMMERCE_STRIPE_ACCOUNT_ID"] == "acct_SyntheticSandbox"
    assert env["SCOPE_COMMERCE_STRIPE_LIVEMODE"] == "false"
    assert "SCOPE_COMMERCE_STRIPE_SECRET_KEY" not in env
    assert "SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET" not in env
    assert "synthetic-private-sdk-key" not in str(body)
    assert "synthetic-private-webhook-key" not in str(body)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.ai/other")
    with pytest.raises(ValueError):
        render()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["user", "hosted"])
@pytest.mark.parametrize(
    "configuration", ["absent", "missing", "matching", "mismatch", "unapproved"]
)
async def test_upgrade_is_a_noop_when_the_pod_already_runs_the_current_digest(
    copy_log,  # noqa: F811 -- canonical fixture
    monkeypatch,
    configuration,
    provider,
):
    from dataclasses import replace
    from unittest.mock import Mock

    from hushh_mcp.runtime_environment import pod_connector_public_environment
    from hushh_mcp.services import pod_upgrade_handoff

    name = ugb._service_name(HUSHH_ID)
    run = FakeRun(name, existing_digest=NEW)
    monkeypatch.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "1")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_POD_PROJECT", "hussh-pda-dev")
    backend = (
        _backend(run)
        if provider == "user"
        else GcpBackend(
            project="acme-user-proj",
            image=SOURCE_NEW,
            live=True,
            client=run,
        )
    )
    values = {
        "APP_FRONTEND_ORIGIN": "https://dev.one.hussh.ai",
        "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID": "acct_synthetic",
        "SCOPE_COMMERCE_STRIPE_LIVEMODE": "false",
    }
    for key, value in values.items():
        if configuration == "absent":
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    wanted = pod_connector_public_environment(values)
    if configuration in {"matching", "mismatch"}:
        run.services[name]["spec"]["template"]["spec"]["containers"][0]["env"] = copy.deepcopy(
            wanted
        )
    if configuration == "mismatch":
        run.services[name]["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = (
            "https://uat.one.hussh.ai"
        )
    run.services[name]["status"]["latestReadyRevisionName"] = "previous-revision"
    handoff = Mock()
    monkeypatch.setattr(pod_upgrade_handoff, "PodUpgradeHandoffClient", lambda **_: handoff)
    spec = replace(
        _spec(),
        upgrade_operation_id="approved-update"
        if configuration not in {"absent", "unapproved"}
        else None,
    )
    if configuration in {"mismatch", "unapproved"}:
        with pytest.raises(RuntimeError):
            await backend.upgrade(spec)
        assert not run.replaced and not run.created and not copy_log.resolved
        handoff.prepare_and_wait.assert_not_called()
        return
    handle = await backend.upgrade(spec)
    assert handle.backend_metadata["serviceUid"] == "uid-from-cloud-run"
    changed = configuration == "missing" or provider == "hosted"
    assert len(run.replaced) == (1 if changed else 0)
    assert not run.created
    assert (handle.backend_metadata or {})["upgraded"] is changed
    if provider == "user":
        assert (handle.backend_metadata or {})["image_digest"] == NEW
    if configuration == "missing":
        assert all(
            item in run.replaced[0]["spec"]["template"]["spec"]["containers"][0]["env"]
            for item in wanted
        )
        handoff.prepare_and_wait.assert_called_once()
    elif configuration == "matching" and provider == "user":
        handoff.release.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["user", "hosted"])
@pytest.mark.parametrize("configuration", ["legacy", "frozen", "missing", "malformed"])
async def test_byoc_restart_observes_acknowledged_revision_without_copy_or_replace(
    copy_log,  # noqa: F811 -- canonical fixture
    monkeypatch,
    configuration,
    provider,
):
    name = ugb._service_name(HUSHH_ID)
    service_json = _service_json(name, NEW)
    service_json["metadata"]["generation"] = 4
    service_json["status"]["observedGeneration"] = 4
    service_json["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})[
        "hussh/restart-nonce"
    ] = _spec().upgrade_attempt_id

    class ReadOnlyRun(GcpRunClient):
        def __init__(self):
            pass

        def get_service(self, requested):
            assert requested == name
            return copy.deepcopy(service_json)

    receipt = GcpRunClient.upgrade_acknowledgement(
        service_json,
        name=name,
        expected_uid=_spec().expected_service_uid,
        attempt_id=_spec().upgrade_attempt_id,
    )
    receipt["targetImage"] = SOURCE_NEW
    backend = (
        _backend(ReadOnlyRun())
        if provider == "user"
        else GcpBackend(
            project="acme-user-proj",
            image=SOURCE_NEW,
            live=True,
            client=ReadOnlyRun(),
        )
    )
    wanted = [{"name": "APP_FRONTEND_ORIGIN", "value": "https://dev.one.hussh.ai"}]
    if configuration == "malformed":
        receipt["connectorEnvironment"] = None
    elif configuration != "legacy":
        receipt["connectorEnvironment"] = wanted
        if configuration == "frozen":
            service_json["spec"]["template"]["spec"]["containers"][0]["env"] = copy.deepcopy(wanted)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://uat.one.hussh.ai")
    if configuration in {"missing", "malformed"}:
        with pytest.raises(RuntimeError):
            await backend.observe_upgrade(_spec(), receipt)
        assert not copy_log.resolved and not copy_log.copied
        return
    handle = await backend.observe_upgrade(_spec(), receipt)
    assert handle.status == "live"
    if provider == "user":
        assert handle.backend_metadata["source_image"] == SOURCE_NEW
    assert not copy_log.resolved and not copy_log.copied


@pytest.mark.asyncio
async def test_hosted_executor_recovery_rejects_legacy_mutable_source_receipt():
    from dataclasses import replace
    from types import SimpleNamespace

    name = ugb._service_name(HUSHH_ID)
    service_json = _service_json(name, NEW)
    service_json["metadata"]["generation"] = 4
    service_json["status"]["observedGeneration"] = 4
    service_json["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})[
        "hussh/restart-nonce"
    ] = _spec().upgrade_attempt_id

    class ReadOnlyRun(GcpRunClient):
        def __init__(self):
            pass

        def get_service(self, requested):
            assert requested == name
            return copy.deepcopy(service_json)

    receipt = GcpRunClient.upgrade_acknowledgement(
        service_json,
        name=name,
        expected_uid=_spec().expected_service_uid,
        attempt_id=_spec().upgrade_attempt_id,
    )
    receipt["targetImage"] = SOURCE_NEW
    spec = replace(_spec(), hosted_files_executor=SimpleNamespace(deployed_image=NEW))
    assert await _backend(ReadOnlyRun()).observe_upgrade(spec, receipt) is None


@pytest.mark.parametrize("provider", ["gcp", "azure"])
@pytest.mark.parametrize(
    "public_entries",
    [[], [{"name": "APP_FRONTEND_ORIGIN", "value": "https://existing.synthetic.invalid"}]],
)
def test_legacy_image_helper_preserves_public_configuration_without_new_authority(
    monkeypatch, provider, public_entries
):
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://different.synthetic.invalid")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "acct_NewSyntheticSandbox")
    monkeypatch.setenv("SCOPE_COMMERCE_STRIPE_LIVEMODE", "false")
    if provider == "gcp":
        from hushh_mcp.services.pod_upgrade_configuration import (
            preserve_image_upgrade_configuration,
        )

        existing = _service_json(ugb._service_name(HUSHH_ID), NEW)
        old = existing["spec"]["template"]["spec"]["containers"][0]
        old["env"] = copy.deepcopy(public_entries)
        desired = copy.deepcopy(existing)
        desired["spec"]["template"]["spec"]["containers"][0]["env"] = [
            {"name": "APP_FRONTEND_ORIGIN", "value": "https://different.synthetic.invalid"}
        ]
        preserve_image_upgrade_configuration(existing, desired)
        observed = desired["spec"]["template"]["spec"]["containers"][0]["env"]
    else:
        from hushh_mcp.services.azure_upgrade_configuration import replacement_body

        existing = {
            "properties": {
                "template": {
                    "containers": [{"image": "previous", "env": copy.deepcopy(public_entries)}]
                }
            }
        }
        observed = replacement_body(existing, image="approved", suffix="approved")["properties"][
            "template"
        ]["containers"][0]["env"]
    assert observed == public_entries
