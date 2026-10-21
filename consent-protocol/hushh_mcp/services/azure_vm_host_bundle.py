"""Deterministic, bounded installer payload over the existing ARM action contract."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import re
import tarfile
from copy import deepcopy
from pathlib import Path

from browser_runtime.azure_host.config import APPARMOR_SHA256, SECCOMP_SHA256, validate
from hushh_mcp.services.azure_setup_plan import ArmStep

_SOURCE = Path(__file__).resolve().parents[2] / "browser_runtime/azure_host"
_QUALIFICATION = _SOURCE.parent / "qualification.py"
_MODULES = (
    "__init__.py",
    "config.py",
    "credentials.py",
    "engine.py",
    "runner.py",
    "tls.py",
    "update.py",
)
_ASSETS = (
    "seccomp.json",
    "apparmor.profile",
    "hussh-owner-pod.service",
    "install.sh",
    "policy-provenance.json",
    "LICENSE.moby",
    "NOTICE.moby",
)


def installation_step(configuration: dict) -> tuple[ArmStep, str]:
    """Pure preparation; caller retains exact consent, worker and mutation authority.

    The caller must establish destination resource ownership and pin this bundle
    digest before dispatch. This is NOT a customer setup or host-migration API.
    """
    value = validate(configuration)
    files = {"azure_host/" + name: (_SOURCE / name).read_bytes() for name in _MODULES}
    files["browser_runtime/qualification.py"] = _QUALIFICATION.read_bytes()
    files.update({name: (_SOURCE / name).read_bytes() for name in _ASSETS})
    if (
        hashlib.sha256(files["seccomp.json"]).hexdigest() != SECCOMP_SHA256
        or hashlib.sha256(files["apparmor.profile"]).hexdigest() != APPARMOR_SHA256
    ):
        raise ValueError("VM host isolation policy changed")
    provenance = json.loads(files["policy-provenance.json"])
    if any(
        hashlib.sha256(files[name]).hexdigest() != digest
        for name, digest in provenance["files"].items()
    ):
        raise ValueError("VM host policy provenance changed")
    files["installation.json"] = (
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, body in sorted(files.items()):
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            entry.mode = 0o600 if name == "installation.json" else 0o644
            entry.uid = entry.gid = entry.mtime = 0
            archive.addfile(entry, io.BytesIO(body))
    packed = gzip.compress(output.getvalue(), mtime=0)
    if len(packed) > 49152:
        raise ValueError("VM host installer exceeds its transport bound")
    digest = hashlib.sha256(packed).hexdigest()
    # Only a bounded base64 archive enters shell text. No raw model/user string,
    # token, signing value, executable option or credential appears in the script.
    script = "\n".join(
        (
            "set -eu",
            "umask 077",
            "test ! -e /etc/systemd/system/hussh-owner-pod.service",
            "install -d -m 0755 /opt/hussh-host",
            "cd /opt/hussh-host",
            "base64 -d <<'HUSSH_HOST_BUNDLE' | tar --no-same-owner -xzf -",
            base64.b64encode(packed).decode(),
            "HUSSH_HOST_BUNDLE",
            "exec /bin/bash /opt/hussh-host/install.sh",
        )
    )
    return ArmStep(
        "deploying_agent",
        "action",
        "POST",
        value["installation"]["resource_id"] + "/runCommand",
        "virtual_machines",
        {"commandId": "RunShellScript", "script": [script]},
    ), digest


def replacement_step(
    configuration: dict,
    *,
    image: str,
    operation_id: str,
    idle_record: dict,
    browser_qualification: dict | None = None,
) -> tuple[ArmStep, str]:
    """Fixed image-only action; caller retains exact release/JIT/idle authority.

    Unlike installation_step this never reinstalls packages or rewrites a live
    host bundle. An unknown RunCommand outcome must be reconciled, never replayed.
    """
    from browser_runtime.azure_host.update import payload

    value = payload(
        configuration,
        image=image,
        operation_id=operation_id,
        idle_record=idle_record,
        browser_qualification=browser_qualification,
    )
    return _replacement_action(value)


def replacement_from_binding(
    *,
    installation: dict,
    previous_image: str,
    configuration_sha256: str,
    update_module_sha256: str,
    image: str,
    operation_id: str,
    idle_record: dict,
    browser_qualification: dict | None = None,
) -> tuple[ArmStep, str]:
    """Prepare the same fixed action without exporting the host configuration.

    Only installation metadata and commitments cross this boundary. The root
    host loads its private configuration and checks its hash before any effect.
    An unknown installed updater is incompatible; never substitute new code.
    """
    from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation

    identity = AzureVmInstallation.model_validate(installation)
    cursor = idle_record
    if (
        not re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io/pod@sha256:[a-f0-9]{64}", previous_image)
        or previous_image.split("@", 1)[1] != identity.image_digest
        or not re.fullmatch(r"[a-f0-9]{64}", configuration_sha256)
        or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", operation_id)
        or image.split("@", 1)[0] != previous_image.split("@", 1)[0]
        or not re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io/pod@sha256:[a-f0-9]{64}", image)
        or image == previous_image
        or not isinstance(cursor, dict)
        or set(cursor) != {"seq", "sha"}
        or type(cursor["seq"]) is not int
        or cursor["seq"] < 1
        or not isinstance(cursor["sha"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", cursor["sha"])
    ):
        raise ValueError("VM image replacement binding changed")
    expected_module = hashlib.sha256((_SOURCE / "update.py").read_bytes()).hexdigest()
    if update_module_sha256 != expected_module:
        raise ValueError("Installed VM updater is incompatible")
    from browser_runtime.qualification import qualification_environment

    # Validate before freezing the body, even though the root host checks again.
    qualification_environment(
        browser_qualification, image_digest=image.split("@", 1)[1], host_kind="azure_vm"
    )
    return _replacement_action(
        {
            "version": 2,
            "operation_id": operation_id,
            "previous_configuration_sha256": configuration_sha256,
            "installation": identity.model_dump(),
            "image": image,
            "idle_record": dict(cursor),
            "browser_qualification": deepcopy(browser_qualification),
        }
    )


def _replacement_action(value: dict) -> tuple[ArmStep, str]:
    from browser_runtime.azure_host.update import canonical

    raw = canonical(value)
    if len(raw) > 131072:
        raise ValueError("VM image update exceeds its transport bound")
    module_digest = hashlib.sha256((_SOURCE / "update.py").read_bytes()).hexdigest()
    qualification_digest = hashlib.sha256(_QUALIFICATION.read_bytes()).hexdigest()
    script = "\n".join(
        (
            "set -eu",
            "umask 077",
            "cd /opt/hussh-host",
            f'test "$(sha256sum azure_host/update.py | cut -d \' \' -f1)" = "{module_digest}"',
            f'test "$(sha256sum browser_runtime/qualification.py | cut -d \' \' -f1)" = "{qualification_digest}"',
            "/usr/bin/python3 -E -s -m azure_host.update <<'HUSSH_IMAGE_UPDATE'",
            base64.b64encode(raw).decode(),
            "HUSSH_IMAGE_UPDATE",
        )
    )
    return ArmStep(
        "deploying_agent",
        "action",
        "POST",
        value["installation"]["resource_id"] + "/runCommand",
        "virtual_machines",
        {"commandId": "RunShellScript", "script": [script]},
    ), hashlib.sha256(raw).hexdigest()
