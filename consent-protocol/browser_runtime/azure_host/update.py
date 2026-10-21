"""Fixed image replacement after the existing authenticated update handoff.

Only the admitted JIT worker may dispatch this command. The idle cursor binds its
retained handoff; validating its shape here is not a substitute for authentication.
Host acknowledgement never establishes encrypted recovery or installed completion.
An uncertain command is reconciled read-only, not automatically dispatched again.
"""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from copy import deepcopy

from browser_runtime.qualification import qualification_environment

from .config import ROOT, RUNTIME, HostRefused, load, protected_read, validate
from .credentials import pull, require_vm
from .engine import command, observe_container

UNIT = "hussh-owner-pod.service"


def canonical(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: dict) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def payload(
    previous: dict,
    *,
    image: str,
    operation_id: str,
    idle_record: dict,
    browser_qualification: dict | None = None,
) -> dict:
    previous = validate(deepcopy(previous))
    result = {
        "version": 2,
        "operation_id": operation_id,
        "previous_configuration_sha256": digest(previous),
        "installation": previous["installation"],
        "image": image,
        "idle_record": deepcopy(idle_record),
        "browser_qualification": deepcopy(browser_qualification),
    }
    target(previous, result)
    return result


def target(previous: dict, value: dict) -> dict:
    """An image-only delta cannot change custody, identity, ingress or resources."""
    if (
        set(value)
        != {
            "version",
            "operation_id",
            "previous_configuration_sha256",
            "installation",
            "image",
            "idle_record",
            "browser_qualification",
        }
        or type(value["version"]) is not int
        or value["version"] != 2
        or not isinstance(value["operation_id"], str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value["operation_id"])
        or value["previous_configuration_sha256"] != digest(previous)
        or value["installation"] != previous["installation"]
    ):
        raise HostRefused("HOST_UPDATE_BINDING_CHANGED")
    cursor = value["idle_record"]
    if (
        not isinstance(cursor, dict)
        or set(cursor) != {"seq", "sha"}
        or type(cursor["seq"]) is not int
        or cursor["seq"] < 1
        or not isinstance(cursor["sha"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", cursor["sha"])
    ):
        raise HostRefused("HOST_UPDATE_IDLE_RECEIPT_REQUIRED")
    image = value["image"]
    if (
        not isinstance(image, str)
        or image.split("@", 1)[0] != previous["image"].split("@", 1)[0]
        or image == previous["image"]
    ):
        raise HostRefused("HOST_UPDATE_IMAGE_REFUSED")
    result = deepcopy(previous)
    result["image"] = image
    result["installation"]["image_digest"] = image.split("@", 1)[-1]
    try:
        evidence = qualification_environment(
            value["browser_qualification"],
            image_digest=result["installation"]["image_digest"],
            host_kind="azure_vm",
        )
    except (ValueError, TypeError):
        raise HostRefused("HOST_BROWSER_QUALIFICATION_INVALID") from None
    # Keep every owner setting byte-for-byte, including enablement and policy.
    # Old-image evidence cannot survive replacement; absence refuses Browser
    # readiness without inventing a configuration approval.
    result["environment"].pop("HUSSH_BROWSER_QUALIFICATION_JSON", None)
    result["environment"].update(evidence)
    return validate(result)


def _write(name: str, value: dict) -> None:
    temporary = ROOT / ("." + name + "." + secrets.token_hex(8))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(canonical(value))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, ROOT / name)
        directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _running(configuration: dict) -> None:
    observed = observe_container()
    if (
        observed is None
        or observed.get("State", {}).get("Running") is not True
        or observed.get("Config", {}).get("Image") != configuration["image"]
        or observed.get("Config", {}).get("Labels", {}).get("husshGeneration")
        != configuration["installation"]["generation"]
    ):
        raise HostRefused("HOST_UPDATE_RUNTIME_CHANGED")


def _receipt(value: dict, configuration: dict, stage: str) -> dict:
    return {
        "version": 1,
        "operation_id": value["operation_id"],
        "request_sha256": digest(value),
        "configuration_sha256": digest(configuration),
        "image": configuration["image"],
        "stage": stage,
        "application_verified": False,
    }


def _execute(value: dict) -> dict:
    current = load()
    receipt_path = ROOT / "image-update.json"
    if receipt_path.exists():
        receipt = json.loads(protected_read(receipt_path, limit=4096, private=True))
        if not isinstance(receipt, dict):
            raise HostRefused("HOST_UPDATE_RECONCILIATION_REQUIRED")
        # A fresh approved operation names the currently verified configuration.
        # The hosted update ledger, not this root metadata, owns approval and
        # post-start completion. Uncertain host stages cannot be superseded.
        if receipt.get("stage") == "restart_requested" and receipt.get(
            "configuration_sha256"
        ) == digest(current):
            _running(current)
            if receipt.get("request_sha256") == digest(value):
                return receipt  # caller still verifies encrypted recovery and digest
            if receipt.get("operation_id") == value.get("operation_id"):
                raise HostRefused("HOST_UPDATE_BINDING_CHANGED")
            _write("previous-image-update.json", receipt)
        else:
            raise HostRefused("HOST_UPDATE_RECONCILIATION_REQUIRED")
    replacement = target(current, value)
    require_vm(current)
    _running(current)
    pull(replacement)  # cache immutable bytes while the old, drained service remains intact
    if load() != current:
        raise HostRefused("HOST_UPDATE_BINDING_CHANGED")
    _running(current)
    _write("previous-installation.json", current)
    _write("image-update.json", _receipt(value, replacement, "stopping"))
    command("systemctl", "stop", UNIT, timeout=90)
    state = command("systemctl", "show", UNIT, "--property=ActiveState", "--value").strip()
    if state != b"inactive" or observe_container() is not None:
        raise HostRefused("HOST_UPDATE_STOP_UNCONFIRMED")
    _write("image-update.json", _receipt(value, replacement, "promoting"))
    _write("installation.json", replacement)
    # No package installation, policy override, new unit, arbitrary command or
    # automatic rollback. Failure retains the actual stage and prior configuration.
    command("systemctl", "start", UNIT, timeout=90)
    receipt = _receipt(value, replacement, "restart_requested")
    _write("image-update.json", receipt)
    return receipt


def execute(value: dict) -> dict:
    if os.geteuid() != 0:
        raise HostRefused("HOST_ROOT_REQUIRED")
    directory = RUNTIME.lstat()
    if directory.st_uid != 0 or directory.st_mode & 0o022 or not stat.S_ISDIR(directory.st_mode):
        raise HostRefused("HOST_FILE_UNPROTECTED")
    fd = os.open(RUNTIME / "image-update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "rb") as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise HostRefused("HOST_FILE_UNPROTECTED")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HostRefused("HOST_UPDATE_ACTIVE") from None
        return _execute(value)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(262145)
        if len(raw) > 262144:
            raise HostRefused("HOST_UPDATE_TOO_LARGE")
        value = json.loads(base64.b64decode(raw.removesuffix(b"\n"), validate=True))
        print(json.dumps(execute(value)))
    except Exception as exc:
        print(
            str(exc) if isinstance(exc, HostRefused) else "HOST_UPDATE_UNCONFIRMED", file=sys.stderr
        )
        raise SystemExit(1) from None
