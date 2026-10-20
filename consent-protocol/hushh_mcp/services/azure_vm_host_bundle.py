"""Deterministic, bounded installer payload over the existing ARM action contract."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

from browser_runtime.azure_host.config import APPARMOR_SHA256, SECCOMP_SHA256, validate
from hushh_mcp.services.azure_setup_plan import ArmStep

_SOURCE = Path(__file__).resolve().parents[2] / "browser_runtime/azure_host"
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
    configuration: dict, *, image: str, operation_id: str, idle_record: dict
) -> tuple[ArmStep, str]:
    """Fixed image-only action; caller retains exact release/JIT/idle authority.

    Unlike installation_step this never reinstalls packages or rewrites a live
    host bundle. An unknown RunCommand outcome must be reconciled, never replayed.
    """
    from browser_runtime.azure_host.update import canonical, payload

    value = payload(configuration, image=image, operation_id=operation_id, idle_record=idle_record)
    raw = canonical(value)
    if len(raw) > 131072:
        raise ValueError("VM image update exceeds its transport bound")
    module_digest = hashlib.sha256((_SOURCE / "update.py").read_bytes()).hexdigest()
    script = "\n".join(
        (
            "set -eu",
            "umask 077",
            "cd /opt/hussh-host",
            f'test "$(sha256sum azure_host/update.py | cut -d \' \' -f1)" = "{module_digest}"',
            "/usr/bin/python3 -E -s -m azure_host.update <<'HUSSH_IMAGE_UPDATE'",
            base64.b64encode(raw).decode(),
            "HUSSH_IMAGE_UPDATE",
        )
    )
    return ArmStep(
        "deploying_agent",
        "action",
        "POST",
        configuration["installation"]["resource_id"] + "/runCommand",
        "virtual_machines",
        {"commandId": "RunShellScript", "script": [script]},
    ), hashlib.sha256(raw).hexdigest()
