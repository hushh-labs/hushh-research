"""Owner-direct acceptance: the private agent answers its owner with the hub out of the path.

The ledger item ``owner-direct-inference-without-hub`` is a RECEIPT item: it passes
only on a fresh, deployed measurement. This script is its producer, and it has two
modes that are deliberately unequal:

``--dry-run``
    Runs the whole sequence against in-memory fakes: enrol an app key, have the
    hub sign a binding, pin the endpoint, admit at the pod with a real proof of
    possession, run a plain chat on the local session with hub egress blocked and
    the Puppy device linked to the pod's own broker, revoke the device at the pod
    and see the next turn refused, overlap two incarnations and see the old one
    publish nothing, and hit ``/pod/info`` through the wall with no identity. It
    proves the SEQUENCE and the assertions, with every seam being the real code
    and every dependency being a fake. It writes a receipt whose target mode is
    ``local`` so the judge can never mistake it for the deployed measurement.

``--live``
    Refuses unless every explicit flag is present (``--i-understand-dev-only``,
    ``--allow-public-pod``, ``--pod-url``, ``--environment dev``), and even then
    stops and says what it would do: the live leg needs a disposable revision of
    the owner pod with ``HUSSH_HUB_BASE_URL`` empty, the app enrolled and bound,
    and Puppy One dialling the pod, none of which this lane provisions. Wiring the
    live leg is a follow-up; a script that pretended otherwise would be the
    declared status the ledger exists to abolish.

Receipts carry shape only: counts, booleans, commit and source hashes. No token,
key, prompt or private record is ever written.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

ASSERTION_ID = "owner-direct-inference-without-hub"
REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE_PATHS = (
    "consent-protocol/scripts/ops/owner_direct_acceptance.py",
    "consent-protocol/api/routes/one/pod_session.py",
    "consent-protocol/api/routes/one/pod_turn.py",
    "consent-protocol/api/routes/one/pod_puppy_relay.py",
    "consent-protocol/api/middlewares/pod_ingress.py",
    "consent-protocol/hushh_mcp/services/pod_session_authority.py",
    "consent-protocol/hushh_mcp/services/pod_authority_store.py",
    "consent-protocol/hushh_mcp/services/puppy_broker.py",
    "consent-protocol/hushh_mcp/consent/puppy_envelope.py",
    "consent-protocol/hushh_mcp/runtime_providers/puppy_local_transport.py",
    "consent-protocol/hushh_mcp/services/pod_binding_service.py",
    "consent-protocol/hushh_mcp/services/gcp_backend.py",
    "consent-protocol/pod_server.py",
)

OWNER = "ha1_acceptance_owner"
USER = "uid-acceptance"


class AcceptanceFailure(RuntimeError):
    """One named step did not hold."""


# -- fakes: every dependency, none of the code under test ----------------------------


class _P256:
    def __init__(self) -> None:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        self._key = ec.generate_private_key(ec.SECP256R1())
        self._ec, self._hashes = ec, hashes
        self.public_b64 = base64.b64encode(
            self._key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ).decode()

    def sign(self, payload: str) -> str:
        return base64.b64encode(
            self._key.sign(payload.encode(), self._ec.ECDSA(self._hashes.SHA256()))
        ).decode()


class _Registry:
    def __init__(self, row: dict) -> None:
        self.row = row

    async def get(self, user_id: str):
        return self.row if self.row["user_id"] == user_id else None

    async def record_binding(self, *, user_id, device_id, record):
        self.row.setdefault("backend_metadata", {}).setdefault("bindings", {})[device_id] = record

    async def record_endpoint(self, *, user_id, endpoint):
        self.row.setdefault("backend_metadata", {})["endpoint"] = endpoint

    async def append_pending_tombstone(self, *, user_id, entry):
        self.row.setdefault("backend_metadata", {}).setdefault("pendingTombstones", []).append(
            entry
        )


class _Devices:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def active_device(self, *, user_id, device_id):
        return dict(self.rows[device_id]) if device_id in self.rows else None

    def audit_event(self, **_kwargs):
        return None


class _Audit:
    async def authorize_owner_read(self, **_kwargs):
        return {"authorized": True}


class _HubEgressBlocked:
    """Stands in for the hub client on the measured turn; any call is a failure."""

    def __init__(self) -> None:
        self.calls = 0

    def __getattr__(self, name: str):
        def _refuse(*_a, **_k):
            self.calls += 1
            raise AcceptanceFailure(f"hub egress attempted during the measured turn: {name}")

        return _refuse


class _Socket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed: list[tuple[int, str]] = []

    async def send(self, frame: dict) -> None:
        self.sent.append(frame)

    async def close(self, code: int, reason: str) -> None:
        self.closed.append((code, reason))


def _hub_signing_key(env: dict[str, str]) -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    env["CONSENT_ED25519_PRIVATE_KEY"] = base64.b64encode(seed).decode()
    env["CONSENT_ED25519_KID"] = "acceptance-dry-run"
    env["CONSENT_ED25519_PUBLIC_KEYS"] = json.dumps(
        {"acceptance-dry-run": base64.b64encode(public).decode()}
    )


# -- the sequence ----------------------------------------------------------------------


async def run_dry_run(tmp_root: Path) -> dict[str, Any]:
    """The whole owner-direct sequence over fakes. Returns the observations."""
    saved_env = dict(os.environ)
    os.environ.update(
        {
            "HUSSH_POD_MODE": "1",
            "HUSSH_POD_TURN_ENABLED": "true",
            "HUSSH_ID": OWNER,
            "HUSHH_DEPLOY_ENV": "dev",
            "HUSSH_HUB_BASE_URL": "",
            "APP_SIGNING_KEY": "acceptance-dry-run-signing-key-32-chars-minimum",
            # Keep imports of the hosted ADK graph deterministic in a clean subprocess. The
            # dry-run never calls Vertex; these values only satisfy its import-time contract.
            "GOOGLE_GENAI_USE_VERTEXAI": "true",
            "GOOGLE_CLOUD_PROJECT": "acceptance-dry-run-project",
            "GOOGLE_CLOUD_LOCATION": "global",
        }
    )
    token_signing = None
    store_module = None
    pod_config = None
    psa = None
    pb = None
    observations: dict[str, Any] = {}
    commands: list[str] = []
    try:
        # Import runtime modules only after the synthetic environment is installed. Several
        # services validate their settings at import time; importing them first makes a clean
        # subprocess fail before this dry-run can produce its deliberately local receipt.
        from hushh_mcp.consent import token_signing as _token_signing
        from hushh_mcp.services import pod_authority_store as _store_module
        from hushh_mcp.services import pod_config as _pod_config
        from hushh_mcp.services import pod_session_authority as _psa
        from hushh_mcp.services import puppy_broker as _pb
        from hushh_mcp.services.pod_binding_service import PodBindingService
        from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

        token_signing = _token_signing
        store_module = _store_module
        pod_config = _pod_config
        psa = _psa
        pb = _pb
        _hub_signing_key(os.environ)
        token_signing.reset_caches()

        # 1. Enrol the app key and the Puppy device at the hub (fakes hold the rows).
        app_key, device_key = _P256(), _P256()
        devices = _Devices()
        devices.rows["tdv_app_acceptance"] = {
            "platform": "web",
            "device_public_key": app_key.public_b64,
        }
        devices.rows["tdv_mac_acceptance"] = {
            "platform": "macos",
            "device_public_key": device_key.public_b64,
        }
        pod_key_id = "podk_acceptance"
        pod_public_key = base64.b64encode(b"A" * 32).decode()
        registry = _Registry(
            {
                "user_id": USER,
                "hushh_id": OWNER,
                "status": "provisioned",
                "pod_key_id": pod_key_id,
                "pod_pubkey": pod_public_key,
                "backend_metadata": {"url": "https://one-pod-acceptance.a.run.app"},
            }
        )
        hub = PodBindingService(registry=registry, devices=devices, audit=_Audit())
        commands.append("hub.issue(app binding)")
        app_binding = await hub.issue(user_id=USER, device_id="tdv_app_acceptance")
        commands.append("hub.issue(device binding, puppy_inference=True)")
        device_binding = await hub.issue(
            user_id=USER, device_id="tdv_mac_acceptance", puppy_inference=True
        )

        # 2. Pin the endpoint; the version must not move on a second read.
        first = await hub.endpoint(user_id=USER)
        second = await hub.endpoint(user_id=USER)
        observations["endpoint_version_monotonic"] = (
            first["endpointVersion"] == second["endpointVersion"] == 1
        )

        # 3. The pod: authority over a real log, a claimed incarnation, both subjects admitted.
        object_store = LocalObjectStore(str(tmp_root / "pod"))
        log = PodCommitLog(object_store, b"A" * 32, owner_id=OWNER)
        incarnation = await store_module.claim_incarnation(
            object_store, b"A" * 32, instance_id="rev-a"
        )
        store = store_module.PodAuthorityStore(log, hushh_id=OWNER)
        await store.load()
        authority = psa.PodSessionAuthority(
            store=store,
            lease=store_module.IncarnationLease(object_store, incarnation),
            dek=b"A" * 32,
            pod_key_id=pod_key_id,
            pod_public_key=pod_public_key,
            environment="dev",
        )
        store_module.set_active_authority_store(store)
        psa.set_active_session_authority(authority)
        pod_config.set_active_pod_config(None)

        async def admit(binding: dict, signer: _P256):
            challenge = authority.create_challenge(binding["binding"]["subject_id"])
            return await authority.admit(
                binding=binding["binding"],
                signature=binding["signature"],
                challenge_id=challenge["challenge_id"],
                nonce=challenge["nonce"],
                proof=signer.sign(challenge["signing_payload"]),
                epoch=authority.epoch,
            )

        commands.append("pod.admit(app)")
        _app_token, app_claims = await admit(app_binding, app_key)
        commands.append("pod.admit(device)")
        _device_token, _device_claims = await admit(device_binding, device_key)

        # 4. The device dials the pod's own broker (the relay route is the sealed
        #    socket; here the link is registered directly, which is the same seam).
        socket = _Socket()
        key = (OWNER, "tdv_mac_acceptance")
        await pb.BROKER.register(
            key, send=socket.send, close=socket.close, epoch=authority.epoch, model="local-dry-run"
        )

        # 5. The measured turn: local session, hub egress blocked, Puppy answers.
        from api.routes.one import pod_turn

        blocked = _HubEgressBlocked()
        from hushh_mcp.services import pod_consent_client, pod_hub_client

        original_verify = pod_consent_client.verify_consent
        original_client = pod_hub_client.PodHubClient
        pod_consent_client.verify_consent = blocked.verify_consent  # type: ignore[assignment]
        pod_hub_client.PodHubClient = lambda *a, **k: blocked  # type: ignore[assignment]
        seen: dict[str, Any] = {}

        async def puppy_runner(**kwargs):
            seen.update(kwargs)

            class _Event:
                kind = "token"
                text = "answered by the owner's device"

            yield _Event()

        try:
            payload = pod_turn.PodTurnRequest(
                message="plain chat", runtime_provider="puppy", puppy_device_id="tdv_mac_acceptance"
            )
            commands.append("pod.run_pod_turn(local session, provider=puppy)")
            result = await pod_turn.run_pod_turn(
                payload=payload,
                consent_token=authority.local_token(app_claims),
                verifier=authority.local_verifier(app_claims),
                session=app_claims,
                stream_fn=puppy_runner,
            )
        finally:
            pod_consent_client.verify_consent = original_verify  # type: ignore[assignment]
            pod_hub_client.PodHubClient = original_client  # type: ignore[assignment]
        observations["hub_calls"] = blocked.calls
        observations["provider_puppy"] = result.get("provider") == "puppy"
        observations["runtime_mode_puppy_relay"] = result.get("runtimeMode") == "puppy_relay"
        observations["turn_answered"] = bool(result.get("text"))
        observations["credential_is_session_marker"] = str(
            seen.get("runtime_credential") or ""
        ).startswith("pod-session:")

        # 6. Revoke the device at the pod; the next Puppy turn is refused before the runner.
        commands.append("pod.revoke_subject(device)")
        await authority.revoke_subject("tdv_mac_acceptance", reason="acceptance")
        closed = await pb.BROKER.close_subject("tdv_mac_acceptance")
        refused = False
        try:
            await pod_turn.run_pod_turn(
                payload=payload,
                consent_token=authority.local_token(app_claims),
                verifier=authority.local_verifier(app_claims),
                session=app_claims,
                stream_fn=puppy_runner,
            )
        except Exception as exc:  # noqa: BLE001 - the refusal is the observation
            refused = getattr(exc, "status_code", None) == 409
        observations["revoked_device_refused"] = refused and closed == 1

        # 7. Two-revision overlap: the newer claim fences the old; the old publishes nothing.
        commands.append("claim_incarnation(rev-b) while rev-a holds links")
        await store_module.claim_incarnation(object_store, b"A" * 32, instance_id="rev-b")
        assert await authority.lease.is_current(force=True) is False
        socket_b = _Socket()
        await pb.BROKER.register(
            ("ha1_acceptance_owner", "tdv_other"), send=socket_b.send, close=socket_b.close, epoch=1
        )
        publications = 0
        try:
            async for _frame in pb.BROKER.dispatch(
                ("ha1_acceptance_owner", "tdv_other"),
                {"type": "inference.request", "requestId": "r-old", "deviceId": "tdv_other"},
                incarnation=authority.lease,
            ):
                publications += 1
        except pb.PuppyBrokerFenced:
            pass
        observations["old_incarnation_publications"] = publications + len(socket_b.sent)
        admitted_after_fence = True
        try:
            await admit(app_binding, app_key)
        except psa.PodSessionRefused as exc:
            admitted_after_fence = exc.code != "fenced"
        observations["fenced_incarnation_admits_nobody"] = not admitted_after_fence

        # 8. The wall: /pod/info with no identity is 404 through the real policy.
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from api.middlewares.pod_ingress import PodIngressPolicy

        app = FastAPI()

        @app.get("/pod/info")
        def _info():
            return {"role": "sovereign-pod"}

        @app.get("/health")
        def _health():
            return {"ok": True}

        app.add_middleware(PodIngressPolicy)
        os.environ.pop("HUSSH_POD_HUB_CALLER_EMAILS", None)
        client = TestClient(app, raise_server_exceptions=False)
        commands.append("GET /pod/info without identity through PodIngressPolicy")
        observations["wall_refused_pod_info_without_identity"] = (
            client.get("/pod/info").status_code == 404 and client.get("/health").status_code == 200
        )
        return {"observations": observations, "commands": commands}
    finally:
        if pb is not None:
            pb.BROKER._links.clear()
        if psa is not None:
            psa.set_active_session_authority(None)
        if store_module is not None:
            store_module.set_active_authority_store(None)
        if pod_config is not None:
            pod_config.set_active_pod_config(None)
        os.environ.clear()
        os.environ.update(saved_env)
        if token_signing is not None:
            token_signing.reset_caches()


# -- receipts ----------------------------------------------------------------------------


def _source_commit() -> str:
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10
        )
        return out.stdout.strip() if out.returncode == 0 else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def _source_hashes() -> dict[str, str]:
    hashes: dict[str, str] = {}
    for relative in SOURCE_PATHS:
        path = REPO_ROOT / relative
        if path.exists():
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def build_receipt(run: dict[str, Any], *, mode: str, environment: str) -> dict[str, Any]:
    observations = run["observations"]
    passed = (
        observations.get("hub_calls") == 0
        and observations.get("provider_puppy") is True
        and observations.get("runtime_mode_puppy_relay") is True
        and observations.get("revoked_device_refused") is True
        and observations.get("old_incarnation_publications") == 0
        and observations.get("wall_refused_pod_info_without_identity") is True
    )
    return {
        "version": 1,
        "assertion_id": ASSERTION_ID,
        "result": "pass" if passed else "fail",
        "exit_code": 0 if passed else 1,
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "target": {"mode": mode, "environment": environment},
        "source_commit": _source_commit(),
        "source_sha256": _source_hashes(),
        "observations": observations,
        "commands": run["commands"],
        "limits": [
            "dry-run: every dependency is an in-memory fake; only the sequence and the "
            "assertions are exercised",
            "no deployed pod, no real device socket, no Cloud Run IAM was touched",
            "target.mode=local can never satisfy a deployed receipt requirement",
        ]
        if mode == "local"
        else [],
    }


def refuse_live(args: argparse.Namespace) -> int:
    missing = [
        flag
        for flag, present in (
            ("--i-understand-dev-only", args.i_understand_dev_only),
            ("--allow-public-pod", args.allow_public_pod),
            ("--pod-url", bool(args.pod_url)),
            ("--environment dev", args.environment == "dev"),
        )
        if not present
    ]
    if missing:
        print(f"refusing live acceptance: missing {', '.join(missing)}", file=sys.stderr)
        return 2
    print(
        "live acceptance is not wired in this lane. It needs: a disposable revision of the "
        "owner pod with HUSSH_HUB_BASE_URL empty, the app enrolled and bound "
        "(POST /trusted-devices/self-enroll, POST .../pod-binding), Puppy One dialling "
        f"{args.pod_url}/api/one/puppy/relay with its device session, then the measured "
        "turn, the revoke, the two-revision overlap on disposable resources and the wall "
        "check. Until that follow-up lands, only --dry-run produces a receipt, and its "
        "target.mode is local.",
        file=sys.stderr,
    )
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="run against in-memory fakes")
    parser.add_argument("--live", action="store_true", help="run against a deployed owner pod")
    parser.add_argument("--i-understand-dev-only", action="store_true")
    parser.add_argument("--allow-public-pod", action="store_true")
    parser.add_argument("--pod-url", default="")
    parser.add_argument("--environment", default="")
    parser.add_argument("--out", default="", help="where to write the receipt JSON")
    args = parser.parse_args(argv)
    if args.live:
        return refuse_live(args)
    if not args.dry_run:
        parser.print_usage(file=sys.stderr)
        print(
            "choose --dry-run (fakes) or --live (refuses without explicit flags)", file=sys.stderr
        )
        return 2
    import tempfile

    with tempfile.TemporaryDirectory(prefix="owner-direct-acceptance-") as tmp:
        started = time.perf_counter()
        run = asyncio.run(run_dry_run(Path(tmp)))
    receipt = build_receipt(run, mode="local", environment="dry-run")
    receipt["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    text = json.dumps(receipt, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    print(text)
    return int(receipt["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
