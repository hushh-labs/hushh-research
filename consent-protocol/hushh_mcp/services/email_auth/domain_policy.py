"""Bounded public DNS evaluation; decisions establish technical mail eligibility."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import ssl
import time
from dataclasses import dataclass
from pathlib import Path

import certifi
import dns.asyncresolver
import dns.exception
import dns.resolver

from hushh_mcp.services.email_auth.contracts import DomainDecision, EmailAuthError, normalize_domain
from hushh_mcp.services.public_network_address import is_public_address


@dataclass(frozen=True)
class RiskSnapshot:
    domains: frozenset[str]
    version: str
    expires_at: float

    def __post_init__(self):
        if not math.isfinite(self.expires_at) or self.expires_at <= 0:
            raise ValueError("Email domain risk snapshot expiry is invalid.")

    @classmethod
    def load(cls, manifest_path: str) -> RiskSnapshot:
        manifest = Path(manifest_path)
        data = json.loads(manifest.read_text(encoding="utf-8"))
        content = (manifest.parent / data["file"]).read_bytes()
        if hashlib.sha256(content).hexdigest() != data["sha256"]:
            raise ValueError("Email domain risk snapshot digest mismatch.")
        if len(content) > 2_000_000:
            raise ValueError("Email domain risk snapshot exceeds bounds.")
        valid = set()
        invalid = 0
        for line in content.decode("utf-8").splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            try:
                valid.add(normalize_domain(line.strip()))
            except EmailAuthError:
                # These strings cannot pass the same admission parser either.
                invalid += 1
        domains = frozenset(valid)
        if invalid > max(5, len(domains) // 100):
            raise ValueError("Email domain risk snapshot has excessive invalid entries.")
        if not domains or not data.get("source") or not data.get("license"):
            raise ValueError("Email domain risk snapshot is incomplete.")
        expiry = float(data["expires_at"])
        if not math.isfinite(expiry) or expiry <= 0:
            raise ValueError("Email domain risk snapshot expiry is invalid.")
        return cls(domains, str(data["sha256"]), expiry)

    def blocks(self, domain: str) -> bool:
        # Risk on a parent blocks children; approval never inherits to children.
        labels = domain.split(".")
        return any(".".join(labels[i:]) in self.domains for i in range(len(labels) - 1))


class DomainEvaluator:
    def __init__(self, risk: RiskSnapshot, resolver=None):
        self.risk = risk
        self.resolver = resolver or dns.asyncresolver.Resolver()

    async def _resolve(self, name: str, record: str):
        answer = await self.resolver.resolve(name + ".", record, search=False, lifetime=1.5)
        if len(answer.response.answer) > 8 or len(answer) > 32:
            raise ValueError("DNS response exceeds policy bounds.")
        return answer

    async def certificate_evidence(self, domain: str) -> str:
        """Optional HTTPS TLS proof; never required for mail-only domains."""
        writer = None
        try:
            async with asyncio.timeout(2):
                addresses = []
                for kind in ("A", "AAAA"):
                    try:
                        answer = await self._resolve(domain, kind)
                        addresses.extend(str(item) for item in answer)
                    except dns.resolver.NoAnswer:
                        continue
                if not addresses or not all(is_public_address(ip) for ip in addresses):
                    return "unavailable"
                # Numeric TCP destination is pinned; TLS still validates the named domain.
                _, writer = await asyncio.open_connection(
                    addresses[0],
                    443,
                    ssl=ssl.create_default_context(cafile=certifi.where()),
                    server_hostname=domain,
                )
                return "valid_public_ca"
        except (OSError, dns.exception.DNSException, TimeoutError, ValueError):
            return "unavailable"
        finally:
            if writer:
                writer.close()
                try:
                    await asyncio.wait_for(writer.wait_closed(), timeout=0.2)
                except (OSError, TimeoutError):
                    pass

    async def evaluate(self, domain: str) -> DomainDecision:
        domain = normalize_domain(domain)
        now = time.time()

        def result(status: str, reason: str, expiry: float = now + 15) -> DomainDecision:
            return DomainDecision(domain, status, reason, expiry, self.risk.version)

        if self.risk.expires_at <= now:
            return result("pending", "risk_snapshot_expired")
        if self.risk.blocks(domain):
            return result("denied", "domain_risk_policy", min(now + 3600, self.risk.expires_at))
        try:
            async with asyncio.timeout(6):
                mx = await self._resolve(domain, "MX")
                if not 1 <= len(mx) <= 10:
                    return result("pending", "mx_bounds")
                hosts = [str(item.exchange).rstrip(".").lower() for item in mx]
                if any(not host for host in hosts):
                    return result("denied", "null_or_invalid_mx")
                expiry = min(now + 3600, self.risk.expires_at, float(mx.expiration))
                for host in hosts:
                    normalize_domain(host)
                    addresses = []
                    for kind in ("A", "AAAA"):
                        try:
                            answer = await self._resolve(host, kind)
                        except dns.resolver.NoAnswer:
                            continue
                        expiry = min(expiry, float(answer.expiration))
                        addresses.extend(str(record) for record in answer)
                    if not addresses:
                        return result("pending", "mx_address_unavailable")
                    if len(addresses) > 32 or not all(is_public_address(ip) for ip in addresses):
                        return result("denied", "unsafe_mail_route")
                if expiry <= time.time():
                    return result("pending", "dns_evidence_expired")
                return result("approved", "technical_policy_passed", expiry)
        except dns.resolver.NXDOMAIN:
            return result("denied", "domain_not_found")
        except dns.resolver.NoAnswer:
            return result("pending", "explicit_mx_required")
        except (dns.exception.DNSException, TimeoutError, ValueError):
            return result("pending", "domain_evidence_unavailable")
