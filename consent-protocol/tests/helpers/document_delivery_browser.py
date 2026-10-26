"""Synthetic provider boundaries and process custody for the real browser loop."""

import asyncio
import base64
import hashlib
import json
import secrets
import socket
import subprocess
from contextlib import asynccontextmanager, closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import httpx
import uvicorn
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import Header, HTTPException
from sqlalchemy import text

from api.middleware import require_firebase_auth_read_only
from api.routes import document_delivery as delivery_routes
from api.routes.drive_sharing_owner import _content_owner, _owner
from hushh_mcp.services.document_delivery.contracts import key_fingerprint
from hushh_mcp.services.document_delivery.store import iso
from hushh_mcp.services.google_drive_adapter import DriveMetadata
from tests.services.test_drive_document_selection import pick


def source_pdf():
    """Small valid synthetic PDF. Exact original-byte integrity is the contract."""
    stream = b"BT /F1 20 Tf 30 100 Td (Synthetic statement) Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
    ]
    body = b"%PDF-1.4\n"
    positions = []
    for index, value in enumerate(objects, 1):
        positions.append(len(body))
        body += str(index).encode() + b" 0 obj\n" + value + b"\nendobj\n"
    xref = len(body)
    body += b"xref\n0 6\n0000000000 65535 f \n"
    body += b"".join(f"{position:010} 00000 n \n".encode() for position in positions)
    return body + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def reader_inventory(system):
    reader_policy = run_path(
        str(
            Path(__file__).resolve().parents[3]
            / "deploy/drive/resolve_protected_document_release.py"
        )
    )
    with closing(system.db.engine.raw_connection()) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_schema()")
            inventory_schema = cursor.fetchone()[0]
        assert reader_policy["inventory_empty"](connection, schema=inventory_schema) is True
    return reader_policy, inventory_schema


async def prepare_synthetic_source(system, sharing):
    original = source_pdf()
    # The compact SQL fixture initially selected a metadata-only placeholder.
    # A provider version is immutable; create this browser source's exact
    # selection before the first request instead of rewriting version 1.
    with system.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM connected_documents WHERE user_id='owner'"))
    await pick(
        sharing,
        [
            DriveMetadata(
                "private-pdf-source",
                "Private statement.pdf",
                "application/pdf",
                "1",
                "2026-10-20T00:00:00Z",
                len(original),
                hashlib.sha256(original).hexdigest(),
            )
        ],
    )

    return original


def install_identity_boundaries(app, monkeypatch):
    async def actor(authorization: str = Header(default="")):
        user = authorization.removeprefix("Bearer ")
        if user not in {"owner", "recipient", "stranger"}:
            raise HTTPException(401)

        async def require_current():
            return None

        return SimpleNamespace(user_id=user, require_current=require_current)

    async def firebase(authorization: str = Header()):
        return authorization.removeprefix("Bearer ")

    app.dependency_overrides[_owner] = actor
    app.dependency_overrides[_content_owner] = actor
    app.dependency_overrides[require_firebase_auth_read_only] = firebase

    async def connected_profile_target(owner, body):
        await owner.require_current()
        if str(body.ownerPersonRef) != "33333333-3333-4333-8333-333333333333":
            raise HTTPException(404)
        # Identity-directory transport only. The active relationship remains
        # independently checked under the production SQL graph lock.
        return "owner"

    monkeypatch.setattr(delivery_routes, "_owner_target", connected_profile_target)


def install_google_source_credential(system):
    class SourceOAuth:
        async def current_credential(self, **_kwargs):
            return {"connection_generation": 1}, {
                "accessToken": "synthetic-direct-google",
                "expiresAt": iso(datetime.now(UTC) + timedelta(minutes=30)),
            }

    system.service.oauth = SourceOAuth()


def install_intake_boundary(system, app, monkeypatch):
    @app.post("/__document_fixture/pause-intake")
    async def pause_synthetic_intake():
        from hushh_mcp.runtime_settings import clear_runtime_settings_caches

        monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "false")
        clear_runtime_settings_caches()
        return {"enabled": (await system.service.readiness(actor="recipient"))["enabled"]}


def install_key_recovery_boundary(system, app):
    @app.post("/__document_fixture/replace-key")
    async def replace_synthetic_recipient_key():
        replacement = X25519PrivateKey.generate()
        public = base64.b64encode(
            replacement.public_key().public_bytes(
                serialization.Encoding.Raw,
                serialization.PublicFormat.Raw,
            )
        ).decode()
        # External registry/PKM transport only; paid contract, proof and rewrap
        # are never changed by this fixture boundary.
        with system.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE one_kyc_client_connectors SET
              connector_key_id='key-recovered',connector_public_key=:public,
              public_key_fingerprint=:fingerprint WHERE user_id='recipient'"""),
                {"public": public, "fingerprint": hashlib.sha256(public.encode()).hexdigest()},
            )
        return {
            "connector_key_id": "key-recovered",
            "connector_public_key": public,
            "connector_private_key": base64.b64encode(
                replacement.private_bytes(
                    serialization.Encoding.DER,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            ).decode(),
            "connector_private_key_format": "pkcs8",
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "public_key_fingerprint": key_fingerprint(public),
            "created_at": iso(datetime.now(UTC)),
        }


def install_stripe_boundary(system, app):
    @app.post("/__document_fixture/settle/{request_id}")
    async def settle(request_id: str):
        # Stripe's external provider is deterministic. Its HTTP callback, exact
        # signature verification and financial settlement use production code.
        from tests.services.test_drive_request_payment import _signed_event

        with system.db.engine.connect() as connection:
            order = (
                connection.execute(
                    text("SELECT * FROM drive_request_payment_orders WHERE request_id=:id"),
                    {"id": request_id},
                )
                .mappings()
                .one()
            )
        payload, signature = _signed_event(
            request_id,
            amount=order["amount_cents"],
            session_id=order["stripe_checkout_session_id"],
            attempt_id=str(order["checkout_attempt_id"]),
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://one.invalid"
        ) as client:
            rejected = await client.post(
                "/api/payments/stripe/webhook",
                content=payload,
                headers={"Stripe-Signature": "invalid"},
            )
            assert rejected.status_code == 400
            response = await client.post(
                "/api/payments/stripe/webhook",
                content=payload,
                headers={"Stripe-Signature": signature},
            )
            assert response.status_code == 200
            # Provider retry is idempotent: a single paid order remains.
            repeated = await client.post(
                "/api/payments/stripe/webhook",
                content=payload,
                headers={"Stripe-Signature": signature},
            )
            assert repeated.status_code == 200
        return {"settled": True}


def browser_configuration(system, original, browser_engine):
    private_pkcs8 = system.private.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    config = {
        "engine": browser_engine,
        "client": {
            "connector": {
                "connector_key_id": "key-test",
                "connector_public_key": system.public,
                "connector_private_key": base64.b64encode(private_pkcs8).decode(),
                "connector_private_key_format": "pkcs8",
                "connector_wrapping_alg": "X25519-AES256-GCM",
                "public_key_fingerprint": key_fingerprint(system.public),
                "created_at": iso(datetime.now(UTC)),
            },
            "ownerVaultKey": secrets.token_hex(32),
            "recipientVaultKey": secrets.token_hex(32),
        },
        "source": {"pdf": base64.b64encode(original).decode()},
    }
    return config


async def run_browser_process(config, *, script="hosted-document-flow.mjs"):
    web_root = Path(__file__).resolve().parents[3] / "hushh-webapp"
    command_group = run_path(str(web_root.parent / "scripts/ci/process_group.py"))["command_group"]
    with (
        TemporaryDirectory(prefix="one-document-vite-") as cache_dir,
        command_group(
            ["node", f"scripts/testing/{script}"],
            cwd=web_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as (process, stop),
    ):
        try:
            stdout, stderr = await asyncio.to_thread(
                process.communicate,
                json.dumps({**config, "viteCacheDir": cache_dir}).encode(),
                timeout=100,
            )
        finally:
            if process.poll() is None:
                stop()
                try:
                    await asyncio.to_thread(process.wait, timeout=5)
                except subprocess.TimeoutExpired:
                    stop(force=True)
                    await asyncio.to_thread(process.wait, timeout=5)
        # No generated keys, token, source bytes or unwraps enter diagnostics.
        if process.returncode:
            raise AssertionError("Browser loop failed: " + stderr.decode()[-5000:])
    result = json.loads(stdout.decode().splitlines()[-1])
    return result


def assert_browser_trace(result, browser_engine):
    assert result["feature"] == "protected_document_delivery"
    assert result["engine"] == browser_engine
    assert [event["name"] for event in result["trace_loop"]] == [
        "request_committed",
        "encrypted_package_staged",
        "signed_payment_settled",
        "local_preview_rendered",
        "both_downloads_verified",
        "paid_key_recovery_verified",
        "revoke_committed",
    ]
    assert result["elapsedMs"] < 45_000


def assert_financial_receipts(system):
    with system.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT COUNT(*) FROM drive_request_payment_orders")).scalar()
            == 1
        )
        assert (
            connection.execute(text("SELECT status FROM drive_request_payment_orders")).scalar()
            == "paid"
        )
        assert (
            connection.execute(
                text(
                    "SELECT COUNT(*) FROM document_delivery_file_receipts WHERE hosted_released_at IS NOT NULL"
                )
            ).scalar()
            == 1
        )
        kinds = set(
            connection.execute(text("SELECT kind FROM document_delivery_activity")).scalars()
        )
        assert {"preview_rendered", "download_requested", "handoff_reported"} <= kinds
        assert (
            connection.execute(
                text("SELECT COUNT(*) FROM drive_share_permission_operations")
            ).scalar()
            == 0
        )
        assert (
            connection.execute(text("SELECT COUNT(*) FROM document_delivery_packages")).scalar()
            == 2
        )
        assert (
            connection.execute(
                text("""SELECT COUNT(*) FROM document_delivery_financial_bindings f
          JOIN document_delivery_packages p ON p.request_id=f.request_id AND p.amendment_of IS NULL
          WHERE f.original_terms_digest=p.terms_digest AND f.original_package_digest=p.package_digest
            AND f.content_commitment=p.content_commitment""")
            ).scalar()
            == 1
        )


async def assert_ended_access(system, app, result, original):
    assert system.service.objects.objects
    assert all(original not in value[0] for value in system.service.objects.objects.values())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://one.invalid"
    ) as client:
        request_id = result["requestId"]
        ended = await client.get(
            f"/api/connectors/google_drive/sharing/requests/{request_id}/delivery/package",
            headers={"Authorization": "Bearer recipient"},
        )
        assert ended.status_code == 409
        assert ended.json()["detail"]["code"] == "delivery_authority_ended"
        assert "wraps" not in ended.json()


@asynccontextmanager
async def browser_backend(app):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if server_task.done():
                    await server_task
                await asyncio.sleep(0.01)
        yield origin
    finally:
        server.should_exit = True
        async with asyncio.timeout(5):
            await server_task
        listener.close()
