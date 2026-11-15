"""Encrypted versioned Personal Wiki library over Pod/Local Files object stores."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services.pod_object_version import ABSENT, ObjectVersion

from .contracts import (
    MAX_BATCH_PAGES,
    WikiPageRevision,
    WikiRefused,
    WikiSourceRef,
    canonical_request_fingerprint,
    replace_markdown_section,
    validate_batch_id,
    validate_folder,
    validate_idempotency_key,
    validate_page_id,
    validate_source_id,
    validate_title,
)
from .index_and_search import BacklinkGraph, LexicalSearchIndex


def _aad_bytes(*, owner: str, account_generation: int, library_id: str, path: str) -> bytes:
    return f"{owner}:{account_generation}:{library_id}:{path}".encode("utf-8")


def open_revision_with_page_key(
    ciphertext: bytes,
    *,
    page_content_key: bytes,
    owner: str,
    account_generation: int = 0,
    library_id: str = "default",
    path: str,
) -> WikiPageRevision:
    """Open a single immutable revision using only that page's 256-bit content key."""
    if len(page_content_key) != 32 or len(ciphertext) < 28:
        raise WikiRefused("WIKI_INTEGRITY_FAILURE", 409)
    try:
        plaintext = AESGCM(page_content_key).decrypt(
            ciphertext[:12],
            ciphertext[12:],
            _aad_bytes(
                owner=owner,
                account_generation=account_generation,
                library_id=library_id,
                path=path,
            ),
        )
    except Exception as exc:
        raise WikiRefused("WIKI_INTEGRITY_FAILURE", 409) from exc
    return WikiPageRevision.from_storage_bytes(plaintext)


class WikiLibrary:
    """Encrypted personal wiki store with per-page keys, CAS heads, and rebuildable indexes."""

    def __init__(
        self,
        *,
        owner: str,
        key: bytes,
        store: Any,
        check: Callable[[], Awaitable[None]],
        account_generation: int = 0,
        library_id: str = "default",
    ) -> None:
        if (
            not owner
            or len(key) != 32
            or type(account_generation) is not int
            or account_generation < 0
            or not library_id
        ):
            raise ValueError("WikiLibrary requires owner, 32-byte key, generation, and library_id")
        self.owner = owner
        self.store = store
        self.check = check
        self.account_generation = account_generation
        self.library_id = library_id

        scope = f"{owner}/{account_generation}/{library_id}".encode("utf-8")
        self._enc_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-wiki/enc/v1/" + scope,
        ).derive(key)
        self._names_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-wiki/names/v1/" + scope,
        ).derive(key)
        self._page_key_root = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-wiki/page-keys/v1/" + scope,
        ).derive(key)

    def _derive_page_content_key(self, page_id: str, key_epoch: int = 0) -> bytes:
        return HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=f"page-key:{page_id}:{key_epoch}".encode("utf-8"),
        ).derive(self._page_key_root)

    def _opaque(self, label: str) -> str:
        return hmac.new(self._names_key, label.encode("utf-8"), hashlib.sha256).hexdigest()

    def _head_path(self, page_id: str) -> str:
        return f"wiki/v1/heads/{self._opaque('head:' + validate_page_id(page_id))}.bin"

    def _make_revision_id(self, page_id: str, revision: int, commit_token: str) -> str:
        if type(revision) is not int or revision < 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        return self._opaque(f"rev_id:{validate_page_id(page_id)}:{revision}:{commit_token}")[:32]

    def _revision_path(self, revision_id: str) -> str:
        if not isinstance(revision_id, str) or len(revision_id) != 32:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        return f"wiki/v1/revisions/{self._opaque('revision_blob:' + revision_id)}.bin"

    def _source_path(self, source_id: str) -> str:
        return f"wiki/v1/sources/{self._opaque('source:' + validate_source_id(source_id))}.bin"

    def _batch_path(self, batch_id: str) -> str:
        return f"wiki/v1/batches/{self._opaque('batch:' + validate_batch_id(batch_id))}.bin"

    def _index_path(self, name: str) -> str:
        return f"wiki/v1/indexes/{self._opaque('index:' + name)}.bin"

    def _seal(self, path: str, plaintext: bytes, *, key: bytes | None = None) -> bytes:
        nonce = secrets.token_bytes(12)
        aad = _aad_bytes(
            owner=self.owner,
            account_generation=self.account_generation,
            library_id=self.library_id,
            path=path,
        )
        return nonce + AESGCM(key or self._enc_key).encrypt(nonce, plaintext, aad)

    def _open(self, path: str, ciphertext: bytes, *, key: bytes | None = None) -> bytes:
        if len(ciphertext) < 28:
            raise WikiRefused("WIKI_INTEGRITY_FAILURE", 409)
        aad = _aad_bytes(
            owner=self.owner,
            account_generation=self.account_generation,
            library_id=self.library_id,
            path=path,
        )
        try:
            return AESGCM(key or self._enc_key).decrypt(ciphertext[:12], ciphertext[12:], aad)
        except Exception as exc:
            raise WikiRefused("WIKI_INTEGRITY_FAILURE", 409) from exc

    async def _read_json(
        self, path: str, *, key: bytes | None = None
    ) -> tuple[dict[str, Any] | None, ObjectVersion]:
        await self.check()
        raw, generation = await self.store.get_with_generation(path)
        if raw is None:
            return None, generation
        await self.check()
        try:
            decoded = json.loads(self._open(path, raw, key=key).decode("utf-8"))
        except WikiRefused:
            raise
        except (ValueError, UnicodeDecodeError) as exc:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409) from exc
        if not isinstance(decoded, dict) or decoded.get("format") != 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        return decoded, generation

    async def _write_json(
        self,
        path: str,
        payload: dict[str, Any],
        expected: ObjectVersion,
        *,
        key: bytes | None = None,
    ) -> ObjectVersion:
        await self.check()
        encoded = json.dumps(
            {"format": 1, **payload},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        new_gen = await self.store.put_if_generation(
            path, self._seal(path, encoded, key=key), expected
        )
        if new_gen is None:
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
        return new_gen

    async def _list_all_paths(self, prefix: str) -> list[str]:
        await self.check()
        paths: list[str] = []
        cursor = ""
        while True:
            try:
                names, cursor = await self.store.list_page(prefix, cursor=cursor, limit=100)
            except FileNotFoundError:
                return paths
            paths.extend(names)
            if not cursor:
                return paths

    async def _write_immutable_revision(
        self, page: WikiPageRevision, *, revision_id: str, page_key: bytes
    ) -> str:
        path = self._revision_path(revision_id)
        await self.check()
        serialized = json.dumps(
            page.to_storage_dict(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        sealed = self._seal(path, serialized, key=page_key)
        written = await self.store.put_if_generation(path, sealed, ABSENT)
        if written is None:
            existing_raw, _ = await self.store.get_with_generation(path)
            if existing_raw is None:
                raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
            existing_page = open_revision_with_page_key(
                existing_raw,
                page_content_key=page_key,
                owner=self.owner,
                account_generation=self.account_generation,
                library_id=self.library_id,
                path=path,
            )
            if existing_page.content_sha256() != page.content_sha256():
                raise WikiRefused("WIKI_IDEMPOTENCY_CONFLICT", 409)
        return path

    async def _read_revision_with_key(
        self, revision_id: str, *, page_key: bytes
    ) -> WikiPageRevision:
        await self.check()
        path = self._revision_path(revision_id)
        raw, _ = await self.store.get_with_generation(path)
        if raw is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        await self.check()
        return open_revision_with_page_key(
            raw,
            page_content_key=page_key,
            owner=self.owner,
            account_generation=self.account_generation,
            library_id=self.library_id,
            path=path,
        )

    @staticmethod
    def _head_key(head: dict[str, Any]) -> bytes:
        try:
            key = base64.b64decode(str(head["content_key_b64"]), validate=True)
        except Exception as exc:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409) from exc
        if len(key) != 32:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        return key

    @staticmethod
    def _revision_id_for(head: dict[str, Any], revision: int) -> str:
        rev_map = head.get("revision_ids")
        if not isinstance(rev_map, dict):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 409)
        rev_id = rev_map.get(str(revision))
        if not isinstance(rev_id, str) or len(rev_id) != 32:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        return rev_id

    async def _resolve_effective_head(
        self, head: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Resolve staged two-phase batch state without ever exposing half-committed mixes."""
        staged = head.get("staged")
        if not isinstance(staged, dict):
            if int(head.get("revision", 0)) < 1:
                return None, None
            return head, None

        batch_id = validate_batch_id(staged.get("batch_id"))
        batch, _ = await self._read_json(self._batch_path(batch_id))
        state = batch.get("state") if batch else "aborted"
        if state in {"committed", "finalized"}:
            promoted = dict(head)
            rev_ids = dict(head.get("revision_ids") or {})
            rev_ids[str(int(staged["target_revision"]))] = str(staged["target_revision_id"])
            promoted.update(
                revision=int(staged["target_revision"]),
                title=str(staged["title"]),
                folder=str(staged["folder"]),
                status_as_of=str(staged["status_as_of"]),
                updated_at=int(staged["updated_at"]),
                last_batch_id=batch_id,
                revision_ids=rev_ids,
            )
            promoted.pop("staged", None)
            return promoted, None
        if state == "committing":
            if int(head.get("revision", 0)) < 1:
                return None, batch_id
            return head, batch_id
        # Aborted batch: fall back cleanly to prior committed revision.
        if int(head.get("revision", 0)) < 1:
            return None, None
        clean = dict(head)
        clean.pop("staged", None)
        return clean, None

    @staticmethod
    def _lookup_idempotent_commit(
        head: dict[str, Any], *, idempotency_key: str, fingerprint: str
    ) -> int | None:
        for entry in head.get("recent_commits", []):
            if entry.get("idempotency_key") == idempotency_key:
                if entry.get("fingerprint") != fingerprint:
                    raise WikiRefused("WIKI_IDEMPOTENCY_CONFLICT", 409)
                return int(entry["revision"])
        return None

    async def _refresh_indexes_for_page(self, page: WikiPageRevision) -> None:
        for index_name, cls in (("backlinks", BacklinkGraph), ("lexical", LexicalSearchIndex)):
            path = self._index_path(index_name)
            for _ in range(4):
                existing, gen = await self._read_json(path)
                instance = cls.from_dict(existing) if existing is not None else cls()
                instance.upsert_page(page)
                payload = instance.to_dict()
                payload.pop("format", None)
                try:
                    await self._write_json(path, payload, gen)
                    break
                except WikiRefused as exc:
                    if exc.code != "WIKI_REVISION_CONFLICT":
                        raise

    async def register_source(
        self, source: dict[str, Any] | WikiSourceRef, *, idempotency_key: str
    ) -> dict[str, Any]:
        validate_idempotency_key(idempotency_key)
        parsed = source if isinstance(source, WikiSourceRef) else WikiSourceRef.from_mapping(source)
        path = self._source_path(parsed.source_id)
        existing, _ = await self._read_json(path)
        if existing is not None:
            stored = WikiSourceRef.from_mapping(existing)
            if stored != parsed:
                raise WikiRefused("WIKI_IDEMPOTENCY_CONFLICT", 409)
            return stored.to_dict()
        await self._write_json(path, parsed.to_dict(), ABSENT)
        return parsed.to_dict()

    async def get_source(self, source_id: str) -> dict[str, Any]:
        existing, _ = await self._read_json(self._source_path(source_id))
        if existing is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        return WikiSourceRef.from_mapping(existing).to_dict()

    async def create_page(
        self,
        *,
        title: str,
        idempotency_key: str,
        folder: str = "root",
        tldr: str = "",
        status_as_of: str = "2026-01-01",
        body: str = "",
        claims: list[dict[str, Any]] | tuple[dict[str, Any], ...] = (),
        links: list[dict[str, Any]] | tuple[dict[str, Any], ...] = (),
        source_ids: list[str] | tuple[str, ...] = (),
        page_id: str | None = None,
    ) -> dict[str, Any]:
        idem = validate_idempotency_key(idempotency_key)
        resolved_id = (
            validate_page_id(page_id)
            if page_id is not None
            else f"wpg_{self._opaque('create_page:' + idem)[:16]}"
        )
        fingerprint = canonical_request_fingerprint(
            {
                "op": "create_page",
                "page_id": resolved_id,
                "title": title,
                "folder": folder,
                "tldr": tldr,
                "status_as_of": status_as_of,
                "body": body,
                "claims": list(claims),
                "links": list(links),
                "source_ids": list(source_ids),
            }
        )
        head_path = self._head_path(resolved_id)
        existing_head, _ = await self._read_json(head_path)
        if existing_head is not None:
            replay_rev = self._lookup_idempotent_commit(
                existing_head, idempotency_key=idem, fingerprint=fingerprint
            )
            if replay_rev is not None:
                return await self.read_page(resolved_id, revision=replay_rev)
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)

        now_ms = int(time.time() * 1000)
        page_key = self._derive_page_content_key(resolved_id, key_epoch=0)
        rev_id = self._make_revision_id(resolved_id, 1, idem)
        rev_path = self._revision_path(rev_id)
        existing_rev_bytes, _ = await self.store.get_with_generation(rev_path)
        if existing_rev_bytes is not None:
            prior_rev = open_revision_with_page_key(
                existing_rev_bytes,
                page_content_key=page_key,
                owner=self.owner,
                account_generation=self.account_generation,
                library_id=self.library_id,
                path=rev_path,
            )
            now_ms = prior_rev.updated_at

        revision_doc = WikiPageRevision.build(
            page_id=resolved_id,
            revision=1,
            title=title,
            folder=folder,
            tldr=tldr,
            status_as_of=status_as_of,
            body=body,
            claims=list(claims),
            links=list(links),
            source_ids=list(source_ids),
            updated_at=now_ms,
        )
        await self._write_immutable_revision(revision_doc, revision_id=rev_id, page_key=page_key)

        head_doc = {
            "page_id": resolved_id,
            "revision": 1,
            "title": revision_doc.title,
            "folder": revision_doc.folder,
            "status_as_of": revision_doc.status_as_of,
            "updated_at": now_ms,
            "state": "ready",
            "content_key_b64": base64.b64encode(page_key).decode("ascii"),
            "revision_ids": {"1": rev_id},
            "recent_commits": [
                {
                    "idempotency_key": idem,
                    "fingerprint": fingerprint,
                    "base_revision": 0,
                    "revision": 1,
                }
            ],
        }
        await self._write_json(head_path, head_doc, ABSENT)
        await self._refresh_indexes_for_page(revision_doc)
        return revision_doc.to_public_dict()

    async def read_page(
        self,
        page_id: str,
        *,
        revision: int | None = None,
        require_settled: bool = False,
    ) -> dict[str, Any]:
        validated_id = validate_page_id(page_id)
        raw_head, _ = await self._read_json(self._head_path(validated_id))
        if raw_head is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        effective_head, pending_batch_id = await self._resolve_effective_head(raw_head)
        if require_settled and pending_batch_id is not None:
            raise WikiRefused("WIKI_BATCH_INCOMPLETE", 409)
        if effective_head is None:
            if pending_batch_id is not None:
                raise WikiRefused("WIKI_BATCH_INCOMPLETE", 409)
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        if effective_head.get("state") == "trashed":
            raise WikiRefused("WIKI_NOT_FOUND", 404)

        target_rev = int(effective_head["revision"]) if revision is None else revision
        if (
            type(target_rev) is not int
            or target_rev < 1
            or target_rev > int(effective_head["revision"])
        ):
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        page_key = self._head_key(effective_head)
        rev_id = self._revision_id_for(effective_head, target_rev)
        page = await self._read_revision_with_key(rev_id, page_key=page_key)
        return page.to_public_dict(pending_batch_id=pending_batch_id)

    async def export_narrow_page_key(self, page_id: str) -> tuple[bytes, str]:
        """Return (page_content_key, revision_object_path) for isolated custody tests/shares."""
        validated_id = validate_page_id(page_id)
        raw_head, _ = await self._read_json(self._head_path(validated_id))
        if raw_head is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        effective_head, _ = await self._resolve_effective_head(raw_head)
        if effective_head is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        rev = int(effective_head["revision"])
        rev_id = self._revision_id_for(effective_head, rev)
        return self._head_key(effective_head), self._revision_path(rev_id)

    async def edit_page(
        self,
        page_id: str,
        *,
        expected_revision: int,
        idempotency_key: str,
        title: str | None = None,
        folder: str | None = None,
        tldr: str | None = None,
        status_as_of: str | None = None,
        body: str | None = None,
        claims: list[dict[str, Any]] | None = None,
        links: list[dict[str, Any]] | None = None,
        source_ids: list[str] | None = None,
        _fingerprint_override: str | None = None,
    ) -> dict[str, Any]:
        validated_id = validate_page_id(page_id)
        idem = validate_idempotency_key(idempotency_key)
        if type(expected_revision) is not int or expected_revision < 1:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        fingerprint = _fingerprint_override or canonical_request_fingerprint(
            {
                "op": "edit_page",
                "page_id": validated_id,
                "expected_revision": expected_revision,
                "title": title,
                "folder": folder,
                "tldr": tldr,
                "status_as_of": status_as_of,
                "body": body,
                "claims": claims,
                "links": links,
                "source_ids": source_ids,
            }
        )
        head_path = self._head_path(validated_id)
        raw_head, head_gen = await self._read_json(head_path)
        if raw_head is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)

        replay_rev = self._lookup_idempotent_commit(
            raw_head, idempotency_key=idem, fingerprint=fingerprint
        )
        if replay_rev is not None:
            return await self.read_page(validated_id, revision=replay_rev)

        effective_head, pending_batch_id = await self._resolve_effective_head(raw_head)
        if pending_batch_id is not None:
            raise WikiRefused("WIKI_BATCH_INCOMPLETE", 409)
        if effective_head is None or effective_head.get("state") == "trashed":
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        if int(effective_head["revision"]) != expected_revision:
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)

        page_key = self._head_key(effective_head)
        current_rev_id = self._revision_id_for(effective_head, expected_revision)
        current_doc = await self._read_revision_with_key(current_rev_id, page_key=page_key)
        target_rev = expected_revision + 1
        now_ms = max(int(time.time() * 1000), current_doc.updated_at + 1)

        rev_id = self._make_revision_id(validated_id, target_rev, idem)
        rev_path = self._revision_path(rev_id)
        existing_rev_bytes, _ = await self.store.get_with_generation(rev_path)
        if existing_rev_bytes is not None:
            prior_attempt = open_revision_with_page_key(
                existing_rev_bytes,
                page_content_key=page_key,
                owner=self.owner,
                account_generation=self.account_generation,
                library_id=self.library_id,
                path=rev_path,
            )
            now_ms = prior_attempt.updated_at

        next_doc = WikiPageRevision.build(
            page_id=validated_id,
            revision=target_rev,
            title=current_doc.title if title is None else title,
            folder=current_doc.folder if folder is None else folder,
            tldr=current_doc.tldr if tldr is None else tldr,
            status_as_of=current_doc.status_as_of if status_as_of is None else status_as_of,
            body=current_doc.body if body is None else body,
            claims=(
                [claim.to_dict() for claim in current_doc.claims] if claims is None else claims
            ),
            links=[edge.to_dict() for edge in current_doc.links] if links is None else links,
            source_ids=list(current_doc.source_ids) if source_ids is None else source_ids,
            updated_at=now_ms,
        )
        await self._write_immutable_revision(next_doc, revision_id=rev_id, page_key=page_key)

        commits = list(effective_head.get("recent_commits", []))
        commits.append(
            {
                "idempotency_key": idem,
                "fingerprint": fingerprint,
                "base_revision": expected_revision,
                "revision": target_rev,
            }
        )
        rev_ids = dict(effective_head.get("revision_ids") or {})
        rev_ids[str(target_rev)] = rev_id
        next_head = {
            **effective_head,
            "revision": target_rev,
            "title": next_doc.title,
            "folder": next_doc.folder,
            "status_as_of": next_doc.status_as_of,
            "updated_at": now_ms,
            "revision_ids": rev_ids,
            "recent_commits": commits[-16:],
        }
        next_head.pop("staged", None)
        await self._write_json(head_path, next_head, head_gen)
        await self._refresh_indexes_for_page(next_doc)
        return next_doc.to_public_dict()

    async def edit_section(
        self,
        page_id: str,
        *,
        heading: str,
        content: str | None,
        expected_revision: int,
        idempotency_key: str,
        level: int = 2,
        create_if_missing: bool = True,
        status_as_of: str | None = None,
    ) -> dict[str, Any]:
        validated_id = validate_page_id(page_id)
        idem = validate_idempotency_key(idempotency_key)
        fingerprint = canonical_request_fingerprint(
            {
                "op": "edit_section",
                "page_id": validated_id,
                "expected_revision": expected_revision,
                "heading": heading,
                "content": content,
                "level": level,
                "create_if_missing": create_if_missing,
                "status_as_of": status_as_of,
            }
        )
        raw_head, _ = await self._read_json(self._head_path(validated_id))
        if raw_head is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        replay_rev = self._lookup_idempotent_commit(
            raw_head, idempotency_key=idem, fingerprint=fingerprint
        )
        if replay_rev is not None:
            return await self.read_page(validated_id, revision=replay_rev)

        current = await self.read_page(validated_id, require_settled=True)
        if int(current["revision"]) != expected_revision:
            raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
        updated_body = replace_markdown_section(
            current["body"],
            heading=heading,
            content=content,
            level=level,
            create_if_missing=create_if_missing,
        )
        return await self.edit_page(
            validated_id,
            expected_revision=expected_revision,
            idempotency_key=idem,
            body=updated_body,
            status_as_of=status_as_of,
            _fingerprint_override=fingerprint,
        )

    async def rename_page(
        self,
        page_id: str,
        *,
        title: str,
        expected_revision: int,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self.edit_page(
            page_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            title=validate_title(title),
        )

    async def move_page(
        self,
        page_id: str,
        *,
        folder: str,
        expected_revision: int,
        idempotency_key: str,
    ) -> dict[str, Any]:
        return await self.edit_page(
            page_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            folder=validate_folder(folder),
        )

    async def list_pages(self, *, folder: str | None = None) -> list[dict[str, Any]]:
        normalized_folder = None if folder is None else validate_folder(folder)
        entries: list[dict[str, Any]] = []
        for path in await self._list_all_paths("wiki/v1/heads"):
            raw_head, _ = await self._read_json(path)
            if raw_head is None:
                continue
            effective_head, pending_batch_id = await self._resolve_effective_head(raw_head)
            if effective_head is None or effective_head.get("state") == "trashed":
                continue
            if normalized_folder is not None and effective_head.get("folder") != normalized_folder:
                continue
            item: dict[str, Any] = {
                "page_id": effective_head["page_id"],
                "revision": int(effective_head["revision"]),
                "title": effective_head["title"],
                "folder": effective_head["folder"],
                "status_as_of": effective_head["status_as_of"],
                "updated_at": int(effective_head["updated_at"]),
            }
            if pending_batch_id is not None:
                item["pending_batch_id"] = pending_batch_id
            entries.append(item)
        entries.sort(key=lambda item: item["page_id"])
        return entries

    async def commit_synthesis_batch(
        self,
        *,
        items: list[dict[str, Any]],
        idempotency_key: str,
        _fail_after_staged_count: int | None = None,
        _fail_after_commit_flip: bool = False,
    ) -> dict[str, Any]:
        """Atomically stage and commit a multi-page synthesis batch with crash recovery."""
        idem = validate_idempotency_key(idempotency_key)
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_BATCH_PAGES:
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

        batch_id = f"wbt_{self._opaque('batch:' + idem)[:16]}"
        fingerprint = canonical_request_fingerprint({"op": "synthesis_batch", "items": items})
        batch_path = self._batch_path(batch_id)
        existing_batch, _ = await self._read_json(batch_path)
        if existing_batch is not None:
            if existing_batch.get("fingerprint") != fingerprint:
                raise WikiRefused("WIKI_IDEMPOTENCY_CONFLICT", 409)
            if existing_batch.get("state") == "finalized":
                return self._public_batch(existing_batch)
            return await self.recover_batch(batch_id)

        prepared_specs: list[dict[str, Any]] = []
        seen_pages: set[str] = set()
        now_ms = int(time.time() * 1000)

        for index, raw_item in enumerate(items):
            if not isinstance(raw_item, dict):
                raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
            expected_rev = raw_item.get("expected_revision")
            if type(expected_rev) is not int or expected_rev < 0:
                raise WikiRefused("WIKI_SCHEMA_INVALID", 400)

            page_id = (
                validate_page_id(raw_item["page_id"])
                if raw_item.get("page_id") is not None
                else f"wpg_{self._opaque(f'batch_page:{idem}:{index}')[:16]}"
            )
            if page_id in seen_pages:
                raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
            seen_pages.add(page_id)

            head_path = self._head_path(page_id)
            raw_head, _ = await self._read_json(head_path)
            if expected_rev == 0:
                if raw_head is not None:
                    effective_existing, pending_id = await self._resolve_effective_head(raw_head)
                    if pending_id is not None:
                        raise WikiRefused("WIKI_BATCH_INCOMPLETE", 409)
                    if effective_existing is not None:
                        raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
                page_key = self._derive_page_content_key(page_id, key_epoch=0)
                target_doc = WikiPageRevision.build(
                    page_id=page_id,
                    revision=1,
                    title=raw_item.get("title", ""),
                    folder=raw_item.get("folder", "root"),
                    tldr=raw_item.get("tldr", ""),
                    status_as_of=raw_item.get("status_as_of", "2026-01-01"),
                    body=raw_item.get("body", ""),
                    claims=raw_item.get("claims", []),
                    links=raw_item.get("links", []),
                    source_ids=raw_item.get("source_ids", []),
                    updated_at=now_ms + index,
                )
            else:
                if raw_head is None:
                    raise WikiRefused("WIKI_NOT_FOUND", 404)
                effective_existing, pending_id = await self._resolve_effective_head(raw_head)
                if pending_id is not None:
                    raise WikiRefused("WIKI_BATCH_INCOMPLETE", 409)
                if effective_existing is None or effective_existing.get("state") == "trashed":
                    raise WikiRefused("WIKI_NOT_FOUND", 404)
                if int(effective_existing["revision"]) != expected_rev:
                    raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
                page_key = self._head_key(effective_existing)
                current_rev_id = self._revision_id_for(effective_existing, expected_rev)
                current_doc = await self._read_revision_with_key(current_rev_id, page_key=page_key)
                target_doc = WikiPageRevision.build(
                    page_id=page_id,
                    revision=expected_rev + 1,
                    title=current_doc.title if "title" not in raw_item else raw_item["title"],
                    folder=current_doc.folder if "folder" not in raw_item else raw_item["folder"],
                    tldr=current_doc.tldr if "tldr" not in raw_item else raw_item["tldr"],
                    status_as_of=(
                        current_doc.status_as_of
                        if "status_as_of" not in raw_item
                        else raw_item["status_as_of"]
                    ),
                    body=current_doc.body if "body" not in raw_item else raw_item["body"],
                    claims=(
                        [claim.to_dict() for claim in current_doc.claims]
                        if "claims" not in raw_item
                        else raw_item["claims"]
                    ),
                    links=(
                        [edge.to_dict() for edge in current_doc.links]
                        if "links" not in raw_item
                        else raw_item["links"]
                    ),
                    source_ids=(
                        list(current_doc.source_ids)
                        if "source_ids" not in raw_item
                        else raw_item["source_ids"]
                    ),
                    updated_at=max(now_ms + index, current_doc.updated_at + 1),
                )

            target_rev_id = self._make_revision_id(
                page_id, target_doc.revision, f"{batch_id}:{index}"
            )
            await self._write_immutable_revision(
                target_doc, revision_id=target_rev_id, page_key=page_key
            )
            prepared_specs.append(
                {
                    "page_id": page_id,
                    "base_revision": expected_rev,
                    "target_revision": target_doc.revision,
                    "target_revision_id": target_rev_id,
                    "title": target_doc.title,
                    "folder": target_doc.folder,
                    "status_as_of": target_doc.status_as_of,
                    "updated_at": target_doc.updated_at,
                    "content_sha256": target_doc.content_sha256(),
                    "content_key_b64": base64.b64encode(page_key).decode("ascii"),
                }
            )

        batch_record = {
            "batch_id": batch_id,
            "idempotency_key": idem,
            "fingerprint": fingerprint,
            "state": "committing",
            "created_at": now_ms,
            "items": prepared_specs,
        }
        await self._write_json(batch_path, batch_record, ABSENT)
        return await self._drive_batch(
            batch_id,
            fail_after_staged_count=_fail_after_staged_count,
            fail_after_commit_flip=_fail_after_commit_flip,
        )

    async def _drive_batch(
        self,
        batch_id: str,
        *,
        fail_after_staged_count: int | None = None,
        fail_after_commit_flip: bool = False,
    ) -> dict[str, Any]:
        batch_path = self._batch_path(batch_id)
        batch, batch_gen = await self._read_json(batch_path)
        if batch is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)

        state = batch.get("state")
        if state in {"finalized", "aborted"}:
            return self._public_batch(batch)

        if state == "committing":
            staged_count = 0
            for spec in batch["items"]:
                page_id = spec["page_id"]
                head_path = self._head_path(page_id)
                raw_head, head_gen = await self._read_json(head_path)
                already_staged_here = (
                    isinstance(raw_head, dict)
                    and isinstance(raw_head.get("staged"), dict)
                    and raw_head["staged"].get("batch_id") == batch_id
                )
                if not already_staged_here:
                    staged_payload = {
                        "batch_id": batch_id,
                        "target_revision": spec["target_revision"],
                        "target_revision_id": spec["target_revision_id"],
                        "title": spec["title"],
                        "folder": spec["folder"],
                        "status_as_of": spec["status_as_of"],
                        "updated_at": spec["updated_at"],
                    }
                    try:
                        if int(spec["base_revision"]) == 0:
                            if raw_head is not None and int(raw_head.get("revision", 0)) >= 1:
                                raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
                            staging_head = {
                                "page_id": page_id,
                                "revision": 0,
                                "title": spec["title"],
                                "folder": spec["folder"],
                                "status_as_of": spec["status_as_of"],
                                "updated_at": spec["updated_at"],
                                "state": "ready",
                                "content_key_b64": spec["content_key_b64"],
                                "revision_ids": {},
                                "recent_commits": [],
                                "staged": staged_payload,
                            }
                            await self._write_json(
                                head_path, staging_head, ABSENT if raw_head is None else head_gen
                            )
                        else:
                            if raw_head is None:
                                raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
                            effective_head, other_pending = await self._resolve_effective_head(
                                raw_head
                            )
                            if other_pending is not None and other_pending != batch_id:
                                raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
                            if effective_head is None or int(effective_head["revision"]) != int(
                                spec["base_revision"]
                            ):
                                raise WikiRefused("WIKI_REVISION_CONFLICT", 409)
                            staging_head = {**effective_head, "staged": staged_payload}
                            await self._write_json(head_path, staging_head, head_gen)
                    except WikiRefused as exc:
                        if exc.code == "WIKI_REVISION_CONFLICT":
                            aborted = {**batch, "state": "aborted"}
                            aborted.pop("format", None)
                            await self._write_json(batch_path, aborted, batch_gen)
                            await self._cleanup_aborted_batch(aborted)
                            raise
                        raise
                staged_count += 1
                if fail_after_staged_count is not None and staged_count >= fail_after_staged_count:
                    raise RuntimeError("simulated_synthesis_interruption_during_staging")

            committed = {**batch, "state": "committed"}
            committed.pop("format", None)
            batch_gen = await self._write_json(batch_path, committed, batch_gen)
            batch = {"format": 1, **committed}
            if fail_after_commit_flip:
                raise RuntimeError("simulated_synthesis_interruption_after_commit")

        # Finalize committed heads and refresh derived indexes.
        for spec in batch["items"]:
            page_id = spec["page_id"]
            head_path = self._head_path(page_id)
            raw_head, head_gen = await self._read_json(head_path)
            if raw_head is not None:
                staged = raw_head.get("staged")
                if isinstance(staged, dict) and staged.get("batch_id") == batch_id:
                    commits = list(raw_head.get("recent_commits", []))
                    commits.append(
                        {
                            "idempotency_key": f"{batch['idempotency_key']}:{page_id}",
                            "fingerprint": spec["content_sha256"],
                            "base_revision": spec["base_revision"],
                            "revision": spec["target_revision"],
                        }
                    )
                    rev_ids = dict(raw_head.get("revision_ids") or {})
                    rev_ids[str(int(spec["target_revision"]))] = spec["target_revision_id"]
                    finalized_head = {
                        **raw_head,
                        "revision": int(spec["target_revision"]),
                        "title": spec["title"],
                        "folder": spec["folder"],
                        "status_as_of": spec["status_as_of"],
                        "updated_at": int(spec["updated_at"]),
                        "last_batch_id": batch_id,
                        "revision_ids": rev_ids,
                        "recent_commits": commits[-16:],
                    }
                    finalized_head.pop("staged", None)
                    finalized_head.pop("format", None)
                    try:
                        await self._write_json(head_path, finalized_head, head_gen)
                    except WikiRefused as exc:
                        if exc.code != "WIKI_REVISION_CONFLICT":
                            raise

            page_key = base64.b64decode(spec["content_key_b64"])
            rev_doc = await self._read_revision_with_key(
                spec["target_revision_id"], page_key=page_key
            )
            await self._refresh_indexes_for_page(rev_doc)

        finalized_batch = {**batch, "state": "finalized"}
        finalized_batch.pop("format", None)
        await self._write_json(batch_path, finalized_batch, batch_gen)
        return self._public_batch({"format": 1, **finalized_batch})

    async def _cleanup_aborted_batch(self, batch: dict[str, Any]) -> None:
        batch_id = batch["batch_id"]
        for spec in batch.get("items", []):
            head_path = self._head_path(spec["page_id"])
            raw_head, head_gen = await self._read_json(head_path)
            if raw_head is None:
                continue
            staged = raw_head.get("staged")
            if not isinstance(staged, dict) or staged.get("batch_id") != batch_id:
                continue
            if int(raw_head.get("revision", 0)) < 1:
                await self.store.delete(head_path)
                continue
            cleaned = dict(raw_head)
            cleaned.pop("staged", None)
            cleaned.pop("format", None)
            try:
                await self._write_json(head_path, cleaned, head_gen)
            except WikiRefused:
                pass

    async def recover_batch(self, batch_id: str) -> dict[str, Any]:
        validated = validate_batch_id(batch_id)
        try:
            return await self._drive_batch(validated)
        except WikiRefused as exc:
            if exc.code == "WIKI_REVISION_CONFLICT":
                batch, _ = await self._read_json(self._batch_path(validated))
                if batch is not None and batch.get("state") == "aborted":
                    return self._public_batch(batch)
            raise

    async def batch_status(self, batch_id: str) -> dict[str, Any]:
        batch, _ = await self._read_json(self._batch_path(validate_batch_id(batch_id)))
        if batch is None:
            raise WikiRefused("WIKI_NOT_FOUND", 404)
        return self._public_batch(batch)

    async def incomplete_batches(self) -> list[dict[str, Any]]:
        pending: list[dict[str, Any]] = []
        for path in await self._list_all_paths("wiki/v1/batches"):
            batch, _ = await self._read_json(path)
            if batch is None:
                continue
            if batch.get("state") in {"committing", "committed"}:
                pending.append(self._public_batch(batch))
        pending.sort(key=lambda item: item["batch_id"])
        return pending

    @staticmethod
    def _public_batch(batch: dict[str, Any]) -> dict[str, Any]:
        state = str(batch["state"])
        return {
            "batch_id": batch["batch_id"],
            "state": state,
            "complete": state in {"committed", "finalized"},
            "pages": [
                {
                    "page_id": item["page_id"],
                    "base_revision": int(item["base_revision"]),
                    "target_revision": int(item["target_revision"]),
                }
                for item in batch.get("items", [])
            ],
        }

    async def backlinks(self, page_id: str) -> dict[str, Any]:
        """Return verified outbound and inbound edges after rechecking live owner access."""
        validated_id = validate_page_id(page_id)
        target_page = await self.read_page(validated_id)
        raw_graph, _ = await self._read_json(self._index_path("backlinks"))
        if raw_graph is None:
            await self.rebuild_indexes()
            raw_graph, _ = await self._read_json(self._index_path("backlinks"))
        graph = BacklinkGraph.from_dict(raw_graph) if raw_graph is not None else BacklinkGraph()

        inbound_verified: list[dict[str, Any]] = []
        for candidate in graph.inbound_for(validated_id):
            source_id = candidate["source_page_id"]
            try:
                live_source = await self.read_page(source_id)
            except WikiRefused as exc:
                if exc.code in {"WIKI_NOT_FOUND", "WIKI_BATCH_INCOMPLETE"}:
                    continue
                raise
            matching_edges = [
                edge
                for edge in live_source["links"]
                if edge["target_page_id"] == validated_id
                and edge["relation"] == candidate["relation"]
                and edge.get("anchor_claim_id", "") == candidate.get("anchor_claim_id", "")
            ]
            for edge in matching_edges:
                entry: dict[str, Any] = {
                    "source_page_id": source_id,
                    "source_title": live_source["title"],
                    "source_folder": live_source["folder"],
                    "source_revision": live_source["revision"],
                    "relation": edge["relation"],
                }
                if "anchor_claim_id" in edge:
                    entry["anchor_claim_id"] = edge["anchor_claim_id"]
                if "note" in edge:
                    entry["note"] = edge["note"]
                inbound_verified.append(entry)

        outbound_verified: list[dict[str, Any]] = []
        for edge in target_page["links"]:
            dest_id = edge["target_page_id"]
            try:
                live_dest = await self.read_page(dest_id)
            except WikiRefused as exc:
                if exc.code in {"WIKI_NOT_FOUND", "WIKI_BATCH_INCOMPLETE"}:
                    continue
                raise
            entry = {
                "target_page_id": dest_id,
                "target_title": live_dest["title"],
                "target_folder": live_dest["folder"],
                "target_revision": live_dest["revision"],
                "relation": edge["relation"],
            }
            if "anchor_claim_id" in edge:
                entry["anchor_claim_id"] = edge["anchor_claim_id"]
            if "note" in edge:
                entry["note"] = edge["note"]
            outbound_verified.append(entry)

        return {
            "page_id": validated_id,
            "revision": target_page["revision"],
            "inbound": inbound_verified,
            "outbound": outbound_verified,
        }

    async def search(
        self, query: str, *, limit: int = 10, folder: str | None = None
    ) -> list[dict[str, Any]]:
        """Run bounded BM25 lexical search and revalidate live page custody before returning."""
        if not isinstance(query, str):
            raise WikiRefused("WIKI_SCHEMA_INVALID", 400)
        normalized_folder = None if folder is None else validate_folder(folder)
        raw_lexical, _ = await self._read_json(self._index_path("lexical"))
        if raw_lexical is None:
            await self.rebuild_indexes()
            raw_lexical, _ = await self._read_json(self._index_path("lexical"))
        index = (
            LexicalSearchIndex.from_dict(raw_lexical)
            if raw_lexical is not None
            else LexicalSearchIndex()
        )

        candidates = index.query_candidates(query, limit=min(max(limit * 2, limit), 50))
        results: list[dict[str, Any]] = []
        for candidate in candidates:
            if len(results) >= limit:
                break
            try:
                live_page = await self.read_page(candidate["page_id"])
            except WikiRefused as exc:
                if exc.code in {"WIKI_NOT_FOUND", "WIKI_BATCH_INCOMPLETE"}:
                    continue
                raise
            if normalized_folder is not None and live_page["folder"] != normalized_folder:
                continue
            active_claims = [
                claim for claim in live_page["claims"] if claim["status"] in {"active", "uncertain"}
            ]
            snippet = live_page["tldr"] or (
                active_claims[0]["statement"] if active_claims else live_page["body"][:200]
            )
            results.append(
                {
                    "page_id": live_page["page_id"],
                    "revision": live_page["revision"],
                    "title": live_page["title"],
                    "folder": live_page["folder"],
                    "status_as_of": live_page["status_as_of"],
                    "score": candidate["score"],
                    "matched_terms": candidate["matched_terms"],
                    "snippet": snippet,
                    "source_ids": live_page["source_ids"],
                }
            )
        return results

    async def rebuild_indexes(self) -> dict[str, Any]:
        """Reconstruct backlink and BM25 lexical indexes strictly from committed pages."""
        live_revisions: list[WikiPageRevision] = []
        for head_path in await self._list_all_paths("wiki/v1/heads"):
            raw_head, _ = await self._read_json(head_path)
            if raw_head is None:
                continue
            effective_head, _ = await self._resolve_effective_head(raw_head)
            if effective_head is None or effective_head.get("state") == "trashed":
                continue
            page_key = self._head_key(effective_head)
            rev_id = self._revision_id_for(effective_head, int(effective_head["revision"]))
            rev_doc = await self._read_revision_with_key(rev_id, page_key=page_key)
            live_revisions.append(rev_doc)

        graph = BacklinkGraph.from_pages(live_revisions)
        lexical = LexicalSearchIndex.from_pages(live_revisions)

        for name, obj in (("backlinks", graph), ("lexical", lexical)):
            path = self._index_path(name)
            for _ in range(4):
                _, gen = await self._read_json(path)
                payload = obj.to_dict()
                payload.pop("format", None)
                try:
                    await self._write_json(path, payload, gen)
                    break
                except WikiRefused as exc:
                    if exc.code != "WIKI_REVISION_CONFLICT":
                        raise

        return {
            "page_count": len(live_revisions),
            "backlinks_digest": graph.digest(),
            "lexical_digest": lexical.digest(),
        }

    async def export_wiki(self) -> dict[str, Any]:
        """Export an owner-scoped deterministic snapshot with zero encryption key material."""
        await self.check()
        pages: list[dict[str, Any]] = []
        for entry in await self.list_pages():
            pages.append(await self.read_page(entry["page_id"]))

        sources: list[dict[str, Any]] = []
        for source_path in await self._list_all_paths("wiki/v1/sources"):
            raw_source, _ = await self._read_json(source_path)
            if raw_source is not None:
                sources.append(WikiSourceRef.from_mapping(raw_source).to_dict())
        sources.sort(key=lambda item: item["source_id"])

        revisions = [
            WikiPageRevision.build(
                page_id=page["page_id"],
                revision=page["revision"],
                title=page["title"],
                folder=page["folder"],
                tldr=page["tldr"],
                status_as_of=page["status_as_of"],
                body=page["body"],
                claims=page["claims"],
                links=page["links"],
                source_ids=page["source_ids"],
                updated_at=page["updated_at"],
            )
            for page in pages
        ]
        graph = BacklinkGraph.from_pages(revisions)
        bundle = {
            "schema": "hussh.personal_wiki.export.v1",
            "owner": self.owner,
            "account_generation": self.account_generation,
            "library_id": self.library_id,
            "pages": pages,
            "sources": sources,
            "backlinks": graph.to_dict()["outbound"],
        }
        digest = hashlib.sha256(
            json.dumps(bundle, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
                "utf-8"
            )
        ).hexdigest()
        return {**bundle, "export_sha256": digest}
