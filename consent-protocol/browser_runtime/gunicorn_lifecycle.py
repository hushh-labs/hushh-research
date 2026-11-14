"""One worker owns one bootstrap generation; never reuse its browser channel."""

import ctypes
import os
import re
import resource
import ssl
import sys

_TLS = "/run/hussh-tls"
# Docker.pod owns this 0700 directory for UID10001; HOME remains root's at exec.
control_socket = "/app/.gunicorn/gunicorn.ctl"
# Only the root-owned VM host mount selects direct TLS. Managed ingress on the
# existing service substrates continues to terminate TLS outside the worker.
if os.path.exists("/run/hussh-host/pod.json"):
    certfile = _TLS + "/current/fullchain.pem"
    keyfile = _TLS + "/current/privkey.pem"
    ssl_version = ssl.PROTOCOL_TLS_SERVER


def harden_worker_process() -> None:
    """Re-establish non-dumpable and zero-core posture after Linux execve()."""
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if sys.platform != "linux":
        return
    native = ctypes.CDLL(None, use_errno=True)
    if native.prctl(38, 1, 0, 0, 0) or native.prctl(4, 0, 0, 0, 0):
        raise RuntimeError("POD_WORKER_HARDENING_REFUSED")
    with open("/proc/self/status", encoding="utf-8") as handle:
        status = dict(line.split(":", 1) for line in handle if ":" in line)
    if int(status.get("Dumpable", "1").strip()) != 0:
        raise RuntimeError("POD_WORKER_HARDENING_REFUSED")


def post_worker_init(worker) -> None:
    """Renew leaf certificates without restarting active chat/browser sockets.

    The pinned Uvicorn worker loads its SSL context once. A successful host
    renewal publishes an immutable pair through one atomic directory pointer;
    only subsequent TLS handshakes see it. No agent or model supplies a path.
    """
    if os.environ.get("HUSSH_POD_MODE", "").lower() in {"1", "true"} or os.path.exists(
        "/opt/browser/pod_entrypoint.py"
    ):
        harden_worker_process()
    if not os.path.exists("/run/hussh-host/pod.json"):
        return
    worker.config.app = worker.wsgi
    worker.config.load()
    context = worker.config.ssl
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    revision = os.readlink(_TLS + "/current")
    current = context

    def current_certificate(_socket, _name, _context):
        nonlocal revision, current
        observed = os.readlink(_TLS + "/current")
        if not re.fullmatch(r"[a-f0-9]{64}", observed):
            raise ssl.SSLError("HOST_TLS_REVISION_INVALID")
        if observed != revision:
            # SSL objects copy their context's certificate before the SNI callback.
            # Loading the old context here is one connection too late. Switch the
            # current handshake to a new context; existing connections retain theirs.
            candidate = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            candidate.minimum_version = ssl.TLSVersion.TLSv1_2
            candidate.load_cert_chain(
                _TLS + "/" + observed + "/fullchain.pem", _TLS + "/" + observed + "/privkey.pem"
            )
            candidate.sni_callback = current_certificate
            current, revision = candidate, observed
        _socket.context = current

    context.sni_callback = current_certificate


def child_exit(server, _worker) -> None:
    if os.environ.get("POD_COMPUTER_USE_ENABLED", "").lower() not in {"1", "true"}:
        return
    # Worker death closes its private supervisor channel. Restart the container
    # generation instead of attaching a replacement worker to old task state.
    if server.alive:
        server.halt(reason="Private browser worker generation ended", exit_status=1)
