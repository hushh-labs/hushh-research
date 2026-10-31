"""Fixed Docker Engine policy and verified container teardown; host-only."""

from __future__ import annotations

import hashlib
import http.client
import json
import re
import socket
import subprocess

from .config import (
    PROFILE,
    ROOT,
    RUNTIME,
    SECCOMP_SHA256,
    SECRETS,
    TLS,
    HostRefused,
    protected_read,
)

NAME = "hussh-owner-pod"


def command(*args: str, timeout: int = 30) -> bytes:
    try:
        return subprocess.check_output(  # noqa: S603 - internal fixed host commands only
            args, stderr=subprocess.DEVNULL, timeout=timeout
        )
    except Exception:
        raise HostRefused("HOST_RUNTIME_COMMAND_REFUSED") from None


def docker(*args: str) -> dict:
    result = json.loads(command("docker", *args))
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        raise HostRefused("HOST_RUNTIME_OBSERVATION_INVALID")
    return result[0]


def transform(host: dict, profile: str) -> tuple[dict, str]:
    """Replace only proc submounts with equivalent AppArmor denials.

    Preserve the exact qualified kernel workaround, rather than removing Docker's
    system-path policy globally. Neither privileged nor SYS_ADMIN is admitted.
    """
    if (
        host.get("Privileged")
        or host.get("PidMode") != ""
        or host.get("IpcMode") != "private"
        or host.get("NetworkMode") not in {"default", "bridge"}
        or host.get("Memory") != 2147483648
        or host.get("MemorySwap") != 2147483648
        or host.get("NanoCpus") != 1000000000
        or host.get("PidsLimit") != 192
        or {v.removeprefix("CAP_") for v in host.get("CapAdd", [])}
        != {"SETUID", "SETGID", "SETPCAP"}
        or host.get("CapDrop") != ["ALL"]
        or host.get("AutoRemove")
    ):
        raise HostRefused("HOST_RUNTIME_POLICY_CHANGED")
    removed = {}
    # Work on a detached copy: a refused configuration cannot weaken its caller.
    host = json.loads(json.dumps(host))
    for key in ("MaskedPaths", "ReadonlyPaths"):
        original = host.get(key)
        if not isinstance(original, list) or not all(isinstance(p, str) for p in original):
            raise HostRefused("HOST_RUNTIME_PATHS_UNAVAILABLE")
        removed[key] = [p for p in original if p == "/proc" or p.startswith("/proc/")]
        host[key] = [p for p in original if p not in removed[key]]
    # Docker's qualified default has only /proc readonly paths. Those paths
    # receive equivalent AppArmor denials below; no non-proc entry is dropped.
    if not all(removed.values()) or not host["MaskedPaths"]:
        raise HostRefused("HOST_RUNTIME_PATHS_UNAVAILABLE")
    rules = []
    for key, mode in (("MaskedPaths", "rwklmx"), ("ReadonlyPaths", "w")):
        for path in removed[key]:
            if not re.fullmatch(r"/proc(?:/[a-zA-Z0-9_-]+)*", path):
                raise HostRefused("HOST_RUNTIME_PATHS_UNAVAILABLE")
            rules.extend([f"  deny {path} {mode},", f"  deny {path}/** {mode},"])
    base = profile.rstrip()
    if not base.endswith("}") or "# proc path replacements" in base:
        raise HostRefused("HOST_APPARMOR_POLICY_CHANGED")
    return host, base[:-1] + "  # proc path replacements\n" + "\n".join(rules) + "\n}\n"


class Engine(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect("/var/run/docker.sock")


def observe_container() -> dict | None:
    client = Engine("localhost")
    try:
        client.request("GET", "/v1.47/containers/" + NAME + "/json")
        response = client.getresponse()
        payload = response.read(262145)
        if response.status == 404:
            return None
        if response.status != 200 or len(payload) > 262144:
            raise HostRefused("HOST_RUNTIME_OBSERVATION_INVALID")
        observed = json.loads(payload)
        if not isinstance(observed, dict):
            raise HostRefused("HOST_RUNTIME_OBSERVATION_INVALID")
        return observed
    finally:
        client.close()


def remove_stopped(config: dict) -> None:
    """Reboot recovery only; never kill another or unexpectedly live generation."""
    previous = observe_container()
    if previous is None:
        return
    if (
        previous["Config"].get("Labels", {}).get("husshGeneration")
        != config["installation"]["generation"]
        or previous["Config"].get("Image") != config["image"]
        or previous["State"]["Running"]
    ):
        raise HostRefused("HOST_PREVIOUS_GENERATION_REQUIRES_RECONCILIATION")
    command("docker", "rm", NAME)
    if observe_container() is not None:
        raise HostRefused("HOST_CONTAINER_REMOVAL_UNCONFIRMED")


def failure_summary(run_id: str) -> dict:
    """Owner-host diagnostics only; never forward arbitrary application text."""
    observed = observe_container()
    if observed is None or observed["Config"].get("Labels", {}).get("husshHostRun") != run_id:
        return {"container_observed": False}
    state = observed["State"]
    client = Engine("localhost")
    try:
        client.request("GET", "/v1.47/containers/" + NAME + "/logs?stderr=1&stdout=1&tail=40")
        response = client.getresponse()
        # Docker's multiplex framing is harmless to this class-name-only match.
        raw = response.read(65536).decode(errors="replace") if response.status == 200 else ""
        allowed = {
            "ModuleNotFoundError",
            "ImportError",
            "RuntimeError",
            "ValueError",
            "TypeError",
            "PermissionError",
            "OSError",
            "TimeoutError",
            "AzureVmIdentityRefused",
            "ByocKeyCustodyError",
            "PodKeyVaultCustodyError",
        }
        classes = sorted(name for name in allowed if re.search(r"\b" + name + r":", raw))
        return {
            "container_observed": True,
            "exit_code": int(state["ExitCode"]),
            "oom": bool(state["OOMKilled"]),
            "exception_classes": classes,
        }
    finally:
        client.close()


def _arguments(config: dict, run_id: str) -> list[str]:
    arguments = [
        "docker",
        "create",
        "--name",
        NAME,
        "--label",
        "husshGeneration=" + config["installation"]["generation"],
        "--label",
        "husshHostRun=" + run_id,
        "--cpus=1",
        "--memory=2g",
        "--memory-swap=2g",
        "--pids-limit=192",
        "--ipc=private",
        "--cap-drop=ALL",
        "--cap-add=SETUID",
        "--cap-add=SETGID",
        "--cap-add=SETPCAP",
        "--security-opt",
        "no-new-privileges=true",
        "--security-opt",
        "seccomp=" + str(ROOT / "seccomp.json"),
        "--security-opt",
        "apparmor=" + PROFILE,
        "--log-driver=local",
        "--log-opt",
        "max-size=5m",
        "--log-opt",
        "max-file=2",
        "--publish",
        "443:8080",
    ]
    for path in (RUNTIME, SECRETS, TLS):
        arguments.extend(
            ["--mount", "type=bind,src=" + str(path) + ",dst=" + str(path) + ",readonly"]
        )
    for name, value in sorted(config["environment"].items()):
        arguments.extend(["--env", name + "=" + value])
    return arguments


def require_image(installed: dict, image: dict) -> None:
    expected_entrypoint = ["/usr/local/bin/python", "-I", "-S", "/opt/browser/pod_entrypoint.py"]
    if (
        installed.get("Image") != image["Id"]
        or image["Config"].get("Entrypoint") != expected_entrypoint
        or installed["Config"].get("Entrypoint") != expected_entrypoint
        # Docker omits Cmd for an entrypoint-only image. Absence is not an
        # override; preserve it rather than requiring a nonexistent field.
        or installed["Config"].get("Cmd") != image["Config"].get("Cmd")
        or installed.get("AppArmorProfile") != PROFILE
    ):
        raise HostRefused("HOST_RUNTIME_IMAGE_CHANGED")


def create(config: dict, run_id: str) -> None:
    remove_stopped(config)
    command("apparmor_parser", "-r", str(ROOT / "apparmor.profile"))
    image = docker("image", "inspect", config["image"])
    if config["image"] not in image.get("RepoDigests", []):
        raise HostRefused("HOST_IMAGE_DIGEST_CHANGED")
    command(*_arguments(config, run_id), config["image"])
    observed = docker("inspect", NAME)
    host, profile = transform(
        observed["HostConfig"], protected_read(ROOT / "apparmor.profile", limit=16384).decode()
    )
    (RUNTIME / "apparmor.profile").write_text(profile)
    command("apparmor_parser", "-r", str(RUNTIME / "apparmor.profile"))
    # Remove the never-started preliminary container. Engine API preserves the
    # image's original entrypoint, command and every untouched security setting.
    command("docker", "rm", NAME)
    client = Engine("localhost")
    try:
        client.request(
            "POST",
            "/v1.47/containers/create?name=" + NAME,
            body=json.dumps({**observed["Config"], "HostConfig": host}),
            headers={"Content-Type": "application/json"},
        )
        response = client.getresponse()
        payload = response.read(65537)
        if response.status != 201 or len(payload) > 65536:
            raise HostRefused("HOST_RUNTIME_CREATE_REFUSED")
    finally:
        client.close()
    installed = docker("inspect", NAME)
    require_image(installed, image)
    receipt = {
        "version": 1,
        "generation": config["installation"]["generation"],
        "image": config["image"],
        "image_config_digest": image["Id"],
        "seccomp_sha256": SECCOMP_SHA256,
        "apparmor_sha256": hashlib.sha256(profile.encode()).hexdigest(),
        "container_id": installed["Id"],
    }
    (RUNTIME / "runtime.json").write_text(json.dumps(receipt) + "\n")


def clean(run_id: str) -> None:
    observed = observe_container()
    if observed is not None and observed["Config"].get("Labels", {}).get("husshHostRun") != run_id:
        raise HostRefused("HOST_CONTAINER_NOT_OWNED")
    subprocess.run(  # noqa: S603 - fixed executable and validated installation values
        ["docker", "stop", "--time=30", NAME],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=40,
        check=False,
    )
    subprocess.run(  # noqa: S603 - fixed executable and validated installation values
        ["docker", "rm", NAME],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if observe_container() is not None:
        raise HostRefused("HOST_CONTAINER_REMOVAL_UNCONFIRMED")
    (SECRETS / "app-signing-key").unlink(missing_ok=True)
