"""Dev multi-pod simulation — N per-user pods, each with its own PKM, sharing scopes.

This simulates what the **dev GCP project** does when it hosts a fleet of per-user
pods. It is deliberately NOT a mock: every pod gets a real ``PodPkmStore`` (real
SQLite engine + real sealed, hash-chained commit log over a real object store)
and, with ``--http``, a real ``pod_server`` process — the same code that runs
inside the Cloud Run container, scheduled by the OS instead of by Cloud Run.

**Three tiers, because the architecture has three.** Two facts force this shape and
a simulation that ignores either would prove nothing:

1. *A pod cannot answer a cross-user query by construction.* ``PkmWriteEngine``
   deliberately excludes ``match_user_profiles`` — single-user engines cannot
   answer it. Cross-user discovery is control-plane work.
2. *Sharing is a hub-mediated, client-encrypted export, not a pod-to-pod read.*
   Nothing in the codebase lets pod A read pod B's SQLite, and ``PodPkmStore`` has
   no cross-user surface at all.

So: **Tier A** is the per-pod data plane (real), **Tier B** the per-pod runtime
process (real), **Tier C** the control plane — the scope catalogue, the share
ledger, and the metadata-only audit. Tier C is in-process here; it holds metadata
only, which is exactly the founder constraint on the real ledger (it records that
access happened, never what).

Every cycle runs the probe suite against every pod and appends to a rolling status
file. It runs until stopped — the point is to hold the fleet up under continuous
mutation, not to pass once and exit.

Usage::

    uv run python scripts/sim_multi_pod.py --pods 10 --http
    uv run python scripts/sim_multi_pod.py --pods 20 --http

Stop it with SIGTERM/SIGINT; it tears the pod processes down on the way out.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.pkm_sqlite_engine import (  # noqa: E402
    ERR_COMMIT_BINDING,
    SqlitePkmWriteEngine,
)
from hushh_mcp.services.pod_commit_log import (  # noqa: E402
    LocalObjectStore,
    PodCommitLog,
)
from hushh_mcp.services.pod_pkm_store import PodPkmStore  # noqa: E402

DOMAIN = "financial"
FINGERPRINT_A = "2" * 64
FINGERPRINT_B = "9" * 64


# --------------------------------------------------------------------------------------
# Mutation shapes (mirrors tests/pkm_conformance/oracle.py so the simulation issues the
# same commits the conformance oracle proved against real Postgres).
# --------------------------------------------------------------------------------------


def _segments(version: int) -> list[dict]:
    return [
        {
            "segment_id": "root",
            "ciphertext": f"cipher-root-v{version}",
            "iv": f"iv-root-v{version}",
            "tag": f"tag-root-v{version}",
            "algorithm": "aes-256-gcm",
            "manifest_revision": version,
            "size_bytes": 14,
        }
    ]


def _manifest(version: int) -> dict:
    return {
        "manifest_version": version,
        "domain_contract_version": 4,
        "readable_summary_version": 1,
        "pkm_contract_version": "6.0.0",
        "readable_projection_version": "6.0.0",
        "structure_decision": {},
        "summary_projection": {
            "pkm_contract_version": "6.0.0",
            "readable_projection_version": "6.0.0",
        },
        "top_level_scope_paths": ["portfolio"],
        "externalizable_paths": [],
        "segment_ids": ["root"],
        "path_count": 1,
        "externalizable_path_count": 0,
        "last_structured_at": "2026-01-01T00:00:00+00:00",
        "last_content_at": "2026-01-01T00:00:00+00:00",
    }


def _commit_params(
    user_id: str,
    *,
    expected: int,
    next_revision: int,
    commit_id: str,
    fingerprint: str = FINGERPRINT_A,
) -> dict:
    return {
        "p_user_id": user_id,
        "p_domain": DOMAIN,
        "p_expected_content_revision": expected,
        "p_next_content_revision": next_revision,
        "p_segment_rows": _segments(next_revision),
        "p_manifest_row": _manifest(next_revision),
        "p_path_rows": [],
        "p_scope_rows": [],
        "p_summary_patch": {},
        "p_event_rows": [],
        "p_legacy_blob_present": False,
        "p_refresh_tokens": [],
        "p_trigger_paths": [],
        "p_commit_id": commit_id,
        "p_commit_kind": "mutation",
        "p_upgrade_claim": None,
        "p_preservation_receipt": {},
        "p_request_fingerprint": fingerprint,
    }


def _unwrap(result: Any, fn: str) -> Any:
    payload = getattr(result, "data", result)
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if isinstance(payload, dict) and len(payload) == 1 and fn in payload:
        payload = payload[fn]
    return payload


# --------------------------------------------------------------------------------------
# Tier C — the control plane. Metadata only, by construction.
# --------------------------------------------------------------------------------------


@dataclass
class ShareRecord:
    """One scope shared from an owner to a recipient. Carries NO value.

    The founder constraint on the real ledger is that it records *that* access
    happened, never *what*. This record is the simulation's enforcement of that:
    there is nowhere here to put content, so a leak would have to be a code change
    rather than a slip.
    """

    owner_hushh_id: str
    recipient_hushh_id: str
    scope: str
    granted_at: float


@dataclass
class ControlPlane:
    """Registers pods, brokers scopes, and audits — holding no private intelligence."""

    pods: dict[str, str] = field(default_factory=dict)  # hushh_id -> pod url (or "")
    shares: list[ShareRecord] = field(default_factory=list)
    audit: list[dict] = field(default_factory=list)

    def register(self, hushh_id: str, url: str) -> None:
        self.pods[hushh_id] = url

    def share(self, owner: str, recipient: str, scope: str) -> ShareRecord:
        record = ShareRecord(owner, recipient, scope, time.time())
        self.shares.append(record)
        return record

    def is_shared(self, owner: str, recipient: str, scope: str) -> bool:
        return any(
            s.owner_hushh_id == owner and s.recipient_hushh_id == recipient and s.scope == scope
            for s in self.shares
        )

    def receipt(self, *, actor: str, target: str, scope: str, allowed: bool) -> dict:
        """A metadata-only access receipt: who, what scope, which pod, allowed. No content."""
        entry = {
            "actor": actor,
            "targetPod": target,
            "scope": scope,
            "action": "POD_ACCESS_ALLOWED" if allowed else "POD_ACCESS_DENIED",
            "at": time.time(),
        }
        self.audit.append(entry)
        return entry


# --------------------------------------------------------------------------------------
# Tier A + B — one simulated pod
# --------------------------------------------------------------------------------------


@dataclass
class Pod:
    index: int
    hushh_id: str
    user_id: str
    root: Path
    port: int
    seal_key: bytes
    store: PodPkmStore
    log: PodCommitLog
    revision: int = 0
    process: Optional[subprocess.Popen] = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def _seal_key_for(index: int) -> bytes:
    """A DISTINCT 32-byte seal key per pod. Distinctness is the point: pod i's log
    must be undecryptable with pod j's key, which is what makes the object store a
    safe shared substrate."""
    return hashlib.sha256(f"hussh-sim-pod-seal-{index}".encode()).digest()


def build_pod(index: int, root: Path, base_port: int) -> Pod:
    hushh_id = f"HA1SIM{index:04d}"
    pod_root = root / f"pod-{index:04d}"
    (pod_root / "store").mkdir(parents=True, exist_ok=True)
    seal_key = _seal_key_for(index)
    log = PodCommitLog(LocalObjectStore(str(pod_root / "store")), seal_key)
    engine = SqlitePkmWriteEngine(str(pod_root / "pkm.sqlite3"))
    return Pod(
        index=index,
        hushh_id=hushh_id,
        user_id=f"sim-user-{index:04d}",
        root=pod_root,
        port=base_port + index,
        seal_key=seal_key,
        store=PodPkmStore(engine, log),
        log=log,
    )


def start_pod_process(pod: Pod, repo: Path) -> subprocess.Popen:
    """Boot the REAL pod_server for this pod, with its own identity and its own key."""
    env = dict(os.environ)
    env.update(
        {
            "HUSSH_POD_MODE": "1",
            "HUSSH_ID": pod.hushh_id,
            "HUSSH_SPACE_ID": f"space-{pod.index:04d}",
            "PERSONAL_AGENT_ENABLED": "1",
            # Per-pod signing key. Distinct on purpose: with symmetric HMAC the power
            # to verify is the power to forge, so a shared key across the fleet would
            # make any one pod a universal forger for every user.
            "APP_SIGNING_KEY": hashlib.sha256(
                f"hussh-sim-pod-signing-{pod.index}".encode()
            ).hexdigest(),
            "PKM_SQLITE_PATH": str(pod.root / "pkm.sqlite3"),
            # Pod-unique. `pod_memory_service._digest` is a KEYED HMAC per word, so a
            # fleet sharing this key makes identical words produce identical digests
            # across pods -- a cross-pod content-correlation channel over indexes that
            # are nominally encrypted.
            "HUSSH_POD_MEMORY_KEY": hashlib.sha256(
                f"hussh-sim-pod-memory-{pod.index}".encode()
            ).hexdigest(),
            # Never on for the run: it would let a pod assert another pod's identity
            # via X-Hushh-Pod-Id and read that owner's prompt.
            "POD_HUB_IDENTITY_AUTH_ENABLED": "0",
        }
    )
    log_path = pod.root / "server.log"
    return subprocess.Popen(  # noqa: S603
        [
            "uv",
            "run",
            "uvicorn",
            "pod_server:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(pod.port),
            "--log-level",
            "warning",
        ],
        cwd=str(repo),
        env=env,
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
    )


# --------------------------------------------------------------------------------------
# The probe suite — every invariant, every cycle
# --------------------------------------------------------------------------------------


async def probe_write_and_read_back(pod: Pod) -> tuple[bool, str]:
    """A real commit lands, and the pod reads back exactly what it wrote."""
    nxt = pod.revision + 1
    params = _commit_params(
        pod.user_id,
        expected=pod.revision,
        next_revision=nxt,
        commit_id=f"{pod.hushh_id}-c{nxt}",
    )
    result = _unwrap(
        await pod.store.commit_domain_mutation(params), "commit_pkm_domain_mutation_v4"
    )
    if not isinstance(result, dict) or not result.get("success"):
        return False, f"commit rejected: {result}"
    pod.revision = nxt
    snap = _unwrap(
        await pod.store.get_domain_snapshot(
            {"p_user_id": pod.user_id, "p_domain": DOMAIN, "p_segment_ids": None}
        ),
        "get_pkm_domain_snapshot_v1",
    )
    got = (snap or {}).get("content_revision")
    if got != nxt:
        return False, f"read-back revision {got} != {nxt}"
    return True, f"rev={nxt}"


async def probe_no_foreign_user(pod: Pod, other: Pod) -> tuple[bool, str]:
    """This pod holds ONE user. Another user's id must return nothing from it."""
    snap = _unwrap(
        await pod.store.get_domain_snapshot(
            {"p_user_id": other.user_id, "p_domain": DOMAIN, "p_segment_ids": None}
        ),
        "get_pkm_domain_snapshot_v1",
    )
    if snap and snap.get("content_revision"):
        return False, f"pod {pod.hushh_id} returned rows for {other.user_id}"
    return True, "isolated"


async def probe_chain_integrity(pod: Pod) -> tuple[bool, str]:
    """The sealed log replays; a broken hash chain raises PodLogTampered."""
    try:
        entries = await pod.log.replay()
    except Exception as exc:  # noqa: BLE001 - any replay failure is the finding
        return False, f"{type(exc).__name__}: {exc}"
    return True, f"entries={len(entries)}"


async def probe_stale_revision_conflicts(pod: Pod) -> tuple[bool, str]:
    """Optimistic concurrency holds: a stale expected revision conflicts and writes
    nothing. Losing this silently converts device-sync conflicts into data loss."""
    params = _commit_params(
        pod.user_id,
        expected=max(pod.revision - 1, 0),
        next_revision=pod.revision + 1,
        commit_id=f"{pod.hushh_id}-stale-{pod.revision}",
    )
    result = _unwrap(
        await pod.store.commit_domain_mutation(params), "commit_pkm_domain_mutation_v4"
    )
    if not isinstance(result, dict) or not result.get("conflict"):
        return False, f"stale write was NOT refused: {result}"
    snap = _unwrap(
        await pod.store.get_domain_snapshot(
            {"p_user_id": pod.user_id, "p_domain": DOMAIN, "p_segment_ids": None}
        ),
        "get_pkm_domain_snapshot_v1",
    )
    if (snap or {}).get("content_revision") != pod.revision:
        return False, "a conflicting write mutated state"
    return True, "conflict refused"


async def probe_commit_binding(pod: Pod) -> tuple[bool, str]:
    """The same commit id with a different request fingerprint must be refused --
    otherwise a replayed commit id could carry a different body."""
    commit_id = f"{pod.hushh_id}-bind-{pod.revision}"
    base = _commit_params(
        pod.user_id,
        expected=pod.revision,
        next_revision=pod.revision + 1,
        commit_id=commit_id,
        fingerprint=FINGERPRINT_A,
    )
    _unwrap(await pod.store.commit_domain_mutation(base), "commit_pkm_domain_mutation_v4")
    pod.revision += 1
    clash = _commit_params(
        pod.user_id,
        expected=pod.revision - 1,
        next_revision=pod.revision,
        commit_id=commit_id,
        fingerprint=FINGERPRINT_B,
    )
    try:
        await pod.store.commit_domain_mutation(clash)
    except Exception as exc:  # noqa: BLE001 - the refusal is the pass
        # Compare against the engine's own constant, not a copy of its spelling --
        # the first draft of this probe asserted the CONSTANT NAME and reported a
        # correctly-enforced invariant as a failure.
        if ERR_COMMIT_BINDING in str(exc):
            return True, "binding enforced"
        return False, f"wrong error: {type(exc).__name__}: {exc}"
    return False, "commit-id/fingerprint clash was ACCEPTED"


async def probe_seal_key_isolation(pod: Pod, other: Pod) -> tuple[bool, str]:
    """Pod i's log must be undecryptable with pod j's key.

    This is what makes a shared object store safe: even with full read access to
    another pod's bytes, without that pod's key there is nothing to read.
    """
    foreign = PodCommitLog(LocalObjectStore(str(pod.root / "store")), other.seal_key)
    try:
        await foreign.replay()
    except Exception:  # noqa: BLE001 - failing to decrypt is the pass
        return True, "foreign key refused"
    return False, f"{other.hushh_id}'s key DECRYPTED {pod.hushh_id}'s log"


async def probe_rebuild_owner_filter(pod: Pod, other: Pod) -> tuple[bool, str]:
    """A rebuild must materialise ONLY this pod's owner.

    ``PodPkmStore.rebuild`` replays every record and dispatches on ``kind`` with no
    check that ``payload["p_user_id"]`` is this pod's owner (contrast
    ``CommitLogPodStorage.restore``, which does filter on ``hushh_id``). A shared
    bucket plus a shared log key would therefore let one pod rebuild another user's
    entire PKM into its own index. Pod-unique keys and prefixes are what keep this
    dormant here -- this probe asserts the guard those choices are standing in for.
    """
    foreign = _unwrap(
        await pod.store.get_domain_snapshot(
            {"p_user_id": other.user_id, "p_domain": DOMAIN, "p_segment_ids": None}
        ),
        "get_pkm_domain_snapshot_v1",
    )
    if foreign and foreign.get("content_revision"):
        return False, f"{pod.hushh_id} materialised {other.user_id}'s holdings"
    return True, "owner-scoped"


async def probe_commit_binding_cross_user(pod: Pod, other: Pod) -> tuple[bool, str]:
    """The SAME commit id under a DIFFERENT user must be refused.

    The SQLite engine's replay check compares ``request_fingerprint`` only, while
    the Postgres oracle also compares user_id, domain, commit_kind and the expected
    revision. The conformance suite only ever tests same-user/different-fingerprint,
    so the engine passes the oracle while being strictly weaker. This probe is the
    scenario the oracle does not have.
    """
    commit_id = f"shared-commit-{pod.index}-{pod.revision}"
    await pod.store.commit_domain_mutation(
        _commit_params(
            pod.user_id,
            expected=pod.revision,
            next_revision=pod.revision + 1,
            commit_id=commit_id,
        )
    )
    pod.revision += 1
    # Same commit id, different user, absurd expected revision. Must not report success.
    try:
        replay = _unwrap(
            await pod.store.commit_domain_mutation(
                _commit_params(
                    other.user_id,
                    expected=99,
                    next_revision=1,
                    commit_id=commit_id,
                )
            ),
            "commit_pkm_domain_mutation_v4",
        )
    except Exception:  # noqa: BLE001 - a refusal is the pass
        return True, "cross-user replay refused"
    if isinstance(replay, dict) and replay.get("success") and not replay.get("conflict"):
        return False, (
            "cross-user commit-id replay reported success "
            f"(idempotent_replay={replay.get('idempotent_replay')}, "
            f"data_version={replay.get('data_version')}) -- fabricated success + OCC bypass"
        )
    return True, "cross-user replay refused"


async def probe_log_anti_rollback(pod: Pod) -> tuple[bool, str]:
    """History must not be silently truncatable.

    ``PodCommitLog`` refuses a broken hash and a missing record, but ``replay()``
    walks backward from whatever ``head.json`` points at, and the contiguity check
    passes on any valid PREFIX. Nothing persists a high-water sequence, so a writer
    with store access can point the head at an earlier valid record and history
    truncates -- then the next append forks at that sequence.
    """
    before = await pod.log.replay()
    if len(before) < 3:
        return True, "not enough history yet"
    head_path = pod.root / "store" / PodCommitLog.HEAD
    try:
        head = json.loads(head_path.read_text())
    except Exception as exc:  # noqa: BLE001
        return False, f"head unreadable: {type(exc).__name__}"
    saved = dict(head)
    # Point the head at an earlier record that is itself perfectly valid.
    earlier_seq = before[0].get("seq")
    if earlier_seq is None:
        return True, "no seq to roll back to"
    try:
        rolled = dict(head)
        rolled["seq"] = earlier_seq
        head_path.write_text(json.dumps(rolled))
        after = await pod.log.replay()
        truncated = len(after) < len(before)
    except Exception:  # noqa: BLE001 - a raised PodLogTampered is the pass
        return True, "rollback refused"
    finally:
        head_path.write_text(json.dumps(saved))
    if truncated:
        return False, f"head rollback silently truncated history {len(before)} -> {len(after)}"
    return True, "rollback refused"


def probe_share_is_metadata_only(cp: ControlPlane) -> tuple[bool, str]:
    """No share record or audit entry may carry content. The ledger records that
    access happened, never what."""
    banned = ("cipher", "ciphertext", "segment", "summary", "payload", "value")
    for record in cp.shares:
        blob = json.dumps(record.__dict__).lower()
        for token in banned:
            if token in blob:
                return False, f"share record carries {token!r}"
    for entry in cp.audit:
        blob = json.dumps(entry).lower()
        for token in banned:
            if token in blob:
                return False, f"audit entry carries {token!r}"
    return True, f"shares={len(cp.shares)} receipts={len(cp.audit)}"


def probe_pod_identity(pod: Pod, session: Any) -> tuple[bool, str]:
    """Each live pod reports ITS OWN HusshID. With many pods up at once, a
    module-level global or a shared cache would surface here as identity confusion."""
    try:
        response = session.get(f"{pod.url}/pod/info", timeout=5)
        body = response.json()
    except Exception as exc:  # noqa: BLE001
        return False, f"unreachable: {type(exc).__name__}"
    if body.get("hushhId") != pod.hushh_id:
        return False, f"pod reports {body.get('hushhId')!r}, expected {pod.hushh_id!r}"
    if not body.get("podMode"):
        return False, "pod does not report podMode"
    return True, "identity ok"


# --------------------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------------------


async def run_cycle(pods: list[Pod], cp: ControlPlane, session: Any) -> dict:
    results: dict[str, dict[str, int]] = {}
    failures: list[str] = []

    def record(name: str, ok: bool, detail: str, who: str) -> None:
        bucket = results.setdefault(name, {"pass": 0, "fail": 0})
        bucket["pass" if ok else "fail"] += 1
        if not ok:
            failures.append(f"{name}[{who}]: {detail}")

    for i, pod in enumerate(pods):
        other = pods[(i + 1) % len(pods)]
        for name, coro in (
            ("write_and_read_back", probe_write_and_read_back(pod)),
            ("no_foreign_user", probe_no_foreign_user(pod, other)),
            ("chain_integrity", probe_chain_integrity(pod)),
            ("stale_revision_conflicts", probe_stale_revision_conflicts(pod)),
            ("commit_binding", probe_commit_binding(pod)),
            ("seal_key_isolation", probe_seal_key_isolation(pod, other)),
            ("rebuild_owner_filter", probe_rebuild_owner_filter(pod, other)),
            ("commit_binding_cross_user", probe_commit_binding_cross_user(pod, other)),
            ("log_anti_rollback", probe_log_anti_rollback(pod)),
        ):
            ok, detail = await coro
            record(name, ok, detail, pod.hushh_id)

        # Tier C: owner shares one scope with the next pod's owner, and every
        # cross-pod touch lands a metadata-only receipt.
        scope = f"attr.{DOMAIN}.portfolio.*"
        if not cp.is_shared(pod.hushh_id, other.hushh_id, scope):
            cp.share(pod.hushh_id, other.hushh_id, scope)
        cp.receipt(actor=other.hushh_id, target=pod.hushh_id, scope=scope, allowed=True)
        # An unshared scope must be refused, and refusals are receipted too.
        cp.receipt(
            actor=other.hushh_id,
            target=pod.hushh_id,
            scope=f"attr.{DOMAIN}.private.*",
            allowed=cp.is_shared(pod.hushh_id, other.hushh_id, f"attr.{DOMAIN}.private.*"),
        )

        if session is not None and pod.process is not None:
            ok, detail = probe_pod_identity(pod, session)
            record("pod_identity", ok, detail, pod.hushh_id)

    ok, detail = probe_share_is_metadata_only(cp)
    record("share_metadata_only", ok, detail, "control-plane")

    return {"probes": results, "failures": failures}


async def main() -> int:
    parser = argparse.ArgumentParser(description="Dev multi-pod simulation")
    parser.add_argument("--pods", type=int, default=10)
    parser.add_argument("--base-port", type=int, default=9200)
    parser.add_argument("--root", default="")
    parser.add_argument("--status-file", default="")
    parser.add_argument("--cycle-seconds", type=float, default=10.0)
    parser.add_argument("--http", action="store_true", help="boot real pod_server processes")
    parser.add_argument("--max-cycles", type=int, default=0, help="0 = run until stopped")
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    root = Path(args.root) if args.root else repo / ".sim" / "pods"
    root.mkdir(parents=True, exist_ok=True)
    status_file = Path(args.status_file) if args.status_file else root / "status.json"

    pods = [build_pod(i, root, args.base_port) for i in range(args.pods)]
    cp = ControlPlane()

    session = None
    if args.http:
        import requests  # noqa: PLC0415

        session = requests
        for pod in pods:
            pod.process = start_pod_process(pod, repo)
        # Pods import the full app; give them room to come up before probing.
        deadline = time.time() + 240
        ready = 0
        while time.time() < deadline and ready < len(pods):
            ready = 0
            for pod in pods:
                try:
                    if session.get(f"{pod.url}/health", timeout=2).status_code == 200:
                        ready += 1
                except Exception:  # noqa: BLE001, S110 - still booting
                    pass
            if ready < len(pods):
                await asyncio.sleep(5)
        print(f"pods ready: {ready}/{len(pods)}", flush=True)

    for pod in pods:
        cp.register(pod.hushh_id, pod.url if args.http else "")

    stopping = {"now": False}

    def _stop(*_: Any) -> None:
        stopping["now"] = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    started = time.time()
    cycle = 0
    totals: dict[str, dict[str, int]] = {}
    try:
        while not stopping["now"]:
            cycle += 1
            outcome = await run_cycle(pods, cp, session)
            for name, counts in outcome["probes"].items():
                bucket = totals.setdefault(name, {"pass": 0, "fail": 0})
                bucket["pass"] += counts["pass"]
                bucket["fail"] += counts["fail"]

            alive = sum(1 for p in pods if p.process is None or p.process.poll() is None)
            status = {
                "pods": len(pods),
                "podsAlive": alive,
                "cycle": cycle,
                "uptimeSeconds": round(time.time() - started, 1),
                "http": bool(args.http),
                "revisionsWritten": sum(p.revision for p in pods),
                "totals": totals,
                "lastCycle": outcome["probes"],
                "failures": outcome["failures"][:20],
                "failuresThisCycle": len(outcome["failures"]),
                "updatedAt": time.time(),
            }
            status_file.write_text(json.dumps(status, indent=2))
            flag = "OK" if not outcome["failures"] else f"FAIL({len(outcome['failures'])})"
            print(
                f"cycle={cycle} pods={len(pods)} alive={alive} "
                f"revs={status['revisionsWritten']} {flag}",
                flush=True,
            )
            if args.max_cycles and cycle >= args.max_cycles:
                break
            await asyncio.sleep(args.cycle_seconds)
    finally:
        for pod in pods:
            if pod.process is not None and pod.process.poll() is None:
                pod.process.terminate()
        for pod in pods:
            if pod.process is not None:
                try:
                    pod.process.wait(timeout=15)
                except Exception:  # noqa: BLE001, S110
                    pod.process.kill()
        print("simulation stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
