"""Host installation authority, constrained execution and interrupted TLS recovery."""

from __future__ import annotations

import json
import os
import ssl
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from browser_runtime.azure_host import config, credentials, engine, runner, tls
from hushh_mcp.services.azure_setup_plan import PlanInputs
from hushh_mcp.services.azure_vm_host_plan import build_vm_host_plan
from hushh_mcp.services.azure_vm_host_readback import VmHostReadbackRefused, require_host_resource


def installation():
    identity = {
        "version": 1,
        "resource_id": "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/owner/providers/Microsoft.Compute/virtualMachines/agent",
        "vm_id": "44444444-4444-4444-4444-444444444444",
        "client_id": "55555555-5555-5555-5555-555555555555",
        "hushh_id": "ha1_owner",
        "image_digest": "sha256:" + "a" * 64,
        "generation": "vm_" + "b" * 32,
    }
    return {
        "version": 1,
        "installation": identity,
        "tenant_id": "66666666-6666-6666-6666-666666666666",
        "image": "ownerregistry.azurecr.io/pod@" + identity["image_digest"],
        "hostname": "owner.example.com",
        "signing_secret": "https://owner.vault.azure.net/secrets/signing/" + "c" * 32,
        "environment": {
            "HUSSH_ID": identity["hushh_id"],
            "AZURE_CLIENT_ID": identity["client_id"],
            "HUSSH_POD_INCARNATION": identity["generation"],
            "PORT": "8080",
        },
    }


@pytest.mark.parametrize(
    "fault",
    [
        "digest",
        "tag",
        "identity",
        "endpoint",
        "unversioned_secret",
        "secret_redirect",
        "signing_value",
        "model_key",
        "log_key",
        "memory_key",
        "alternate_identity",
        "exec_environment",
        "platform",
        "unknown",
    ],
)
def test_installation_cannot_change_identity_image_endpoint_or_secret_custody(fault):
    value = installation()
    if fault == "digest":
        value["installation"]["image_digest"] = "sha256:" + "d" * 64
    elif fault == "tag":
        value["image"] = "ownerregistry.azurecr.io/pod:latest"
    elif fault == "identity":
        value["environment"]["AZURE_CLIENT_ID"] = "different"
    elif fault == "endpoint":
        value["hostname"] = "localhost:8080"
    elif fault == "unversioned_secret":
        value["signing_secret"] = value["signing_secret"].rsplit("/", 1)[0]
    elif fault == "secret_redirect":
        value["signing_secret"] += "?redirect=https://other.example"
    elif fault == "signing_value":
        value["environment"]["APP_SIGNING_KEY"] = "synthetic-private-value"
    elif fault == "model_key":
        value["environment"]["GEMINI_API_KEY"] = "synthetic-private-value"
    elif fault in {"log_key", "memory_key", "alternate_identity"}:
        name = {
            "log_key": "HUSSH_POD_LOG_KEY",
            "memory_key": "HUSSH_POD_MEMORY_KEY",
            "alternate_identity": "AZURE_FEDERATED_TOKEN_FILE",
        }[fault]
        value["environment"][name] = "synthetic-private-value"
    elif fault == "exec_environment":
        value["environment"]["LD_PRELOAD"] = "/unapproved.so"
    elif fault == "platform":
        value["environment"]["IDENTITY_ENDPOINT"] = "https://other.example"
    else:
        value["options"] = ["--privileged"]
    with pytest.raises(config.HostRefused):
        config.validate(value)


def test_image_update_joins_old_service_before_promotion_and_keeps_repairable_failure(
    monkeypatch, tmp_path
):
    from browser_runtime.azure_host import update
    from hushh_mcp.services.azure_vm_host_bundle import replacement_step

    previous = installation()
    image = "ownerregistry.azurecr.io/pod@sha256:" + "d" * 64
    cursor = {"seq": 2, "sha": "e" * 64}
    request = update.payload(previous, image=image, operation_id="update_123", idle_record=cursor)
    (tmp_path / "installation.json").write_bytes(update.canonical(previous))
    monkeypatch.setattr(update, "ROOT", tmp_path)
    monkeypatch.setattr(
        update, "load", lambda: json.loads((tmp_path / "installation.json").read_bytes())
    )
    monkeypatch.setattr(update, "protected_read", lambda path, **_: path.read_bytes())
    monkeypatch.setattr(update, "require_vm", lambda current: config.validate(current))
    running, events = [True], []

    def observe():
        if not running[0]:
            return None
        current = update.load()
        return {
            "State": {"Running": True},
            "Config": {
                "Image": current["image"],
                "Labels": {"husshGeneration": current["installation"]["generation"]},
            },
        }

    def command(*args, **_kwargs):
        events.append(args[1])
        if args[1] == "stop":
            assert update.load() == previous  # no live bundle/config overwrite
            running[0] = False
        if args[1] == "start":
            assert update.load()["image"] == image
            running[0] = True
        return b"inactive" if args[1] == "show" else b""

    monkeypatch.setattr(update, "observe_container", observe)
    monkeypatch.setattr(update, "command", command)
    monkeypatch.setattr(update, "pull", lambda _config: events.append("pull"))
    receipt = update._execute(request)
    assert events == ["pull", "stop", "show", "start"]
    assert receipt["stage"] == "restart_requested" and receipt["application_verified"] is False
    assert update.load()["environment"] == {
        **previous["environment"],
        "HUSSH_POD_INSTALLED_IMAGE_DIGEST": "sha256:" + "d" * 64,
    }
    assert update._execute(request) == receipt and events == ["pull", "stop", "show", "start"]
    step, _digest = replacement_step(
        previous, image=image, operation_id="update_123", idle_record=cursor
    )
    assert "apt-get" not in step.body["script"][0]
    receipt["stage"] = "promoting"
    update._write("image-update.json", receipt)
    with pytest.raises(config.HostRefused, match="RECONCILIATION_REQUIRED"):
        update._execute(request)


@pytest.mark.parametrize(
    "fault", ["identity", "cursor", "mutable_image", "other_registry", "configuration"]
)
def test_image_update_cannot_broaden_approved_host_or_replay_terms(fault):
    from browser_runtime.azure_host import update

    previous = installation()
    request = update.payload(
        previous,
        image="ownerregistry.azurecr.io/pod@sha256:" + "d" * 64,
        operation_id="update_123",
        idle_record={"seq": 2, "sha": "e" * 64},
    )
    if fault == "identity":
        request["installation"]["generation"] = "vm_" + "f" * 32
    elif fault == "cursor":
        request["idle_record"]["seq"] = 0
    elif fault == "mutable_image":
        request["image"] = "ownerregistry.azurecr.io/pod:latest"
    elif fault == "other_registry":
        request["image"] = "anotherregistry.azurecr.io/pod@sha256:" + "d" * 64
    else:
        request["previous_configuration_sha256"] = "0" * 64
    with pytest.raises(config.HostRefused):
        update.target(previous, request)


def host_config():
    return {
        "Privileged": False,
        "PidMode": "",
        "IpcMode": "private",
        "NetworkMode": "default",
        "Memory": 2147483648,
        "MemorySwap": 2147483648,
        "NanoCpus": 1000000000,
        "PidsLimit": 192,
        "CapAdd": ["SETUID", "SETGID", "SETPCAP"],
        "CapDrop": ["ALL"],
        "AutoRemove": False,
        "MaskedPaths": ["/proc/kcore", "/sys/firmware"],
        "ReadonlyPaths": ["/proc/sys", "/sys/fs/cgroup"],
    }


def test_proc_workaround_retains_other_system_paths_and_equivalent_denials():
    original = host_config()
    observed, profile = engine.transform(original, "profile hussh-owner-pod {\n}\n")
    assert original == host_config()
    assert observed["MaskedPaths"] == ["/sys/firmware"]
    assert observed["ReadonlyPaths"] == ["/sys/fs/cgroup"]
    assert "deny /proc/kcore rwklmx," in profile and "deny /proc/kcore/** rwklmx," in profile
    assert "deny /proc/sys w," in profile and "deny /proc/sys/** w," in profile
    # Actual Docker 29.1.3 readback has no non-proc readonly entries. Empty
    # output is valid only because every original entry is still denied.
    actual_default = host_config()
    actual_default["ReadonlyPaths"] = [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
    ]
    observed, profile = engine.transform(actual_default, "profile hussh-owner-pod {\n}\n")
    assert observed["ReadonlyPaths"] == []
    assert all(f"deny {path} w," in profile for path in actual_default["ReadonlyPaths"])


@pytest.mark.parametrize(
    "field,value",
    [
        ("Privileged", True),
        ("CapAdd", ["SYS_ADMIN"]),
        ("PidMode", "host"),
        ("NetworkMode", "host"),
        ("MemorySwap", -1),
        ("PidsLimit", -1),
        ("MaskedPaths", ["/sys/firmware"]),
    ],
)
def test_executor_refuses_weakened_launch_policy(field, value):
    current = host_config()
    current[field] = value
    with pytest.raises(config.HostRefused):
        engine.transform(current, "profile hussh-owner-pod {\n}\n")


@pytest.mark.parametrize("fault", [None, "image", "entrypoint", "command", "profile"])
def test_entrypoint_only_image_is_preserved_without_synthetic_overlay(fault):
    entrypoint = ["/usr/local/bin/python", "-I", "-S", "/opt/browser/pod_entrypoint.py"]
    image = {"Id": "sha256:" + "e" * 64, "Config": {"Entrypoint": entrypoint}}
    installed = {
        "Image": image["Id"],
        "Config": {"Entrypoint": entrypoint, "Cmd": None},
        "AppArmorProfile": config.PROFILE,
    }
    if fault == "image":
        installed["Image"] = "sha256:" + "f" * 64
    elif fault == "entrypoint":
        installed["Config"]["Entrypoint"] = ["/unapproved.py"]
    elif fault == "command":
        installed["Config"]["Cmd"] = ["synthetic-probe"]
    elif fault == "profile":
        installed["AppArmorProfile"] = "unconfined"
    if fault:
        with pytest.raises(config.HostRefused, match="IMAGE_CHANGED"):
            engine.require_image(installed, image)
    else:
        engine.require_image(installed, image)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/shadow",
        "https://169.254.169.254/token",
        "http://localhost/token",
        "https://owner.vault.azure.net@other.example/secrets/a/" + "a" * 32,
        "https://ownerregistry.azurecr.io:443/oauth2/exchange",
        "https://owner.vault.azure.net/secrets/signing/latest",
    ],
)
def test_host_credential_transport_refuses_unapproved_recipients_before_io(monkeypatch, url):
    monkeypatch.setattr(
        credentials, "build_opener", lambda *_: pytest.fail("No IO before exact endpoint admission")
    )
    with pytest.raises(config.HostRefused, match="ENDPOINT_REFUSED"):
        credentials._json(url)


def test_credentials_select_exact_uami_and_never_fall_back(monkeypatch):
    requests = []

    def respond(url, **kwargs):
        requests.append((url, kwargs))
        return {"access_token": "synthetic-token"}

    monkeypatch.setattr(credentials, "_json", respond)
    assert credentials._token(installation(), "https://vault.azure.net") == "synthetic-token"
    assert "client_id=55555555-5555-5555-5555-555555555555" in requests[0][0]
    assert requests[0][1] == {"headers": {"Metadata": "true"}}
    monkeypatch.setattr(
        credentials,
        "_json",
        lambda *_args, **_kwargs: {
            "resourceId": installation()["installation"]["resource_id"],
            "vmId": "another-vm",
            "osType": "Linux",
            "azEnvironment": "AZUREPUBLICCLOUD",
        },
    )
    with pytest.raises(config.HostRefused, match="IDENTITY_CHANGED"):
        credentials.require_vm(installation())


def test_cleanup_never_stops_another_host_run(monkeypatch):
    monkeypatch.setattr(
        engine,
        "observe_container",
        lambda: {"Config": {"Labels": {"husshHostRun": "someone-else"}}},
    )
    monkeypatch.setattr(
        engine.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("Foreign container cannot be stopped"),
    )
    with pytest.raises(config.HostRefused, match="NOT_OWNED"):
        engine.clean("this-run")


def test_application_failure_survives_diagnostic_failure_and_cleans_only_its_run(monkeypatch):
    from types import SimpleNamespace

    events, cleaned = [], []
    monkeypatch.setattr(runner, "_prepare", lambda: installation())
    monkeypatch.setattr(runner, "remove_stopped", lambda _: None)
    monkeypatch.setattr(runner, "prepare_signing_secret", lambda _: None)
    monkeypatch.setattr(runner, "create", lambda *_: None)
    monkeypatch.setattr(
        runner.subprocess, "run", lambda *_args, **_kw: SimpleNamespace(returncode=1)
    )
    monkeypatch.setattr(
        runner, "failure_summary", lambda _: (_ for _ in ()).throw(OSError("private text"))
    )
    monkeypatch.setattr(runner, "clean", cleaned.append)
    monkeypatch.setattr(runner, "event", lambda stage, **values: events.append((stage, values)))
    with pytest.raises(config.HostRefused, match="HOST_APPLICATION_STOPPED"):
        runner.main()
    assert len(cleaned) == 1 and len(cleaned[0]) == 32
    assert ("application_stopped", {}) in events
    assert ("application_diagnostic_unavailable", {}) in events
    assert events[-1] == ("execution_failed", {"code": "HOST_APPLICATION_STOPPED"})
    assert "private text" not in str(events)


def _pair(serial):
    private = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "owner.example.com")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private.public_key())
        .serial_number(serial)
        .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=2))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("owner.example.com")]), critical=False
        )
        .sign(private, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM), private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )


def test_tls_atomic_pair_recovers_interruption_and_restrictive_umask(monkeypatch, tmp_path):
    monkeypatch.setattr(tls, "TLS", tmp_path / "tls")
    monkeypatch.setattr(
        tls.os, "chown", lambda *_: None
    )  # local user; cloud UID readback is independent
    first, second = _pair(1), _pair(2)
    mask = os.umask(0o077)
    try:
        tls._publish(*first)
        previous = os.readlink(tls.TLS / "current")
        replace = os.replace
        monkeypatch.setattr(
            tls.os,
            "replace",
            lambda *_: (_ for _ in ()).throw(OSError("synthetic publication interruption")),
        )
        with pytest.raises(OSError):
            tls._publish(*second)
        assert os.readlink(tls.TLS / "current") == previous
        monkeypatch.setattr(tls.os, "replace", replace)
        tls._publish(*second)
        current = tls.TLS / "current"
        assert os.readlink(current) != previous
        assert tls.TLS.stat().st_mode & 0o777 == 0o750
        assert current.stat().st_mode & 0o777 == 0o750
        assert (current / "privkey.pem").stat().st_mode & 0o777 == 0o640
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(current / "fullchain.pem", current / "privkey.pem")
        assert not any(p.name.startswith(".pending-") for p in tls.TLS.iterdir())
        assert len([p for p in tls.TLS.iterdir() if p.is_dir() and not p.is_symlink()]) == 2
    finally:
        os.umask(mask)


def test_vm_replay_cannot_adopt_foreign_or_weakened_host_resources(monkeypatch):
    inputs = PlanInputs(
        hushh_id="ha1_owner",
        tenant_id="66666666-6666-6666-6666-666666666666",
        subscription_id="22222222-2222-2222-2222-222222222222",
        location="northcentralus",
        resource_group="owner",
        nonce="synthetic",
    )
    plan = build_vm_host_plan(
        inputs,
        generation="vm_" + "b" * 32,
        image_digest="sha256:" + "a" * 64,
        ssh_public_key="ssh-rsa " + "A" * 512,
    )
    for step in plan.steps:
        observed = {"id": step.path, **deepcopy(step.body)}
        observed["properties"]["provisioningState"] = "Succeeded"
        if step.api == "virtual_machines":
            for identity in observed["identity"]["userAssignedIdentities"].values():
                identity.update(clientId="expected-client", principalId="expected-principal")
        require_host_resource(step, observed)
        observed["tags"]["husshPodGeneration"] = "another-owner"
        with pytest.raises(VmHostReadbackRefused):
            require_host_resource(step, observed)
    step = plan.steps[0]
    observed = {"id": step.path, **deepcopy(step.body)}
    observed["properties"].update(provisioningState="Succeeded")
    observed["properties"]["securityRules"].append({"name": "unapproved-ssh"})
    with pytest.raises(VmHostReadbackRefused):
        require_host_resource(step, observed)
    step = plan.steps[-1]
    observed = {"id": step.path, **deepcopy(step.body)}
    observed["properties"]["provisioningState"] = "Succeeded"
    for identity in observed["identity"]["userAssignedIdentities"].values():
        identity.update(clientId="expected-client", principalId="expected-principal")
    observed["identity"]["userAssignedIdentities"]["/unapproved/identity"] = {
        "clientId": "other",
        "principalId": "other",
    }
    with pytest.raises(VmHostReadbackRefused, match="IDENTITY_CHANGED"):
        require_host_resource(step, observed)
