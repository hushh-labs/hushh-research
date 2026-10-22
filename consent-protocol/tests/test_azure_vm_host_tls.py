"""Real TLS handshakes across atomic renewal, without restarting the agent worker."""

from __future__ import annotations

import os
import ssl
from types import SimpleNamespace

from uvicorn import Config

from browser_runtime import gunicorn_lifecycle
from browser_runtime.azure_host import tls
from tests.test_azure_vm_host import _pair


def _handshake(context, client_context):
    server_in, server_out, client_in, client_out = (ssl.MemoryBIO() for _ in range(4))
    server = context.wrap_bio(server_in, server_out, server_side=True)
    client = client_context.wrap_bio(client_in, client_out, server_hostname="owner.example.com")
    finished = set()
    for _ in range(20):
        for key, peer in (("client", client), ("server", server)):
            try:
                peer.do_handshake()
                finished.add(key)
            except ssl.SSLWantReadError:
                pass
        for source, destination in ((server_out, client_in), (client_out, server_in)):
            if source.pending:
                destination.write(source.read())
        if len(finished) == 2:
            return client, server, client_out, server_in
    raise AssertionError("TLS handshake did not settle")


def test_pinned_uvicorn_worker_renews_tls_without_losing_existing_connection(monkeypatch, tmp_path):
    monkeypatch.setattr(tls, "TLS", tmp_path / "tls")
    monkeypatch.setattr(tls.os, "chown", lambda *_: None)
    first, second = _pair(11), _pair(12)
    tls._publish(*first)
    monkeypatch.setattr(gunicorn_lifecycle, "_TLS", str(tls.TLS))
    exists = os.path.exists
    monkeypatch.setattr(
        gunicorn_lifecycle.os.path,
        "exists",
        lambda p: True if p == "/run/hussh-host/pod.json" else exists(p),
    )

    async def application(_scope, _receive, _send):
        return

    worker = SimpleNamespace(
        wsgi=application,
        config=Config(
            application,
            ssl_certfile=str(tls.TLS / "current/fullchain.pem"),
            ssl_keyfile=str(tls.TLS / "current/privkey.pem"),
            log_config=None,
        ),
    )
    gunicorn_lifecycle.post_worker_init(worker)
    assert worker.config.loaded
    context = worker.config.ssl
    client_context = ssl.create_default_context(cadata=(first[0] + second[0]).decode())
    client, server, outbound, inbound = _handshake(context, client_context)
    assert ssl.DER_cert_to_PEM_cert(client.getpeercert(binary_form=True)).encode() == first[0]
    tls._publish(*second)
    next_client, _, _, _ = _handshake(context, client_context)
    assert ssl.DER_cert_to_PEM_cert(next_client.getpeercert(binary_form=True)).encode() == second[0]
    client.write(b"existing agent connection")
    inbound.write(outbound.read())
    assert server.read() == b"existing agent connection"
