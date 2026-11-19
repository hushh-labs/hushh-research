# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Out-of-sandbox network egress policy evaluator (NIST SC-7(5), AC-6, #9744)."""

from __future__ import annotations

import ipaddress
import urllib.parse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

EGRESS_BLOCKED_SCHEME = "EGRESS_BLOCKED_SCHEME"
EGRESS_BLOCKED_DOMAIN = "EGRESS_BLOCKED_DOMAIN"
EGRESS_BLOCKED_TUNNEL = "EGRESS_BLOCKED_TUNNEL"
EGRESS_SSRF_BLOCKED = "EGRESS_SSRF_BLOCKED"
EGRESS_BLOCKED_PORT = "EGRESS_BLOCKED_PORT"
EGRESS_BLOCKED_DIRECT_PROTOCOL = "EGRESS_BLOCKED_DIRECT_PROTOCOL"

EgressAction = Literal["allow", "ask", "deny"]
DomainRuleMode = Literal["allow", "ask", "deny"]
DomainRuleMap = Mapping[str, DomainRuleMode]
DirectProtocolToggles = Mapping[str, bool]

DEFAULT_DIRECT_PROTOCOL_TOGGLES: dict[str, bool] = {
    "outbound_ssh": False,
    "smtp": False,
    "imap_pop3": False,
    "database": False,
    "ftp": False,
    "external_dns": False,
    "other_tcp": False,
    "other_udp": False,
}

_PORT_TO_PROTOCOL_KEY: dict[int, str] = {
    21: "ftp",
    22: "outbound_ssh",
    25: "smtp",
    53: "external_dns",
    110: "imap_pop3",
    143: "imap_pop3",
    465: "smtp",
    587: "smtp",
    993: "imap_pop3",
    995: "imap_pop3",
    3306: "database",
    5432: "database",
    6379: "database",
    27017: "database",
}

_BLOCKED_TUNNEL_SUFFIXES = (
    ".trycloudflare.com",
    ".ngrok.io",
    ".ngrok-free.app",
    ".ngrok-free.dev",
    ".localtunnel.me",
    ".loca.lt",
    ".serveo.net",
)

_METADATA_HOSTS = frozenset(
    {
        "metadata.google.internal",
        "metadata.goog",
        "169.254.169.254",
        "169.254.170.2",
        "100.100.100.200",
        "fd00:ec2::254",
    }
)


@dataclass(frozen=True)
class EgressVerdict:
    decision: EgressAction
    code: str
    reason: str
    normalized_origin: str
    host: str
    port: int


def _is_forbidden_ip(raw_ip: str) -> bool:
    cleaned = str(raw_ip or "").strip().strip("[]")
    if "%" in cleaned:
        cleaned = cleaned.split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(cleaned)
    except ValueError:
        return True
    if (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    ):
        return True
    # Block Carrier-Grade NAT 100.64.0.0/10 (used by Alibaba/cloud metadata & internal meshes)
    if isinstance(addr, ipaddress.IPv4Address) and addr in ipaddress.ip_network("100.64.0.0/10"):
        return True
    return False


def _match_domain_rule(host: str, rules: DomainRuleMap | None) -> DomainRuleMode | None:
    if not rules:
        return None
    normalized = {str(k).strip().lower(): v for k, v in rules.items()}
    if host in normalized:
        return normalized[host]
    labels = host.split(".")
    for idx in range(1, len(labels)):
        wildcard = "*." + ".".join(labels[idx:])
        if wildcard in normalized:
            return normalized[wildcard]
    return None


def evaluate_sandbox_egress(
    url: str,
    *,
    resolved_ips: Sequence[str],
    method: str = "GET",
    domain_rules: DomainRuleMap | None = None,
    protocol_toggles: DirectProtocolToggles | None = None,
    default_mode: Literal["ask", "deny"] = "ask",
) -> EgressVerdict:
    """Enforce FedRAMP SC-7 egress controls using resolved IPs and Muse-style rules."""
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    clean_method = str(method or "GET").strip().upper() or "GET"

    if not host or scheme not in {"http", "https"}:
        return EgressVerdict(
            decision="deny",
            code=EGRESS_BLOCKED_SCHEME,
            reason="Only outbound HTTP/HTTPS destinations with a valid hostname are permitted.",
            normalized_origin="",
            host=host,
            port=0,
        )

    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError:
        return EgressVerdict(
            decision="deny",
            code=EGRESS_BLOCKED_PORT,
            reason="Malformed port in egress URL.",
            normalized_origin="",
            host=host,
            port=0,
        )

    origin = f"{scheme}://{host}" + (
        f":{port}"
        if not ((scheme == "https" and port == 443) or (scheme == "http" and port == 80))
        else ""
    )

    if scheme != "https":
        return EgressVerdict(
            decision="deny",
            code=EGRESS_BLOCKED_SCHEME,
            reason="Cleartext HTTP egress is denied; HTTPS required.",
            normalized_origin=origin,
            host=host,
            port=port,
        )

    if host in _METADATA_HOSTS or host.endswith(".internal") or host.endswith(".local"):
        return EgressVerdict(
            decision="deny",
            code=EGRESS_SSRF_BLOCKED,
            reason="Cloud metadata and cluster-internal hostnames are blocked.",
            normalized_origin=origin,
            host=host,
            port=port,
        )

    if any(host.endswith(suffix) for suffix in _BLOCKED_TUNNEL_SUFFIXES):
        return EgressVerdict(
            decision="deny",
            code=EGRESS_BLOCKED_TUNNEL,
            reason="Public reverse-tunnel domains are denied.",
            normalized_origin=origin,
            host=host,
            port=port,
        )

    # Check resolved IP set fail-closed (guards against DNS rebinding and numeric SSRF tricks).
    ips = [str(ip).strip() for ip in resolved_ips if str(ip).strip()]
    if not ips or any(_is_forbidden_ip(ip) for ip in ips):
        return EgressVerdict(
            decision="deny",
            code=EGRESS_SSRF_BLOCKED,
            reason="Resolved destination IP is absent or inside a forbidden private/metadata CIDR.",
            normalized_origin=origin,
            host=host,
            port=port,
        )

    toggles = {**DEFAULT_DIRECT_PROTOCOL_TOGGLES, **dict(protocol_toggles or {})}
    if port != 443:
        proto_key = _PORT_TO_PROTOCOL_KEY.get(port, "other_tcp")
        if not toggles.get(proto_key, False):
            return EgressVerdict(
                decision="deny",
                code=EGRESS_BLOCKED_DIRECT_PROTOCOL,
                reason=f"Direct port {port} ({proto_key}) is off by default.",
                normalized_origin=origin,
                host=host,
                port=port,
            )

    explicit = _match_domain_rule(host, domain_rules)
    if explicit == "deny":
        return EgressVerdict(
            decision="deny",
            code=EGRESS_BLOCKED_DOMAIN,
            reason=f"Destination {host} is denied by owner permission policy.",
            normalized_origin=origin,
            host=host,
            port=port,
        )
    if explicit == "allow" and clean_method in {
        "GET",
        "HEAD",
        "OPTIONS",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
    }:
        return EgressVerdict(
            decision="allow",
            code="EGRESS_ALLOWED",
            reason="Allowed by owner domain policy.",
            normalized_origin=origin,
            host=host,
            port=port,
        )

    if default_mode == "deny":
        return EgressVerdict(
            decision="deny",
            code=EGRESS_BLOCKED_DOMAIN,
            reason=f"Destination {host} is not allowlisted.",
            normalized_origin=origin,
            host=host,
            port=port,
        )

    return EgressVerdict(
        decision="ask",
        code="EGRESS_OWNER_APPROVAL_REQUIRED",
        reason=f"Owner approval required before calling {origin}.",
        normalized_origin=origin,
        host=host,
        port=port,
    )
