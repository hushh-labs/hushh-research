# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit tests for Sentinel L7 Vertex Model Gateway (:8082), IP-bound CONNECT, and sentinel_vertex."""

from __future__ import annotations

import http.client
import json
import socket
import threading
from collections.abc import Iterable, Mapping

import pytest
from google.adk.models import Gemini

from hushh_mcp.one_adk.text_runtime import _runtime_model
from hushh_mcp.operons.pod_workspace.command_policy import build_scrubbed_worker_env
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.runtime_providers.sentinel_gemini import (
    build_sentinel_gemini_adk_model,
    build_sentinel_genai_client,
)
from hushh_mcp.services.agent_sandbox.k8s_claim_allocator import SentinelControlClient
from hushh_mcp.services.agent_sandbox.sentinel_egress_proxy import (
    SURROGATE_EXFILTRATION_BLOCKED,
    SentinelEgressError,
)
from hushh_mcp.services.agent_sandbox.sentinel_proxy_server import (
    MODEL_GATEWAY_PATH_FORBIDDEN,
    MODEL_SURROGATE_IP_MISMATCH,
    SentinelProxyRuntime,
)


def _start_connect_sink() -> tuple[socket.socket, int, threading.Event]:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    port = int(srv.getsockname()[1])
    accepted = threading.Event()

    def _serve() -> None:
        try:
            conn, _ = srv.accept()
            accepted.set()
            conn.close()
        except OSError:
            pass

    threading.Thread(target=_serve, daemon=True).start()
    return srv, port, accepted


def test_sentinel_model_gateway_auth_path_streaming_and_audit(monkeypatch) -> None:
    now = {"ts": 1_700_000_000}
    captured_upstream: list[tuple[str, str, dict[str, str], bytes]] = []

    def fake_model_upstream(
        url: str, method: str, headers: Mapping[str, str], body: bytes
    ) -> tuple[int, dict[str, str], Iterable[bytes]]:
        captured_upstream.append((url, method, dict(headers), body))
        if ":streamGenerateContent" in url:
            sse_chunks = [
                b'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello "}]}}]}\n\n',
                b'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"world!"}]}}]}\n\n',
            ]
            return 200, {"Content-Type": "text/event-stream"}, sse_chunks
        payload = {
            "candidates": [
                {"content": {"role": "model", "parts": [{"text": "Sentinel gateway OK"}]}}
            ],
            "modelVersion": "gemini-4-hydrogen",
        }
        return 200, {"Content-Type": "application/json"}, [json.dumps(payload).encode("utf-8")]

    ctrl_token = "ctrl-sentinel-unit-check-01234567"
    runtime = SentinelProxyRuntime(
        hmac_key=b"M" * 32,
        control_token=ctrl_token,
        proxy_port=0,
        control_port=0,
        model_gateway_port=0,
        system_allow_hosts=["hub.dev.hussh.ai"],
        vertex_token_provider=lambda: "ya29.real_gcp_oauth_secret_do_not_expose",
        model_upstream_transport=fake_model_upstream,
        dns_resolver=lambda host, _port: (
            ["93.184.216.34"] if host == "hub.dev.hussh.ai" else ["93.184.216.35"]
        ),
        clock_s=lambda: now["ts"],
    )
    runtime.start_background()
    try:
        ctrl = SentinelControlClient(
            base_url=f"http://127.0.0.1:{runtime.control_port}",
            control_token=ctrl_token,
        )
        assert ctrl.set_lease_policy_with_ip(
            lease_id="lease_1", owner_id="hushh_owner_1", pod_ip="127.0.0.1"
        )
        surrogate = ctrl.mint_model_surrogate(
            lease_id="lease_1", owner_id="hushh_owner_1", ttl_seconds=3600
        )
        assert surrogate.startswith("hsur_")

        gw_url = f"http://127.0.0.1:{runtime.model_gateway_port}"
        monkeypatch.setenv("HUSSH_POD_MODE", "1")
        monkeypatch.setenv("HUSSH_MODEL_GATEWAY_URL", gw_url)
        monkeypatch.setenv("HUSSH_MODEL_GATEWAY_TOKEN", surrogate)
        monkeypatch.setenv("HUSSH_SENTINEL_VERTEX_PROJECT", "hushh-pda-dev")
        monkeypatch.setenv("HUSSH_SENTINEL_VERTEX_LOCATION", "global")
        # Must bypass broken HTTP(S)_PROXY via trust_env=False
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")

        from api.routes.one.pod_turn import PodTurnRequest, _resolve_runtime_mode

        assert _resolve_runtime_mode(PodTurnRequest(message="hi"), "gemini") == "sentinel_vertex"
        assert (
            _resolve_runtime_mode(
                PodTurnRequest(message="hi", runtime_credential="AIza_owner_key"), "gemini"
            )
            == "byok"
        )

        client = build_sentinel_genai_client()
        resp = client.models.generate_content(
            model="gemini-4-hydrogen", contents="SECRET_PROMPT_NEVER_AUDIT"
        )
        assert resp.text == "Sentinel gateway OK"
        assert len(captured_upstream) == 1
        assert (
            captured_upstream[0][0]
            == "https://aiplatform.googleapis.com/v1beta1/projects/hushh-pda-dev/locations/global/publishers/google/models/gemini-4-hydrogen:generateContent"
        )
        assert (
            captured_upstream[0][2]["Authorization"]
            == "Bearer ya29.real_gcp_oauth_secret_do_not_expose"
        )

        # Streaming chunked SSE pass-through via ADK Gemini object
        adk_model = build_sentinel_gemini_adk_model("gemini-4-hydrogen")
        assert isinstance(adk_model, Gemini)
        streamed = "".join(
            chunk.text or ""
            for chunk in client.models.generate_content_stream(
                model="gemini-3.8-flash", contents="stream hi"
            )
        )
        assert streamed == "Hello world!"

        # ProviderAdkModel and text_runtime resolve sentinel_vertex cleanly
        runtime_model = _runtime_model(
            runtime_model="gemini-4-hydrogen",
            runtime_mode="sentinel_vertex",
            runtime_credential=None,
        )
        assert isinstance(runtime_model, Gemini)
        p_client = ProviderAdkModel(
            provider="gemini",
            model="gemini-4-hydrogen",
            credential="",
            runtime_mode="sentinel_vertex",
        )._client()
        assert p_client is not None

        # Non-inference Vertex admin/IAM URLs are rejected 403
        conn = http.client.HTTPConnection("127.0.0.1", runtime.model_gateway_port, timeout=5)
        try:
            conn.request(
                "POST",
                "/v1/projects/hushh-pda-dev/locations/global/tuningJobs",
                body=b"{}",
                headers={"Authorization": f"Bearer {surrogate}"},
            )
            bad_path = conn.getresponse()
            bad_body = json.loads(bad_path.read().decode("utf-8"))
        finally:
            conn.close()
        assert bad_path.status == 403
        assert bad_body["code"] == MODEL_GATEWAY_PATH_FORBIDDEN

        # Attempting to exfiltrate model surrogate via web forwarder revokes it permanently
        with pytest.raises(SentinelEgressError) as exfil:
            runtime.handle_forward(
                owner_id="hushh_owner_1",
                lease_id="lease_1",
                url="https://hub.dev.hussh.ai/leak",
                headers={"Authorization": surrogate},
            )
        assert exfil.value.code == SURROGATE_EXFILTRATION_BLOCKED

        conn2 = http.client.HTTPConnection("127.0.0.1", runtime.model_gateway_port, timeout=5)
        try:
            conn2.request(
                "POST",
                "/v1beta1/projects/hushh-pda-dev/locations/global/publishers/google/models/gemini-4-hydrogen:generateContent",
                body=b"{}",
                headers={"Authorization": f"Bearer {surrogate}"},
            )
            revoked_resp = conn2.getresponse()
        finally:
            conn2.close()
        assert revoked_resp.status == 401

        # Audit sink logs gateway metadata without ever recording prompt or GCP secret
        entries = runtime.audit_sink.entries_for_lease("lease_1")
        serialized = json.dumps(entries)
        assert "SECRET_PROMPT_NEVER_AUDIT" not in serialized
        assert "ya29.real_gcp_oauth_secret_do_not_expose" not in serialized
        assert any(row["event_type"] == "MODEL_GATEWAY_INVOKE" for row in entries)

        # IP binding mismatch between client IP and lease IP revokes surrogate
        surrogate_ip = ctrl.mint_model_surrogate(lease_id="lease_1", owner_id="hushh_owner_1")
        assert ctrl.set_lease_policy_with_ip(
            lease_id="lease_other", owner_id="other_owner", pod_ip="127.0.0.1"
        )
        with pytest.raises(SentinelEgressError) as ip_err:
            runtime.authorize_model_surrogate(surrogate_ip, client_ip="127.0.0.1")
        assert ip_err.value.code == MODEL_SURROGATE_IP_MISMATCH
    finally:
        runtime.stop()


def test_sentinel_connect_ip_attribution_system_allow_and_terminal_scrub(tmp_path) -> None:
    sink_sock, sink_port, _accepted = _start_connect_sink()

    def dns_map(_host: str, _port: int) -> list[str]:
        return ["93.184.216.34"]

    ctrl_token = "ctrl-sentinel-unit-check-01234567"
    runtime = SentinelProxyRuntime(
        hmac_key=b"C" * 32,
        control_token=ctrl_token,
        proxy_port=0,
        control_port=0,
        model_gateway_port=0,
        system_allow_hosts=["hub.dev.hussh.ai"],
        upstream_transport=lambda u, m, h, b: (200, {}, b"hub_ok"),
        dns_resolver=dns_map,
    )
    runtime.start_background()
    try:
        ctrl = SentinelControlClient(
            base_url=f"http://127.0.0.1:{runtime.control_port}",
            control_token=ctrl_token,
        )
        assert ctrl.set_lease_policy_with_ip(
            lease_id="lease_ip", owner_id="hushh_ip_owner", pod_ip="127.0.0.1"
        )
        # System allow host (Hub) is admitted even with empty lease domain rules
        status, fwd_resp = runtime.handle_forward(
            owner_id="hushh_ip_owner",
            lease_id="lease_ip",
            url="https://hub.dev.hussh.ai/api/one/pod/storage-gateway/obj",
        )
        assert status == 200
        assert fwd_resp["body"] == "hub_ok"
        # Disallowed external host without X-Hussh-* headers still attributes to lease_ip via source IP and denies
        conn = http.client.HTTPConnection("127.0.0.1", runtime.proxy_port, timeout=5)
        try:
            conn.request("CONNECT", f"evil.example.org:{sink_port}")
            denied = conn.getresponse()
        finally:
            conn.close()
        assert denied.status == 403
        entries = runtime.audit_sink.entries_for_lease("lease_ip")
        assert any(
            e["event_type"] == "CONNECT_DENY" and e["owner_id"] == "hushh_ip_owner" for e in entries
        )
        # Releasing lease clears policy and IP mapping
        assert ctrl.delete_lease("lease_ip") is True
        assert runtime.lease_for_ip("127.0.0.1") is None

        # Terminal command policy strips Sentinel gateway and storage tokens
        scrubbed = build_scrubbed_worker_env(
            workspace_dir=tmp_path,
            scratch_tmp_dir=tmp_path,
            extra_public_env={
                "HUSSH_MODEL_GATEWAY_TOKEN": "hsur_secret_123",
                "HUSSH_MODEL_GATEWAY_URL": "http://sentinel:8082",
                "POD_STORAGE_PREFIX_TOKEN_URL": "https://hub.example.com?token=hpst1.secret",
                "SAFE_PUBLIC_FLAG": "yes",
            },
        )
        assert "HUSSH_MODEL_GATEWAY_TOKEN" not in scrubbed
        assert "HUSSH_MODEL_GATEWAY_URL" not in scrubbed
        assert "POD_STORAGE_PREFIX_TOKEN_URL" not in scrubbed
        assert scrubbed["SAFE_PUBLIC_FLAG"] == "yes"
        assert scrubbed["HOME"] == str(tmp_path)
    finally:
        sink_sock.close()
        runtime.stop()
