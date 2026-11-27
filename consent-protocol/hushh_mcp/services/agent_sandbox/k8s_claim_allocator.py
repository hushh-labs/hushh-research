# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Kubernetes SandboxClaim allocator and Sentinel control-plane HTTP client (#9744)."""

from __future__ import annotations

import http.client
import json
import secrets
import ssl
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from hushh_mcp.operons.agent_sandbox.k8s_manifests import render_sandbox_claim

DEFAULT_K8S_SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")


@dataclass(frozen=True)
class ClaimedSandboxEndpoint:
    claim_name: str
    namespace: str
    sandbox_name: str
    pod_ip: str
    port: int = 8080
    ready: bool = True


class SandboxClaimPort(Protocol):
    """Port abstracting Kubernetes `SandboxClaim` allocation and deletion."""

    def create_and_wait_claim(
        self,
        *,
        claim_name: str,
        billing_space_id: str,
        warm_pool_name: str = "hussh-one-warm-pool",
        idle_shutdown_seconds: int = 600,
        timeout_s: float = 30.0,
    ) -> ClaimedSandboxEndpoint: ...

    def delete_claim(self, claim_name: str) -> None: ...


class InMemorySandboxClaimClient:
    """Deterministic in-memory SandboxClaim allocator for contract and offline tests."""

    def __init__(self, *, forced_sandbox_sequence: list[str] | None = None) -> None:
        self._sequence = list(forced_sandbox_sequence or [])
        self.active_claims: dict[str, ClaimedSandboxEndpoint] = {}
        self.deleted_claims: list[str] = []
        self.terminated_sandboxes: dict[str, str] = {}

    def inspect_pod_termination(self, sandbox_name: str) -> str | None:
        return self.terminated_sandboxes.get(str(sandbox_name or "").strip())

    def create_and_wait_claim(
        self,
        *,
        claim_name: str,
        billing_space_id: str,
        warm_pool_name: str = "hussh-one-warm-pool",
        idle_shutdown_seconds: int = 600,
        timeout_s: float = 30.0,
    ) -> ClaimedSandboxEndpoint:
        render_sandbox_claim(
            claim_name=claim_name,
            billing_space_id=billing_space_id,
            warm_pool_name=warm_pool_name,
            idle_shutdown_seconds=idle_shutdown_seconds,
        )
        sandbox_name = (
            self._sequence.pop(0)
            if self._sequence
            else f"hussh-one-warm-pool-{secrets.token_hex(4)}"
        )
        endpoint = ClaimedSandboxEndpoint(
            claim_name=claim_name,
            namespace="hussh-agents",
            sandbox_name=sandbox_name,
            pod_ip=f"10.31.0.{(len(self.active_claims) % 200) + 10}",
            ready=True,
        )
        self.active_claims[claim_name] = endpoint
        return endpoint

    def delete_claim(self, claim_name: str) -> None:
        self.active_claims.pop(claim_name, None)
        self.deleted_claims.append(claim_name)


class LiveK8sSandboxClaimClient:
    """Direct Kubernetes `extensions.agents.x-k8s.io/v1beta1` SandboxClaim client."""

    def __init__(
        self,
        *,
        api_server: str,
        bearer_token: str | None = None,
        token_provider: Any | None = None,
        ca_cert_path: Path | None = None,
        ca_cert_pem: str | None = None,
        namespace: str = "hussh-agents",
        poll_interval_s: float = 0.15,
        on_demand_scale_pool: bool = True,
    ) -> None:
        self.api_server = api_server.rstrip("/")
        self._static_auth = str(bearer_token or "").strip()
        self._token_provider = token_provider
        self.namespace = namespace
        self.poll_interval_s = max(0.1, float(poll_interval_s))
        self.on_demand_scale_pool = bool(on_demand_scale_pool)
        self._ssl_ctx = ssl.create_default_context(
            cafile=str(ca_cert_path) if ca_cert_path is not None else None,
            cadata=ca_cert_pem,
        )

    @classmethod
    def from_incluster(
        cls,
        *,
        namespace: str = "hussh-agents",
        sa_dir: Path = DEFAULT_K8S_SA_DIR,
        on_demand_scale_pool: bool = True,
    ) -> LiveK8sSandboxClaimClient:
        jwt_file = sa_dir.joinpath("token")
        ca_path = sa_dir.joinpath("ca.crt")
        return cls(
            api_server="https://kubernetes.default.svc",
            token_provider=lambda: jwt_file.read_text(encoding="utf-8").strip(),
            ca_cert_path=ca_path,
            namespace=namespace,
            on_demand_scale_pool=on_demand_scale_pool,
        )

    @classmethod
    def from_gcp_credentials(
        cls,
        *,
        api_server: str,
        ca_cert_pem: str | None = None,
        ca_cert_path: Path | None = None,
        namespace: str = "hussh-agents",
        on_demand_scale_pool: bool = True,
    ) -> LiveK8sSandboxClaimClient:
        """Connect from Cloud Run to GKE master via auto-refreshing GCP ADC access tokens."""
        import google.auth  # noqa: PLC0415
        import google.auth.transport.requests  # noqa: PLC0415

        creds, _ = google.auth.default(
            scopes=[
                "https://www.googleapis.com/auth/cloud-platform",
                "https://www.googleapis.com/auth/userinfo.email",
            ]
        )
        req = google.auth.transport.requests.Request()

        def _refresh_bearer() -> str:
            if not getattr(creds, "valid", False) or not getattr(creds, "token", None):
                creds.refresh(req)
            return str(getattr(creds, "token", "") or "").strip()

        return cls(
            api_server=api_server,
            token_provider=_refresh_bearer,
            ca_cert_path=ca_cert_path,
            ca_cert_pem=ca_cert_pem.strip() + "\n" if ca_cert_pem else None,
            namespace=namespace,
            on_demand_scale_pool=on_demand_scale_pool,
        )

    def _current_bearer(self) -> str:
        if self._token_provider is not None:
            return str(self._token_provider() or "").strip()
        return self._static_auth

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        content_type: str = "application/json",
    ) -> tuple[int, dict[str, Any]]:
        parsed = urllib.parse.urlsplit(f"{self.api_server}{path}")
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError(f"Unsupported Kubernetes API server URL: {self.api_server}")
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {
            "Authorization": f"Bearer {self._current_bearer()}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = content_type
        conn = http.client.HTTPSConnection(
            parsed.hostname,
            parsed.port or 443,
            timeout=15.0,
            context=self._ssl_ctx,
        )
        try:
            target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
            conn.request(method, target, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8")
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                body = {"message": raw}
            return int(resp.status), body
        finally:
            conn.close()

    @staticmethod
    def _is_ready(claim_doc: dict[str, Any]) -> bool:
        for cond in (claim_doc.get("status") or {}).get("conditions") or []:
            if cond.get("type") == "Ready" and cond.get("status") == "True":
                return True
        return False

    def _extract_pod_ip(self, sandbox_name: str, claim_doc: dict[str, Any]) -> str:
        ips = ((claim_doc.get("status") or {}).get("sandbox") or {}).get("podIPs") or []
        if ips and str(ips[0]).strip():
            return str(ips[0]).strip()
        status, pod_doc = self._request_json(
            "GET", f"/api/v1/namespaces/{self.namespace}/pods/{sandbox_name}"
        )
        if status == 200:
            pod_ip = str((pod_doc.get("status") or {}).get("podIP") or "").strip()
            if pod_ip:
                return pod_ip
        return ""

    def _set_warm_pool_replicas(self, warm_pool_name: str, replicas: int) -> None:
        pool_path = (
            f"/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{self.namespace}"
            f"/sandboxwarmpools/{warm_pool_name}"
        )
        self._request_json(
            "PATCH",
            pool_path,
            {"spec": {"replicas": replicas}},
            content_type="application/merge-patch+json",
        )

    def create_and_wait_claim(
        self,
        *,
        claim_name: str,
        billing_space_id: str,
        warm_pool_name: str = "hussh-one-warm-pool",
        idle_shutdown_seconds: int = 600,
        timeout_s: float = 180.0,
    ) -> ClaimedSandboxEndpoint:
        manifest = render_sandbox_claim(
            claim_name=claim_name,
            namespace=self.namespace,
            warm_pool_name=warm_pool_name,
            billing_space_id=billing_space_id,
            idle_shutdown_seconds=idle_shutdown_seconds,
        )
        scaled_from_zero = False
        if self.on_demand_scale_pool:
            pool_path = (
                f"/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{self.namespace}"
                f"/sandboxwarmpools/{warm_pool_name}"
            )
            p_status, p_doc = self._request_json("GET", pool_path)
            if p_status == 200 and int((p_doc.get("spec") or {}).get("replicas") or 0) == 0:
                self._set_warm_pool_replicas(warm_pool_name, 1)
                scaled_from_zero = True

        base = f"/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{self.namespace}/sandboxclaims"
        try:
            status, created = self._request_json("POST", base, manifest)
            if status not in {200, 201, 202}:
                raise RuntimeError(f"SandboxClaim create failed ({status}): {created}")

            deadline = time.monotonic() + max(2.0, float(timeout_s))
            latest = created
            while time.monotonic() < deadline:
                sandbox_name = str(
                    ((latest.get("status") or {}).get("sandbox") or {}).get("name") or ""
                ).strip()
                if sandbox_name and scaled_from_zero:
                    # Reset pool target back to 0 as soon as the controller adopts a sandbox
                    # so no second idle standby instance is left running.
                    self._set_warm_pool_replicas(warm_pool_name, 0)
                    scaled_from_zero = False
                if sandbox_name and self._is_ready(latest):
                    pod_ip = self._extract_pod_ip(sandbox_name, latest)
                    if pod_ip:
                        return ClaimedSandboxEndpoint(
                            claim_name=claim_name,
                            namespace=self.namespace,
                            sandbox_name=sandbox_name,
                            pod_ip=pod_ip,
                            ready=True,
                        )
                time.sleep(self.poll_interval_s)
                get_status, latest = self._request_json("GET", f"{base}/{claim_name}")
                if get_status != 200:
                    latest = {}
            raise TimeoutError(
                f"SandboxClaim {claim_name} did not become Ready within {timeout_s}s"
            )
        finally:
            if scaled_from_zero:
                self._set_warm_pool_replicas(warm_pool_name, 0)

    def delete_claim(self, claim_name: str) -> None:
        base = f"/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{self.namespace}/sandboxclaims"
        status, body = self._request_json(
            "DELETE",
            f"{base}/{claim_name}",
            {"propagationPolicy": "Foreground"},
        )
        if status not in {200, 202, 404}:
            raise RuntimeError(f"SandboxClaim delete failed ({status}): {body}")

    def inspect_pod_termination(self, sandbox_name: str) -> str | None:
        """Return a value-free termination reason if the claimed pod exited or crashed."""
        clean_name = str(sandbox_name or "").strip()
        if not clean_name:
            return None
        try:
            status, pod_doc = self._request_json(
                "GET", f"/api/v1/namespaces/{self.namespace}/pods/{clean_name}"
            )
        except Exception:  # noqa: BLE001 - transient K8s API hiccup is not pod termination
            return None
        if status == 404:
            return "PodDeleted"
        if status != 200 or not isinstance(pod_doc, dict):
            return None
        pod_status = pod_doc.get("status")
        if not isinstance(pod_status, dict):
            return None
        phase = str(pod_status.get("phase") or "").strip()
        if phase in {"Failed", "Succeeded"}:
            return f"PodPhase:{phase}"
        fatal_waiting = {
            "CrashLoopBackOff",
            "ErrImagePull",
            "ImagePullBackOff",
            "CreateContainerConfigError",
            "InvalidImageName",
        }
        for cs in pod_status.get("containerStatuses") or ():
            if not isinstance(cs, dict):
                continue
            state = cs.get("state")
            if not isinstance(state, dict):
                continue
            term = state.get("terminated")
            if isinstance(term, dict):
                reason = str(term.get("reason") or "Exited").strip()[:48]
                exit_code = term.get("exitCode")
                return f"ContainerTerminated:{reason}:{exit_code}"
            waiting = state.get("waiting")
            if isinstance(waiting, dict):
                w_reason = str(waiting.get("reason") or "").strip()
                if w_reason in fatal_waiting:
                    return f"ContainerWaiting:{w_reason}"
        return None

    def extend_claim_shutdown(
        self,
        claim_name: str,
        *,
        idle_shutdown_seconds: int = 600,
    ) -> bool:
        """Slide `spec.lifecycle.shutdownTime` forward so active leases outlive initial TTL."""
        import datetime  # noqa: PLC0415

        clamped = max(60, min(3600, int(idle_shutdown_seconds)))
        shutdown_iso = datetime.datetime.fromtimestamp(
            int(time.time()) + clamped,
            tz=datetime.timezone.utc,
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        base = f"/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/{self.namespace}/sandboxclaims"
        try:
            status, _body = self._request_json(
                "PATCH",
                f"{base}/{claim_name}",
                {"spec": {"lifecycle": {"shutdownTime": shutdown_iso}}},
                content_type="application/merge-patch+json",
            )
            return status in {200, 201, 202}
        except Exception:  # noqa: BLE001 - caller rotates cleanly if claim PATCH is unsupported
            return False


class SentinelControlClient:
    """Typed Hub client talking to Sentinel proxy control endpoint (:8081)."""

    def __init__(self, *, base_url: str, control_token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = str(control_token or "").strip()

    def _call(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        parsed = urllib.parse.urlsplit(f"{self.base_url}{path}")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"Unsupported Sentinel control URL: {self.base_url}")
        headers = {
            "X-Sentinel-Control-Token": self._token,
            "Accept": "application/json",
        }
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn: http.client.HTTPConnection = (
            http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=10.0)
            if parsed.scheme == "https"
            else http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=10.0)
        )
        try:
            target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
            conn.request(method, target, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8")
            body = dict(json.loads(raw)) if raw else {}
            if resp.status >= 400:
                raise RuntimeError(f"Sentinel control HTTP {resp.status}: {body}")
            return body
        finally:
            conn.close()

    def issue_surrogate(
        self,
        *,
        owner_id: str,
        lease_id: str,
        allowed_origin: str,
        header_name: str,
        real_secret: str,
        ttl_seconds: int = 300,
    ) -> str:
        res = self._call(
            "POST",
            "/v1/surrogates/issue",
            {
                "owner_id": owner_id,
                "lease_id": lease_id,
                "allowed_origin": allowed_origin,
                "header_name": header_name,
                "real_secret": real_secret,
                "ttl_seconds": ttl_seconds,
            },
        )
        return str(res["surrogate_token"])

    def revoke_lease(self, lease_id: str) -> int:
        res = self._call("POST", "/v1/surrogates/revoke", {"lease_id": lease_id})
        return int(res.get("revoked", 0))

    def set_domain_rules(self, lease_id: str, domain_rules: dict[str, str]) -> bool:
        res = self._call(
            "POST",
            "/v1/policies/set",
            {"lease_id": lease_id, "domain_rules": domain_rules},
        )
        return bool(res.get("updated"))

    def set_lease_policy_with_ip(
        self,
        *,
        lease_id: str,
        owner_id: str,
        pod_ip: str,
        domain_rules: dict[str, str] | None = None,
    ) -> bool:
        encoded_lease = urllib.parse.quote(str(lease_id).strip(), safe="")
        res = self._call(
            "PUT",
            f"/v1/leases/{encoded_lease}/policy",
            {
                "owner_id": owner_id,
                "pod_ip": pod_ip,
                "domain_rules": dict(domain_rules or {}),
            },
        )
        return bool(res.get("updated"))

    def mint_model_surrogate(
        self,
        *,
        lease_id: str,
        owner_id: str,
        ttl_seconds: int = 3600,
    ) -> str:
        encoded_lease = urllib.parse.quote(str(lease_id).strip(), safe="")
        res = self._call(
            "POST",
            f"/v1/leases/{encoded_lease}/model-surrogate",
            {"owner_id": owner_id, "ttl_seconds": int(ttl_seconds)},
        )
        return str(res["surrogate_token"])

    def delete_lease(self, lease_id: str) -> bool:
        encoded_lease = urllib.parse.quote(str(lease_id).strip(), safe="")
        res = self._call("DELETE", f"/v1/leases/{encoded_lease}")
        return bool(res.get("deleted"))

    def verify_audit(self, lease_id: str | None = None) -> dict[str, Any]:
        suffix = f"?lease_id={urllib.parse.quote(lease_id)}" if lease_id else ""
        return self._call("GET", f"/v1/audit/verify{suffix}")
