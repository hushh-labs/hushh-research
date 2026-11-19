# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Out-of-sandbox Sentinel Egress Gatekeeper with edge credential swap (#9744)."""

from __future__ import annotations

import re
import secrets
import time
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from hushh_mcp.operons.agent_sandbox.egress_policy import (
    DirectProtocolToggles,
    DomainRuleMap,
    EgressVerdict,
    evaluate_sandbox_egress,
)
from hushh_mcp.operons.agent_sandbox.tamper_evident_audit import TamperEvidentAuditLedger

SURROGATE_PREFIX = "hsur_"
SURROGATE_EXFILTRATION_BLOCKED = "SURROGATE_EXFILTRATION_BLOCKED"
AUDIT_UNAVAILABLE = "AUDIT_UNAVAILABLE"

_SURROGATE_RE = re.compile(r"hsur_[a-f0-9]{48}")


class SentinelEgressError(RuntimeError):
    """Fail-closed egress refusal from outside the sandbox trust boundary."""

    def __init__(self, code: str, detail: str = "", *, status: int = 403) -> None:
        self.code = code
        self.status = status
        super().__init__(detail or code)


@dataclass
class SurrogateGrant:
    surrogate_token: str
    owner_id: str
    lease_id: str
    allowed_origin: str
    header_name: str
    _real_secret: str
    expires_at_s: int
    revoked: bool = False


@dataclass(frozen=True)
class PreparedEgressRequest:
    verdict: EgressVerdict
    outbound_headers: dict[str, str]
    substituted_header_names: tuple[str, ...]
    audit_seq: int


def _normalize_origin(raw_url: str) -> str:
    parsed = urllib.parse.urlsplit(str(raw_url or "").strip())
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not scheme or not host:
        return ""
    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError:
        return ""
    if (scheme == "https" and port == 443) or (scheme == "http" and port == 80):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


class SentinelEgressGatekeeper:
    """Host-side proxy enforcing SC-7 egress, edge credential swap, and AU-9 logging."""

    def __init__(
        self,
        audit_ledger: TamperEvidentAuditLedger,
        *,
        clock_s: Callable[[], int] | None = None,
    ) -> None:
        self.audit_ledger = audit_ledger
        self._clock_s = clock_s or (lambda: int(time.time()))
        self._grants: dict[str, SurrogateGrant] = {}

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
        origin = _normalize_origin(allowed_origin)
        clean_header = str(header_name or "").strip()
        if not origin.startswith("https://") or not clean_header or not real_secret:
            raise ValueError("HTTPS origin, header_name, and non-empty real_secret are required")
        token = f"{SURROGATE_PREFIX}{secrets.token_hex(24)}"
        self._grants[token] = SurrogateGrant(
            surrogate_token=token,
            owner_id=str(owner_id),
            lease_id=str(lease_id),
            allowed_origin=origin,
            header_name=clean_header,
            _real_secret=real_secret,
            expires_at_s=int(self._clock_s()) + max(30, min(900, int(ttl_seconds))),
        )
        self._record_audit(
            lease_id=lease_id,
            owner_id=owner_id,
            event_type="SURROGATE_TOKEN_ISSUED",
            payload={"allowed_origin": origin, "header_name": clean_header},
        )
        return token

    def revoke_lease_surrogates(self, lease_id: str) -> int:
        revoked = 0
        for grant in self._grants.values():
            if grant.lease_id == lease_id and not grant.revoked:
                grant.revoked = True
                revoked += 1
        return revoked

    def _record_audit(
        self,
        *,
        lease_id: str,
        owner_id: str,
        event_type: str,
        payload: Mapping[str, object],
    ) -> int:
        try:
            entry = self.audit_ledger.append(
                lease_id=lease_id,
                owner_id=owner_id,
                event_type=event_type,
                payload=payload,
            )
            return entry.seq
        except Exception as exc:  # noqa: BLE001
            # NIST AU-5: audit failure must fence outbound egress rather than proceed unlogged.
            raise SentinelEgressError(
                AUDIT_UNAVAILABLE, "Audit ledger unavailable", status=503
            ) from exc

    def _inspect_surrogates(
        self,
        *,
        owner_id: str,
        lease_id: str,
        target_origin: str,
        url: str,
        headers: Mapping[str, str],
        body_text: str,
    ) -> list[tuple[str, SurrogateGrant]]:
        """Detect any surrogate token in outbound payload; revoke immediately on mismatch."""
        found_tokens = set(_SURROGATE_RE.findall(url)) | set(_SURROGATE_RE.findall(body_text))
        header_matches: list[tuple[str, SurrogateGrant]] = []
        now_s = int(self._clock_s())

        for hdr_key, hdr_val in headers.items():
            for match in _SURROGATE_RE.findall(hdr_val):
                found_tokens.add(match)
                grant = self._grants.get(match)
                if grant is not None:
                    header_matches.append((hdr_key, grant))

        # Body or query URL carrying a surrogate token is always an exfiltration smell.
        body_or_url_tokens = set(_SURROGATE_RE.findall(url)) | set(_SURROGATE_RE.findall(body_text))
        for tok in sorted(found_tokens):
            grant = self._grants.get(tok)
            if (
                grant is None
                or grant.revoked
                or grant.expires_at_s <= now_s
                or grant.owner_id != owner_id
                or grant.lease_id != lease_id
                or grant.allowed_origin != target_origin
                or tok in body_or_url_tokens
            ):
                if grant is not None:
                    grant.revoked = True
                self._record_audit(
                    lease_id=lease_id,
                    owner_id=owner_id,
                    event_type=SURROGATE_EXFILTRATION_BLOCKED,
                    payload={
                        "target_origin": target_origin,
                        "surrogate_revoked": grant is not None,
                    },
                )
                raise SentinelEgressError(
                    SURROGATE_EXFILTRATION_BLOCKED,
                    "Surrogate token used outside bound origin, lease, or header.",
                    status=403,
                )
        return header_matches

    def authorize_and_prepare_egress(
        self,
        *,
        owner_id: str,
        lease_id: str,
        url: str,
        resolved_ips: Sequence[str],
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        body_text: str = "",
        domain_rules: DomainRuleMap | None = None,
        protocol_toggles: DirectProtocolToggles | None = None,
        default_mode: str = "ask",
    ) -> PreparedEgressRequest:
        verdict = evaluate_sandbox_egress(
            url,
            resolved_ips=resolved_ips,
            method=method,
            domain_rules=domain_rules,
            protocol_toggles=protocol_toggles,
            default_mode="deny" if default_mode == "deny" else "ask",
        )
        hdrs = dict(headers or {})
        matches = self._inspect_surrogates(
            owner_id=owner_id,
            lease_id=lease_id,
            target_origin=verdict.normalized_origin,
            url=url,
            headers=hdrs,
            body_text=body_text,
        )
        audit_seq = self._record_audit(
            lease_id=lease_id,
            owner_id=owner_id,
            event_type=f"EGRESS_{verdict.decision.upper()}",
            payload={
                "origin": verdict.normalized_origin,
                "method": method,
                "code": verdict.code,
            },
        )
        if verdict.decision != "allow":
            status = 403 if verdict.decision == "deny" else 428
            raise SentinelEgressError(verdict.code, verdict.reason, status=status)

        substituted: list[str] = []
        for hdr_key, grant in matches:
            hdrs[hdr_key] = hdrs[hdr_key].replace(grant.surrogate_token, grant._real_secret)
            substituted.append(hdr_key)
        return PreparedEgressRequest(
            verdict=verdict,
            outbound_headers=hdrs,
            substituted_header_names=tuple(substituted),
            audit_seq=audit_seq,
        )
