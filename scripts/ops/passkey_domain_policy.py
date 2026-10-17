"""Exact hosted-domain policy derived from the existing passkey catalog."""

from __future__ import annotations

import json
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[2] / "hushh-webapp/lib/vault/passkey-domain-aliases.json"
LOCAL_RP_IDS = ("localhost", "127.0.0.1")


def related_hosts(host: str) -> tuple[str, ...]:
    aliases = json.loads(CATALOG.read_text())
    return next((tuple(pair) for pair in aliases.values() if host in pair), (host,))


def allowed_rp_ids(host: str) -> str:
    return ",".join(dict.fromkeys((*LOCAL_RP_IDS, *related_hosts(host))))


def cors_with_aliases(host: str, configured: str) -> str:
    origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    if f"https://{host}" in origins:
        origins.extend(f"https://{alias}" for alias in related_hosts(host))
    return ",".join(dict.fromkeys(origins))


def domain_expectations(origin: str, host: str) -> tuple[set[str], set[str]]:
    hosts = related_hosts(host)
    cors = {f"https://{alias}" for alias in hosts} if len(hosts) > 1 else {origin.rstrip("/")}
    return cors, {"localhost", "127.0.0.1", *hosts}
