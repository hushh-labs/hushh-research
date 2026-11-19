# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""FedRAMP High positive and negative controls for Agent Sandbox (#9744)."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest
import yaml

from hushh_mcp.operons.agent_sandbox.egress_policy import (
    EGRESS_BLOCKED_DIRECT_PROTOCOL,
    EGRESS_BLOCKED_DOMAIN,
    EGRESS_BLOCKED_SCHEME,
    EGRESS_BLOCKED_TUNNEL,
    EGRESS_SSRF_BLOCKED,
    evaluate_sandbox_egress,
)
from hushh_mcp.operons.agent_sandbox.k8s_manifests import (
    K8S_MANIFEST_INVARIANT_ERROR,
    render_agent_sandbox_bundle,
    render_sandbox_template,
)
from hushh_mcp.operons.agent_sandbox.tamper_evident_audit import (
    AUDIT_CHAIN_CORRUPTED,
    AuditChainError,
    TamperEvidentAuditLedger,
)
from hushh_mcp.services.ace_backend import AceComputeBackend
from hushh_mcp.services.agent_sandbox.lease_manager import (
    SANDBOX_INVITE_REQUIRED,
    SANDBOX_WEEKLY_QUOTA_EXCEEDED,
    SC4_SINGLE_USE_VIOLATION,
    SandboxAdmissionError,
    SandboxObjectReuseViolation,
    VirginSandboxLeaseManager,
    WeeklySandboxQuotaLedger,
)
from hushh_mcp.services.agent_sandbox.sentinel_egress_proxy import (
    AUDIT_UNAVAILABLE,
    SURROGATE_EXFILTRATION_BLOCKED,
    SentinelEgressError,
    SentinelEgressGatekeeper,
)
from hushh_mcp.services.agent_sandbox.virgin_standby import build_readiness_payload
from hushh_mcp.services.compute_backend import PodSpec

_IMAGE_WITH_DIGEST = "us-docker.pkg.dev/hushh-pda-dev/hussh-sandbox/one-sandbox@sha256:" + "a" * 64


def _audit_ledger(clock_ms=lambda: 1_700_000_000_000) -> TamperEvidentAuditLedger:
    return TamperEvidentAuditLedger(b"K" * 32, clock_ms=clock_ms)


def test_quota_invite_gate_weekly_rollover_and_byoc_puppy_exemption() -> None:
    now = {"epoch": 1_700_000_000}
    ledger = WeeklySandboxQuotaLedger(
        weekly_limit_units=2,
        clock_s=lambda: now["epoch"],
        require_invite=True,
    )

    with pytest.raises(SandboxAdmissionError) as uninvited:
        ledger.check_and_consume("owner_uninvited", target="ace")
    assert uninvited.value.code == SANDBOX_INVITE_REQUIRED
    assert uninvited.value.status == 403

    for exempt_target in ("puppy", "user_gcp", "user_azure", "user_aws"):
        snap = ledger.check_and_consume("owner_uninvited", target=exempt_target, units=10)
        assert snap.exempt_target is True
        assert snap.used_units == 0

    ledger.grant_invite("owner_invited")
    first = ledger.check_and_consume("owner_invited", target="ace", units=1)
    assert first.used_units == 1
    second = ledger.check_and_consume("owner_invited", target="ace", units=1)
    assert second.used_units == 2

    with pytest.raises(SandboxAdmissionError) as exhausted:
        ledger.check_and_consume("owner_invited", target="ace", units=1)
    assert exhausted.value.code == SANDBOX_WEEKLY_QUOTA_EXCEEDED
    assert exhausted.value.status == 429

    now["epoch"] += 7 * 24 * 60 * 60
    reset_snap = ledger.check_and_consume("owner_invited", target="ace", units=1)
    assert reset_snap.used_units == 1


def test_sc4_single_use_destroy_zeroizes_key_and_forbids_instance_reuse() -> None:
    audit = _audit_ledger()
    quota = WeeklySandboxQuotaLedger(weekly_limit_units=10, require_invite=False)
    manager = VirginSandboxLeaseManager(
        quota_ledger=quota,
        audit_ledger=audit,
        clock_s=lambda: 1_700_000_100,
    )
    manager.register_virgin_instance("sbx-virgin-001")
    manager.register_virgin_instance("sbx-virgin-002")
    assert manager.warm_pool_size() == 2

    lease, _ = manager.claim_lease(
        owner_id="owner_alice",
        workspace_id="ws_alpha01",
        billing_space_id="bs_alice",
    )
    assert manager.warm_pool_size() == 1
    assert any(b != 0 for b in lease.nvme_ephemeral_key)

    receipt = manager.release_and_destroy(lease.lease_id, owner_id="owner_alice")
    assert receipt.key_zeroized is True
    assert receipt.sandbox_terminated is True
    assert all(b == 0 for b in lease.nvme_ephemeral_key)
    assert manager.warm_pool_size() == 1

    with pytest.raises(SandboxObjectReuseViolation) as reuse_err:
        manager.register_virgin_instance("sbx-virgin-001")
    assert reuse_err.value.code == SC4_SINGLE_USE_VIOLATION
    audit.verify_chain()


def test_sc7_egress_ssrf_metadata_tunnel_and_raw_protocol_blocks() -> None:
    v_http = evaluate_sandbox_egress("http://api.github.com/user", resolved_ips=["140.82.116.6"])
    assert v_http.decision == "deny"
    assert v_http.code == EGRESS_BLOCKED_SCHEME

    for metadata_url in (
        "https://169.254.169.254/computeMetadata/v1/",
        "https://metadata.google.internal/computeMetadata/v1/",
    ):
        verdict = evaluate_sandbox_egress(metadata_url, resolved_ips=["169.254.169.254"])
        assert verdict.decision == "deny"
        assert verdict.code == EGRESS_SSRF_BLOCKED

    for internal_ip in ("10.0.0.5", "100.64.0.1", "127.0.0.1"):
        rebind = evaluate_sandbox_egress(
            "https://rebind.attacker.example/secret",
            resolved_ips=[internal_ip],
            domain_rules={"rebind.attacker.example": "allow"},
        )
        assert rebind.decision == "deny"
        assert rebind.code == EGRESS_SSRF_BLOCKED

    for tunnel_url in ("https://demo.trycloudflare.com", "https://foo.ngrok-free.app"):
        tunnel = evaluate_sandbox_egress(tunnel_url, resolved_ips=["104.16.123.96"])
        assert tunnel.decision == "deny"
        assert tunnel.code == EGRESS_BLOCKED_TUNNEL

    db_blocked = evaluate_sandbox_egress(
        "https://db.example.com:5432/query",
        resolved_ips=["93.184.216.34"],
        domain_rules={"db.example.com": "allow"},
    )
    assert db_blocked.decision == "deny"
    assert db_blocked.code == EGRESS_BLOCKED_DIRECT_PROTOCOL

    db_allowed = evaluate_sandbox_egress(
        "https://db.example.com:5432/query",
        resolved_ips=["93.184.216.34"],
        domain_rules={"db.example.com": "allow"},
        protocol_toggles={"database": True},
    )
    assert db_allowed.decision == "allow"

    default_denied = evaluate_sandbox_egress(
        "https://unknown.example.org/data",
        resolved_ips=["93.184.216.34"],
        default_mode="deny",
    )
    assert default_denied.decision == "deny"
    assert default_denied.code == EGRESS_BLOCKED_DOMAIN


def test_sentinel_surrogate_edge_swap_and_exfiltration_revocation() -> None:
    audit = _audit_ledger()
    proxy = SentinelEgressGatekeeper(audit, clock_s=lambda: 1_700_000_000)
    header_material_one = " ".join(["Bearer", "unit_test_credential_one"])
    surrogate = proxy.issue_surrogate(
        owner_id="owner_alice",
        lease_id="lease_1",
        allowed_origin="https://api.github.com",
        header_name="Authorization",
        real_secret=header_material_one,
    )

    prepared = proxy.authorize_and_prepare_egress(
        owner_id="owner_alice",
        lease_id="lease_1",
        url="https://api.github.com/user",
        resolved_ips=["140.82.116.6"],
        headers={"Authorization": surrogate},
        domain_rules={"api.github.com": "allow"},
    )
    assert prepared.verdict.decision == "allow"
    assert prepared.outbound_headers["Authorization"] == header_material_one
    assert prepared.substituted_header_names == ("Authorization",)

    with pytest.raises(SentinelEgressError) as wrong_origin:
        proxy.authorize_and_prepare_egress(
            owner_id="owner_alice",
            lease_id="lease_1",
            url="https://evil.example.com/steal",
            resolved_ips=["93.184.216.34"],
            headers={"X-Leak": surrogate},
            domain_rules={"evil.example.com": "allow"},
        )
    assert wrong_origin.value.code == SURROGATE_EXFILTRATION_BLOCKED

    # Revocation must permanently invalidate the surrogate even on the original origin.
    with pytest.raises(SentinelEgressError) as post_revoke:
        proxy.authorize_and_prepare_egress(
            owner_id="owner_alice",
            lease_id="lease_1",
            url="https://api.github.com/user",
            resolved_ips=["140.82.116.6"],
            headers={"Authorization": surrogate},
            domain_rules={"api.github.com": "allow"},
        )
    assert post_revoke.value.code == SURROGATE_EXFILTRATION_BLOCKED

    # Sending surrogate inside body text even to allowed origin triggers block + revoke.
    header_material_two = " ".join(["Bearer", "unit_test_credential_two"])
    surrogate_two = proxy.issue_surrogate(
        owner_id="owner_alice",
        lease_id="lease_1",
        allowed_origin="https://api.github.com",
        header_name="Authorization",
        real_secret=header_material_two,
    )
    with pytest.raises(SentinelEgressError) as body_leak:
        proxy.authorize_and_prepare_egress(
            owner_id="owner_alice",
            lease_id="lease_1",
            url="https://api.github.com/gists",
            resolved_ips=["140.82.116.6"],
            method="POST",
            body_text=f"leaked={surrogate_two}",
            domain_rules={"api.github.com": "allow"},
        )
    assert body_leak.value.code == SURROGATE_EXFILTRATION_BLOCKED
    audit.verify_chain()


def test_au9_audit_tamper_detection_and_au5_fail_closed_outage() -> None:
    ledger = _audit_ledger()
    ledger.append(lease_id="lease_1", owner_id="owner_alice", event_type="SANDBOX_LEASE_CLAIMED")
    ledger.append(lease_id="lease_1", owner_id="owner_alice", event_type="EGRESS_ALLOW")
    ledger.verify_chain()

    ledger._entries[0] = dataclasses.replace(ledger._entries[0], payload={"tampered": True})
    with pytest.raises(AuditChainError) as corrupted:
        ledger.verify_chain()
    assert corrupted.value.code == AUDIT_CHAIN_CORRUPTED

    class _DownAuditLedger(TamperEvidentAuditLedger):
        def append(self, **kwargs):  # type: ignore[override]
            raise RuntimeError("audit storage unavailable")

    proxy = SentinelEgressGatekeeper(_DownAuditLedger(b"L" * 32))
    with pytest.raises(SentinelEgressError) as audit_down:
        proxy.authorize_and_prepare_egress(
            owner_id="owner_alice",
            lease_id="lease_1",
            url="https://api.github.com/user",
            resolved_ips=["140.82.116.6"],
            domain_rules={"api.github.com": "allow"},
        )
    assert audit_down.value.code == AUDIT_UNAVAILABLE
    assert audit_down.value.status == 503


def _assert_template_hardened(tpl: dict) -> None:
    assert tpl["apiVersion"] == "extensions.agents.x-k8s.io/v1beta1"
    assert tpl["spec"]["envVarsInjectionPolicy"] == "Disallowed"
    assert tpl["spec"]["volumeClaimTemplatesPolicy"] == "Disallowed"
    pod_spec = tpl["spec"]["podTemplate"]["spec"]
    assert pod_spec["automountServiceAccountToken"] is False
    assert pod_spec["restartPolicy"] == "Never"
    container = pod_spec["containers"][0]
    assert container["readinessProbe"]["httpGet"] == {"path": "/healthz", "port": 8080}
    sec = container["securityContext"]
    assert sec["allowPrivilegeEscalation"] is False
    assert sec["readOnlyRootFilesystem"] is True
    assert sec["runAsNonRoot"] is True
    assert sec["capabilities"]["drop"] == ["ALL"]
    env_names = {entry["name"] for entry in container["env"]}
    assert not ({"HUSSH_POD_MEMORY_KEY", "APP_SIGNING_KEY", "VAULT_DATA_KEY"} & env_names)


def test_k8s_manifests_ace_bundle_and_checked_in_yaml_invariants() -> None:
    with pytest.raises(ValueError, match=K8S_MANIFEST_INVARIANT_ERROR):
        render_sandbox_template(
            image_ref="us-docker.pkg.dev/hushh-pda-dev/hussh-sandbox/one-sandbox:latest"
        )

    with pytest.raises(PermissionError, match="VIRGIN_STANDBY_ROOT_FORBIDDEN"):
        build_readiness_payload(uid=0)
    assert build_readiness_payload(uid=10001)["status"] == "virgin_ready"

    bundle = render_agent_sandbox_bundle(
        claim_name="claim-user-123",
        billing_space_id="bs_123",
        image_ref=_IMAGE_WITH_DIGEST,
        runtime_class="gke-sandbox",
    )
    _assert_template_hardened(bundle["template"])
    assert bundle["claim"]["apiVersion"] == "extensions.agents.x-k8s.io/v1beta1"
    assert bundle["claim"]["spec"]["warmPoolRef"] == {"name": "hussh-one-warm-pool"}
    assert bundle["claim"]["spec"]["lifecycle"]["shutdownPolicy"] == "DeleteForeground"
    assert bundle["networkPolicy"]["spec"]["policyTypes"] == ["Ingress", "Egress"]

    ace_bundle = AceComputeBackend().render_k8s_agent_sandbox_bundle(
        PodSpec(
            hushh_id="user_123",
            phone_e164_hash="hash_123",
            pod_pubkey="pk_123",
            billing_space_id="bs_123",
        )
    )
    _assert_template_hardened(ace_bundle["template"])
    assert ace_bundle["claim"]["spec"]["lifecycle"]["shutdownPolicy"] == "DeleteForeground"

    deploy_dir = Path(__file__).resolve().parents[3] / "deploy" / "agent-sandbox"
    tpl_yaml = yaml.safe_load((deploy_dir / "sandbox-template.yaml").read_text(encoding="utf-8"))
    pool_yaml = yaml.safe_load((deploy_dir / "sandbox-warm-pool.yaml").read_text(encoding="utf-8"))
    net_yaml = yaml.safe_load(
        (deploy_dir / "sandbox-network-policy.yaml").read_text(encoding="utf-8")
    )

    _assert_template_hardened(tpl_yaml)
    assert pool_yaml["apiVersion"] == "extensions.agents.x-k8s.io/v1beta1"
    assert pool_yaml["kind"] == "SandboxWarmPool"
    assert pool_yaml["spec"]["sandboxTemplateRef"]["name"] == tpl_yaml["metadata"]["name"]
    assert pool_yaml["spec"]["updateStrategy"] == {"type": "Recreate"}
    assert net_yaml["spec"]["policyTypes"] == ["Ingress", "Egress"]
    assert net_yaml["spec"]["egress"][0]["ports"] == [{"protocol": "TCP", "port": 3128}]
