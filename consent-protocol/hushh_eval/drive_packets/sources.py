"""Read-only sources: synthetic fixtures for CI, and one owner's UAT data for operators.

UAT access is read-only by construction:
- one SQLAlchemy connection (pool_size=1, max_overflow=0) through the local Cloud
  SQL proxy with ``default_transaction_read_only=on`` and ``statement_timeout``,
  and an assertion that ``transaction_read_only`` is on before any query;
- Drive through ``DriveReadOnly``, which refuses every method except GET before
  any network I/O;
- secrets are read with ``gcloud secrets versions access`` into process memory.
No Cloud Run job, workflow dispatch or write of any kind exists in this module.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import subprocess
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from hushh_eval.drive_packets.privacy import keyed

PROJECT = "hushh-pda-uat"
REGION = "us-central1"
BACKEND_SERVICE = "consent-protocol"
WORKER_SERVICE = "consent-protocol-drive-worker"
DRIVE_API = "https://www.googleapis.com/drive/v3/"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - public endpoint, not a secret
READ_ONLY_OPTIONS = "-c default_transaction_read_only=on -c statement_timeout=20000"
LIVE_ENV = "DRIVE_PACKET_EVAL_LIVE"
BACKEND_SECRETS = (
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
    "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
    "EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
)
WORKER_SECRETS = ("DRIVE_DOCUMENT_KEY_V1",)
PROCESS_KEYS = ("DRIVE_DOCUMENT_KEY_V1", "EXTERNAL_CONNECTOR_CREDENTIAL_KEY")


class ReadOnlyViolation(RuntimeError):
    """A write, a non-GET request or a writable session was about to happen."""


class LiveOptInRequired(RuntimeError):
    """Live sources need DRIVE_PACKET_EVAL_LIVE=1."""


def require_live_opt_in() -> None:
    if os.environ.get(LIVE_ENV) != "1":
        raise LiveOptInRequired(f"set {LIVE_ENV}=1 for a live, read-only source")


# --- Database -------------------------------------------------------------------
def read_only_engine(*, user: str, password: str, database: str, host: str, port: int):
    from sqlalchemy import URL, create_engine, event

    if host not in {"127.0.0.1", "localhost"}:
        raise ReadOnlyViolation("database_must_use_local_proxy")
    engine = create_engine(
        URL.create(
            "postgresql+psycopg2",
            username=user,
            password=password,
            host=host,
            port=port,
            database=database,
        ),
        pool_size=1,
        max_overflow=0,
        pool_timeout=60,
        connect_args={
            "options": READ_ONLY_OPTIONS,
            "application_name": "dpe-readonly-eval",
            "connect_timeout": 10,
        },
    )

    @event.listens_for(engine, "connect")
    def _check(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("SELECT current_setting('transaction_read_only')")
            if cursor.fetchone()[0] != "on":
                raise ReadOnlyViolation("transaction_read_only_off")
        finally:
            cursor.close()

    return engine


def assert_read_only(connection) -> None:
    from sqlalchemy import text

    value = connection.execute(text("SELECT current_setting('transaction_read_only')")).scalar_one()
    if value != "on":
        raise ReadOnlyViolation("transaction_read_only_off")


# --- Drive ----------------------------------------------------------------------
class DriveReadOnly:
    """GET-only Drive client. Any other method raises before network I/O."""

    def __init__(self, token: Callable[[], str], *, client=None, concurrency: int = 4):
        import asyncio

        import httpx

        if not 1 <= concurrency <= 4:
            raise ValueError("drive_concurrency_must_be_1_to_4")
        self._token = token
        self._client = client or httpx.AsyncClient(timeout=60, follow_redirects=False)
        self._semaphore = asyncio.Semaphore(concurrency)
        self.requests = 0

    async def request(self, method: str, path: str, *, params: dict | None = None):
        if method.upper() != "GET":
            raise ReadOnlyViolation(f"drive_method_refused:{method.upper()}")
        url = path if path.startswith("https://") else DRIVE_API + path.lstrip("/")
        if not url.startswith(DRIVE_API):
            raise ReadOnlyViolation("drive_url_refused")
        async with self._semaphore:
            self.requests += 1
            response = await self._client.request(
                "GET", url, params=params, headers={"Authorization": f"Bearer {self._token()}"}
            )
        if response.status_code != 200:
            raise RuntimeError(f"drive_http_{response.status_code}")
        return response

    # Mutating operations exist only to refuse them loudly in tests and reviews.
    async def update(self, *_args, **_kwargs):
        await self.request("PATCH", "files")

    async def delete(self, *_args, **_kwargs):
        await self.request("DELETE", "files")

    async def create_permission(self, *_args, **_kwargs):
        await self.request("POST", "files/permissions")

    async def list_all(self, *, query: str, fields: str, page_limit: int = 500) -> list[dict]:
        files, token, pages = [], None, 0
        while pages < page_limit:
            params = {
                "q": query,
                "fields": f"nextPageToken,incompleteSearch,files({fields})",
                "pageSize": "1000",
                "corpora": "user",
                "spaces": "drive",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if token:
                params["pageToken"] = token
            data = (await self.request("GET", "files", params=params)).json()
            pages += 1
            files.extend(data.get("files", []))
            token = data.get("nextPageToken")
            if not token:
                return files
        raise RuntimeError("drive_listing_page_limit")

    async def original(self, file_id: str, mime_type: str, *, max_bytes: int) -> tuple[str, bytes]:
        from hushh_mcp.services.google_drive_adapter import LIVE_EXPORTS

        export = LIVE_EXPORTS.get(mime_type)
        if export:
            response = await self.request(
                "GET", f"files/{file_id}/export", params={"mimeType": export}
            )
            mime = export
        else:
            response = await self.request(
                "GET", f"files/{file_id}", params={"alt": "media", "supportsAllDrives": "true"}
            )
            mime = mime_type
        if len(response.content) > max_bytes:
            raise RuntimeError("original_too_large")
        return mime, response.content

    async def aclose(self):
        await self._client.aclose()


# --- Secrets ----------------------------------------------------------------------
def _gcloud(*args: str) -> str:
    result = subprocess.run(  # noqa: S603 - fixed gcloud read commands, no shell
        ["gcloud", *args], capture_output=True, text=True, timeout=60, check=False
    )
    if result.returncode:
        raise RuntimeError("gcloud_read_failed")
    return result.stdout


def describe_service(name: str, command: Callable[..., str] = _gcloud) -> dict:
    return json.loads(
        command(
            "run",
            "services",
            "describe",
            name,
            "--project",
            PROJECT,
            "--region",
            REGION,
            "--format=json",
        )
    )


def resolve_env(service: dict, names, command: Callable[..., str] = _gcloud) -> dict[str, str]:
    values = {}
    for item in service["spec"]["template"]["spec"]["containers"][0].get("env", []):
        if item["name"] not in names:
            continue
        if "value" in item:
            values[item["name"]] = item["value"]
            continue
        reference = item["valueFrom"]["secretKeyRef"]
        values[item["name"]] = command(
            "secrets",
            "versions",
            "access",
            reference.get("key", "latest"),
            "--secret",
            reference["name"],
            "--project",
            PROJECT,
        ).strip()
    return values


def service_provenance(service: dict) -> dict:
    labels = service["spec"]["template"]["metadata"].get("labels", {})
    return {
        "revision": service["status"]["latestReadyRevisionName"],
        "deploy_sha": labels.get("deploy-sha"),
    }


# --- UAT ------------------------------------------------------------------------
class UatReadOnlySource:
    """One owner's live Drive collection in UAT, read-only (operator runs only)."""

    def __init__(self, *, owner_user_id: str, db_port: int, command: Callable[..., str] = _gcloud):
        require_live_opt_in()
        self.owner = owner_user_id
        backend = describe_service(BACKEND_SERVICE, command)
        worker = describe_service(WORKER_SERVICE, command)
        self.provenance = {
            "backend": service_provenance(backend),
            "worker": service_provenance(worker),
        }
        secrets_ = resolve_env(backend, BACKEND_SECRETS, command) | resolve_env(
            worker, WORKER_SECRETS, command
        )
        missing = set(BACKEND_SECRETS + WORKER_SECRETS) - set(secrets_) - {"DB_NAME"}
        if missing:
            raise RuntimeError("uat_secret_missing")
        self._secrets = secrets_
        for name in PROCESS_KEYS:
            os.environ[name] = secrets_[name]
        self.engine = read_only_engine(
            user=secrets_["DB_USER"],
            password=secrets_["DB_PASSWORD"],
            database=secrets_.get("DB_NAME", "postgres"),
            host="127.0.0.1",
            port=db_port,
        )
        self._credential: dict | None = None

    # Database snapshot ----------------------------------------------------------------
    def connection_row(self, db) -> dict:
        from sqlalchemy import text

        row = (
            db.execute(
                text(
                    "SELECT * FROM user_external_connector_connections "
                    "WHERE user_id=:owner AND connector_id='google_drive'"
                ),
                {"owner": self.owner},
            )
            .mappings()
            .one_or_none()
        )
        if not row or row["status"] != "connected" or row["validation_state"] != "verified":
            raise RuntimeError("owner_connection_not_verified")
        return dict(row)

    def snapshot(self, *, policy: str, profile: str, chunk: int = 4000) -> dict:
        from sqlalchemy import text

        from hushh_mcp.services.drive_document_store import DriveDocumentCipher

        cipher = DriveDocumentCipher()
        documents: list[dict] = []
        with self.engine.connect() as db:
            assert_read_only(db)
            connection = self.connection_row(db)
            generation = connection["connection_generation"]
            after = "00000000-0000-0000-0000-000000000000"
            while True:
                rows = list(
                    db.execute(
                        text(
                            """
                    SELECT d.document_id,d.user_id,d.connection_generation,d.metadata_envelope,
                           d.source_version,d.status,d.active_version,d.last_error_code,
                           e.extraction_profile,e.complete AS extraction_complete,
                           e.has_gaps AS extraction_has_gaps,e.total_pages,e.unit_kind,
                           f.status AS facts_status,f.has_gaps AS facts_has_gaps
                    FROM connected_documents d
                    LEFT JOIN drive_document_extractions e
                      ON e.document_id=d.document_id AND e.extraction_version=d.active_version
                    LEFT JOIN drive_document_facts f
                      ON f.document_id=d.document_id AND f.user_id=d.user_id
                     AND f.source_version=d.source_version AND f.extraction_version=d.active_version
                     AND f.extraction_profile=:profile AND f.facts_profile=:policy
                    WHERE d.user_id=:owner AND d.connection_generation=:generation
                      AND d.source_profile='live' AND d.document_id>CAST(:after AS uuid)
                    ORDER BY d.document_id LIMIT :limit"""
                        ),
                        {
                            "owner": self.owner,
                            "generation": generation,
                            "profile": profile,
                            "policy": policy,
                            "after": after,
                            "limit": chunk,
                        },
                    ).mappings()
                )
                for row in rows:
                    metadata = cipher.open(dict(row))
                    indexed = bool(
                        row["status"] == "ready"
                        and row["active_version"] is not None
                        and row["facts_status"] == "complete"
                        and not row["facts_has_gaps"]
                    )
                    failed = bool(
                        row["status"] in {"unsupported", "needs_reauth", "failed_retryable"}
                        or row["facts_status"] == "failed"
                        or (row["facts_status"] == "complete" and row["facts_has_gaps"])
                    )
                    documents.append(
                        {
                            "document_id": str(row["document_id"]),
                            "generation": generation,
                            "file_id": metadata["file_id"],
                            "mime_type": metadata.get("mime_type"),
                            "size": metadata.get("size"),
                            "modified_time": metadata.get("modified_time"),
                            "created_time": metadata.get("created_time"),
                            "source_version": row["source_version"],
                            "status": row["status"],
                            "last_error_code": row["last_error_code"],
                            "active_version": row["active_version"],
                            "extraction_current": row["extraction_profile"] == profile
                            and bool(row["extraction_complete"]),
                            "extraction_has_gaps": row["extraction_has_gaps"],
                            "total_pages": row["total_pages"],
                            "unit_kind": row["unit_kind"],
                            "indexed": indexed,
                            "failed": failed and not indexed,
                            "extracted": row["status"] == "ready"
                            and row["active_version"] is not None,
                            "source_unavailable": row["last_error_code"] == "source_unavailable",
                        }
                    )
                if len(rows) < chunk:
                    break
                after = str(rows[-1]["document_id"])
        return {"generation": generation, "documents": documents}

    def owner_identity(self) -> dict:
        """The owner's name on file, read-only, as DrivePacketStore.owner_identity
        reads it for the wrong-person fence. Memory only; never written."""
        from sqlalchemy import text

        with self.engine.connect() as db:
            assert_read_only(db)
            if not db.execute(
                text("SELECT to_regclass('actor_identity_cache') IS NOT NULL")
            ).scalar_one():
                return {"names": []}
            row = (
                db.execute(
                    text("SELECT display_name FROM actor_identity_cache WHERE user_id=:owner"),
                    {"owner": self.owner},
                )
                .mappings()
                .first()
            )
        name = row["display_name"] if row else None
        return {"names": [name.strip()] if isinstance(name, str) and name.strip() else []}

    def served_pages(self, document: dict) -> list[dict]:
        """Decrypt one document's current extraction pages in memory."""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from sqlalchemy import text

        from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore
        from hushh_mcp.services.drive_document_pages import PageEvidence
        from hushh_mcp.services.drive_document_store import DriveDocumentCipher

        key = DriveDocumentCipher()._key()
        params = {
            "user": self.owner,
            "document": document["document_id"],
            "generation": document["generation"],
            "version": document["active_version"],
        }
        with self.engine.connect() as db:
            assert_read_only(db)
            rows = list(
                db.execute(
                    text(
                        "SELECT page_number,content_envelope FROM drive_document_pages "
                        "WHERE document_id=:document AND extraction_version=:version "
                        "ORDER BY page_number"
                    ),
                    {"document": document["document_id"], "version": document["active_version"]},
                ).mappings()
            )
        pages = []
        for row in rows:
            envelope = row["content_envelope"]
            raw = AESGCM(key).decrypt(
                base64.b64decode(envelope["iv"], validate=True),
                base64.b64decode(envelope["ciphertext"], validate=True),
                DriveDocumentPageStore._aad(params, row["page_number"]),
            )
            pages.append(asdict(PageEvidence(**json.loads(raw))))
        return pages

    # Drive ---------------------------------------------------------------------
    def access_token(self) -> str:
        """Use the stored token while fresh; otherwise refresh in memory only."""
        import httpx

        from hushh_mcp.services.external_connector_credentials_service import (
            ExternalConnectorCredentialsService,
        )

        now = datetime.now(UTC)
        if self._credential and self._credential["expires"] > now + timedelta(seconds=120):
            return self._credential["token"]
        with self.engine.connect() as db:
            assert_read_only(db)
            row = self.connection_row(db)
        credential = ExternalConnectorCredentialsService().open_credential(
            user_id=self.owner, connector_id="google_drive", row=row
        )
        expires = row["credential_expires_at"]
        token = credential["accessToken"]
        if expires <= now + timedelta(seconds=120):
            response = httpx.post(
                TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": credential["refreshToken"],
                    "client_id": self._secrets["GOOGLE_DRIVE_OAUTH_CLIENT_ID"],
                    "client_secret": self._secrets["GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"],
                },
                timeout=30,
            )
            if response.status_code != 200:
                raise RuntimeError("drive_token_refresh_failed")
            body = response.json()
            token = body["access_token"]
            expires = now + timedelta(seconds=int(body.get("expires_in", 600)))
        self._credential = {"token": token, "expires": expires}
        return token

    def drive(self, *, concurrency: int = 4) -> DriveReadOnly:
        return DriveReadOnly(self.access_token, concurrency=concurrency)

    def close(self) -> None:
        self.engine.dispose()
        for name in PROCESS_KEYS:
            os.environ.pop(name, None)


# --- Fixtures ---------------------------------------------------------------------
@contextlib.contextmanager
def native_text_only():
    """Fixture extraction without OCR, so CI results never depend on the runner."""
    from hushh_mcp.services import drive_document_pages

    previous = drive_document_pages.TESSERACT_BINARY
    drive_document_pages.TESSERACT_BINARY = "/nonexistent/tesseract"
    try:
        yield
    finally:
        drive_document_pages.TESSERACT_BINARY = previous


class FixtureSource:
    """Synthetic manifest corpus (tests/fixtures/drive_pipeline_eval) for CI."""

    def __init__(self, manifest: Path, *, salt: bytes):
        from hushh_mcp.services.drive_pipeline_evaluation import adapter_input, load_dataset

        self.dataset = load_dataset(manifest)
        self.root = manifest.parent
        self.salt = salt
        self.documents: dict[str, dict] = {}
        self.gold: dict[str, dict] = {}
        for case in self.dataset["cases"]:
            supplied = adapter_input(case, self.root)
            labels = {item["ref"]: item for item in case["documents"]}
            for document in supplied["documents"]:
                key = keyed(salt, "file", f"fixture:{document['sha256']}")
                self.documents.setdefault(
                    key,
                    {
                        "file_key": key,
                        "content": document["content"],
                        "mime_type": document["mime_type"],
                        "sha256": document["sha256"],
                        "source_version": document["source_version"],
                        "metadata": document.get("source_metadata", {}),
                        "family": case["correlation_group"],
                    },
                )
                gold = labels[document["ref"]]
                self.gold.setdefault(key, {"facts": gold.get("facts", {}), "relevance": set()})
                self.gold[key]["relevance"].add(gold["relevance"])

    def frame(self, frame_id: str):
        from hushh_eval.drive_packets.contracts import FrameRow
        from hushh_eval.drive_packets.strata import age_bucket, mime_family, size_bucket, year_of

        rows = []
        for key, document in sorted(self.documents.items()):
            modified = document["metadata"].get("modifiedTime")
            rows.append(
                FrameRow(
                    frame_id=frame_id,
                    file_key=key,
                    mime_family=mime_family(document["mime_type"]),
                    size_bucket=size_bucket(len(document["content"])),
                    age_bucket=age_bucket(modified),
                    modified_year=year_of(modified),
                    created_year=year_of(document["metadata"].get("createdTime")),
                    folder_key=keyed(self.salt, "folder", document["family"]),
                    top_folder_key=keyed(self.salt, "top", "fixtures"),
                    system_stage="pending",
                    in_system=True,
                    in_independent_listing=True,
                )
            )
        return rows

    def original(self, file_key: str) -> tuple[str, bytes, dict]:
        document = self.documents[file_key]
        return document["mime_type"], document["content"], dict(document["metadata"])

    def labels(self, file_key: str) -> dict[str, Any]:
        """Gold facts for scoring only. Never passed to replay or the judge."""
        return dict(self.gold[file_key]["facts"])

    def source_version(self, file_key: str) -> str:
        return self.documents[file_key]["source_version"]


def content_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
