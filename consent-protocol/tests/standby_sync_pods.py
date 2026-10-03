"""Two in-process pods behind real ``/pod/sync/*`` routes, reached over HTTP by the hub.

Shared by the standby-sync ferry tests; holds no tests itself. Each pod is a
role-aware commit log on its own storage under its own log key and identity keypair,
one HusshID between them, exactly as two clouds would hold it. The hub side is the
REAL ``pod_sync_transport`` -> ``pod_migration_transport._post`` path: the session
below is the network, routing by host to a ``TestClient`` over the real router.

The hub-proof gate is replaced by one that accepts only the proof the hub minted for
the audience the POD computed from the body it parsed. So every passing call proves
the hub and the pod agreed on the body digest (E6) through real JSON serialisation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes.one import pod_migration, pod_sync
from hushh_mcp.services import pod_role
from hushh_mcp.services.pod_commit_log import LocalObjectStore
from hushh_mcp.services.pod_connector_keypair_service import PodKeyPair, generate_pod_keypair
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id
from hushh_mcp.services.pod_role_log import RoleAwareCommitLog
from hushh_mcp.services.pod_self_registration import derive_signing_key

OWNER_HUSHH_ID = "ha1_owner"
USER = "firebase-owner"
PRIMARY_URL = "https://primary.pod.test"
STANDBY_URL = "https://standby.pod.test"


@dataclass
class Pod:
    url: str
    log: RoleAwareCommitLog
    keypair: PodKeyPair

    @property
    def signing_id(self) -> str:
        return signing_key_id(public_key_b64(derive_signing_key(self.keypair.private_key)))


def make_pod(tmp_path, name: str, url: str, key: bytes) -> Pod:
    store = LocalObjectStore(str(tmp_path / name))
    return Pod(url, RoleAwareCommitLog(store, key, owner_id=OWNER_HUSHH_ID), generate_pod_keypair())


def use(monkeypatch, pod: Pod) -> None:
    """Point the routes at one pod, as if the request had arrived there."""
    monkeypatch.setattr(pod_migration, "_commit_log", lambda: pod.log)
    monkeypatch.setattr("hushh_mcp.services.pod_self_registration.pod_keypair", lambda: pod.keypair)
    pod_role.reset_role_cache()


def minter(audience: str) -> str:
    return f"minted::{audience}"


def install_proof_gate(monkeypatch) -> list[str]:
    """Accept exactly the proof the hub minted for the audience the pod computed."""
    seen: list[str] = []

    def gate(proof: Optional[str], *, audience: Optional[str] = None) -> None:
        seen.append(str(audience))
        if proof != f"Bearer {minter(str(audience))}":
            raise HTTPException(status_code=403, detail="migration refused")

    monkeypatch.setattr(pod_migration, "_require_hub_caller", gate)
    return seen


class _Response:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> Any:
        return self._body


@dataclass
class Network:
    """A ``requests``-shaped session: routes by host to the right pod's real routes."""

    monkeypatch: Any
    pods: dict[str, Pod]
    calls: list[tuple[str, str]] = field(default_factory=list)
    #: Optional hook (host, path, body) -> body, to play a dishonest or broken hub.
    rewrite: Any = None

    def __post_init__(self) -> None:
        app = FastAPI()
        app.include_router(pod_sync.router)
        self._client = TestClient(app, follow_redirects=False)

    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        assert allow_redirects is False, "the hub proof must never follow a redirect"
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        assert headers["Authorization"] == f"Bearer {minter(origin)}"
        self.calls.append((origin, parts.path))
        use(self.monkeypatch, self.pods[origin])
        response = self._client.post(parts.path, json=json, headers=headers)
        body = response.json()
        if self.rewrite is not None and response.status_code == 200:
            body = self.rewrite(origin, parts.path, body)
        return _Response(response.status_code, body)

    def paths(self, origin: str) -> list[str]:
        return [path for host, path in self.calls if host == origin]


def set_role(network: Network, pod: Pod, role: str, epoch: int, primary_id=None) -> dict:
    """The hub's real set-role call (``pod_sync_transport.set_role``), over the network."""
    from hushh_mcp.services import pod_sync_transport  # noqa: PLC0415

    return pod_sync_transport.set_role(
        pod_url=pod.url,
        hushh_id=OWNER_HUSHH_ID,
        role=role,
        epoch=epoch,
        primary_signing_key_id=primary_id,
        target_pod_signing_key_id=pod.signing_id,
        expires_at=int(time.time()) + 600,
        session=network,
        token_minter=minter,
    )


async def head_of(monkeypatch, pod: Pod) -> tuple[int, str]:
    use(monkeypatch, pod)
    cursor = await pod.log.verified_head()
    return (cursor.seq, cursor.sha) if cursor else (0, "")


def primary_row(primary: Pod, *, epoch: int = 0, **overrides: Any) -> dict:
    row = {
        "user_id": USER,
        "hushh_id": OWNER_HUSHH_ID,
        "status": "provisioned",
        "placement_epoch": epoch,
        "pod_key_id": primary.keypair.key_id,
        "pod_signing_key_id": primary.signing_id,
        "backend_metadata": {"url": primary.url},
    }
    row.update(overrides)
    return row


def standby_row(standby: Pod, *, epoch: int = 0, **overrides: Any) -> dict:
    row = {
        "user_id": USER,
        "hushh_id": OWNER_HUSHH_ID,
        "url": standby.url,
        "pod_pubkey": standby.keypair.public_key_b64,
        "pod_key_id": standby.keypair.key_id,
        "pod_signing_key_id": standby.signing_id,
        "placement_epoch": epoch,
        "synced_seq": 0,
        "synced_head_sha": None,
    }
    row.update(overrides)
    return row


class MemoryStandbyStore:
    """The store's contract in memory: one lease, fenced on epoch and standby key."""

    def __init__(self, row: dict) -> None:
        self.row: Optional[dict] = dict(row)
        self.lease: Optional[str] = None
        self.results: list[dict] = []
        self.claims: list[int] = []

    def _fenced(self, observed: dict) -> bool:
        row = self.row or {}
        return observed.get("placement_epoch") == row.get("placement_epoch") and observed.get(
            "pod_key_id"
        ) == row.get("pod_key_id")

    async def read_standby(self, user_id: str) -> Optional[dict]:
        return dict(self.row) if self.row and user_id == self.row["user_id"] else None

    async def claim_sync_lease(self, user_id, observed, lease_id, cooldown_seconds):
        self.claims.append(cooldown_seconds)
        if self.lease is not None or not self._fenced(observed):
            return None
        self.lease = lease_id
        return dict(self.row)

    async def record_sync_result(self, user_id, observed, lease_id, seq, head, status):
        if lease_id != self.lease or not self._fenced(observed):
            return None
        if status == "synced" and seq < self.row["synced_seq"]:
            return None
        self.lease = None
        self.results.append({"status": status, "seq": seq, "head": head})
        if status == "synced":
            self.row.update(synced_seq=seq, synced_head_sha=head)
        return dict(self.row)


class MemoryRegistry:
    def __init__(self, row: dict) -> None:
        self.row = row

    async def get(self, user_id: str) -> Optional[dict]:
        return dict(self.row) if user_id == self.row["user_id"] else None


async def table_ready() -> bool:
    return True
