# Connections — Two-Way Graph, People Directory & Consent Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-way `trusted_connections` graph with a two-way friend-request flow, add a `/connect` people directory with debounced search, surface incoming requests in the Consent Center + Shield guard badge, and restrict location recipients to accepted connections.

**Architecture:** New Postgres tables (`connection_requests`, `connections`) + a `ConnectionsService` own the social graph. On accept we mirror two `trusted_connections` edges so existing location/SOS readers keep working. A FastAPI router (`api/routes/one/connections.py`, Firebase-auth) exposes directory/request/accept endpoints; Next.js proxy routes forward to it; a `ConnectionsService` (TS) + `/connect` page render it. Incoming requests fold into the consent-center pending count so the Shield badge counts them.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy raw SQL (`get_db().execute_raw`), pytest; Next.js App Router / React / TypeScript, vitest, `@testing-library`.

## Global Constraints

- Branch: `feat/connections-two-way-graph` (already created from `origin/main`).
- Commit trailer: end every commit message with `Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>`. Do **NOT** add a `Co-Authored-By: Claude` trailer.
- SQL uses `:param` placeholders (never f-strings) via `get_db().execute_raw(sql, params)`; SELECT results read from `result.data` (list of dicts).
- Directory queries read from `actor_identity_cache` (has `display_name`, `email`, `photo_url`, `phone_number`, `phone_verified`), NOT `actor_profiles`.
- New backend endpoints authenticate with `require_firebase_auth` (returns `firebase_uid: str`), matching consent-center endpoints — NOT `require_vault_owner_token`.
- Frontend service calls go through `ApiService.apiFetch(path, opts)`; authenticated calls pass `Authorization: Bearer ${idToken}` where `idToken = await user.getIdToken()`.
- Migration files live in `consent-protocol/db/migrations/`, numbered sequentially; wrap in `BEGIN; ... COMMIT;`.
- Do not backfill legacy `trusted_connections` edges into `connections`.
- Backend service tests: instantiate via `Service.__new__(Service)` and patch the module-level `get_db` symbol. Frontend tests: `vi.mock("@/lib/services/api-service", ...)`.

---

## File Structure

**Backend (`consent-protocol/`)**
- Create `db/migrations/081_connections.sql` — new tables + indexes.
- Create `hushh_mcp/services/connections_service.py` — graph persistence + resolution.
- Create `api/routes/one/connections.py` — FastAPI router (Firebase auth).
- Modify `api/routes/one/__init__.py` — register the router.
- Modify `hushh_mcp/services/one_location_agent_service.py:2356` — `list_verified_recipients` eligibility.
- Modify `hushh_mcp/services/connections_chat_service.py` — chat "add" → send request.
- Modify `hushh_mcp/services/consent_center_service.py` — fold connection requests into consents-mode pending count + list.
- Create tests under `tests/services/`.

**Frontend (`hushh-webapp/`)**
- Modify `lib/navigation/routes.ts` — add `ROUTES.CONNECT`.
- Modify `lib/navigation/app-bottom-nav.ts` — scope-aware `connect` action + `/connect` slot recognition.
- Create `app/api/connections/**` — proxy routes.
- Create `lib/services/connections-service.ts` — TS service + types.
- Create `app/connect/page.tsx` + `app/connect/page-client.tsx` — the people directory page.
- Modify `lib/services/consent-center-service.ts` — add `connection_request` to the `kind` union.
- Modify `components/consent/consent-center-page.tsx` — approve/deny branch for connection requests.
- Modify `components/consent/consent-inbox-dropdown.tsx` — preview line for connection requests.
- Create tests under `__tests__/services/`.

---

## Phase 1 — Backend graph core

### Task 1: Migration + `ConnectionsService.create_request` / `list_requests`

**Files:**
- Create: `consent-protocol/db/migrations/081_connections.sql`
- Create: `consent-protocol/hushh_mcp/services/connections_service.py`
- Test: `consent-protocol/tests/services/test_connections_service.py`

**Interfaces:**
- Produces: `ConnectionsService` class with:
  - `create_request(requester_user_id: str, *, addressee_user_id: str | None = None, query: str | None = None, message: str | None = None) -> dict` → `{ "id", "requesterUserId", "addresseeUserId", "status", "message" }`
  - `list_requests(user_id: str, *, direction: str) -> list[dict]` where `direction ∈ {"incoming","outgoing"}`; each item `{ "id", "requesterUserId", "addresseeUserId", "status", "message", "createdAt", "counterpartUserId", "counterpartDisplayName" }`
  - `ConnectionsError(RuntimeError)` with `.code`, `.message`, `.status_code`
  - `IdentityUnresolvedError(ConnectionsError)` with `.candidates: list[dict]`
- Consumes: `db.db_client.get_db`; reuses `OneLocationAgentService().list_verified_recipients` for name resolution (same pattern as `TrustedConnectionsService`).

- [ ] **Step 1: Write the migration**

Create `consent-protocol/db/migrations/081_connections.sql`:

```sql
BEGIN;

-- Two-way connection graph (friend requests + mutual edges).
-- connection_requests: the directional handshake (requester -> addressee).
-- connections: the accepted MUTUAL edge, canonicalized so user_a_id < user_b_id.
-- On accept, the service also mirrors two directional trusted_connections edges
-- (source='connection') so existing location/SOS readers keep working unchanged.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS connection_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id  TEXT NOT NULL,
  addressee_user_id  TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  message            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT connection_requests_no_self
    CHECK (requester_user_id <> addressee_user_id)
);

-- At most one PENDING request per ordered (requester, addressee) pair.
CREATE UNIQUE INDEX IF NOT EXISTS ux_connection_requests_pending
  ON connection_requests (requester_user_id, addressee_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_connection_requests_addressee
  ON connection_requests (addressee_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_requests_requester
  ON connection_requests (requester_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id    TEXT NOT NULL,
  user_b_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  source       TEXT NOT NULL DEFAULT 'request'
    CHECK (source IN ('request', 'circle_invite', 'import')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT connections_canonical_order CHECK (user_a_id < user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_connections_pair
  ON connections (user_a_id, user_b_id);

CREATE INDEX IF NOT EXISTS idx_connections_user_a
  ON connections (user_a_id, status);
CREATE INDEX IF NOT EXISTS idx_connections_user_b
  ON connections (user_b_id, status);

COMMENT ON TABLE connection_requests IS
  'Two-way connection handshake (requester -> addressee). Accepted requests create a connections row + mirrored trusted_connections edges.';
COMMENT ON TABLE connections IS
  'Accepted mutual connections, canonicalized user_a_id < user_b_id.';

COMMIT;
```

- [ ] **Step 2: Write the failing test**

Create `consent-protocol/tests/services/test_connections_service.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.connections_service import (
    ConnectionsError,
    ConnectionsService,
)


def _svc():
    return ConnectionsService.__new__(ConnectionsService)


def _db_returning(rows):
    """Mock get_db() whose execute_raw returns the given rows for every call."""
    db = SimpleNamespace(execute_raw=lambda sql, params=None: SimpleNamespace(data=rows))
    return lambda: db


def test_create_request_inserts_pending_with_explicit_id():
    svc = _svc()
    with patch(
        "hushh_mcp.services.connections_service.get_db",
        _db_returning([{"id": "req-1"}]),
    ):
        out = svc.create_request(
            "user-a", addressee_user_id="user-b", message="hi"
        )
    assert out["id"] == "req-1"
    assert out["requesterUserId"] == "user-a"
    assert out["addresseeUserId"] == "user-b"
    assert out["status"] == "pending"


def test_create_request_rejects_self():
    svc = _svc()
    with pytest.raises(ConnectionsError) as exc:
        svc.create_request("user-a", addressee_user_id="user-a")
    assert exc.value.code == "CONNECTION_NO_SELF"


def test_create_request_requires_identifier():
    svc = _svc()
    with pytest.raises(ConnectionsError) as exc:
        svc.create_request("user-a")
    assert exc.value.status_code == 422
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hushh_mcp.services.connections_service'`.

- [ ] **Step 4: Implement `connections_service.py` (create_request + list_requests)**

Create `consent-protocol/hushh_mcp/services/connections_service.py`:

```python
"""Two-way connection graph: request -> accept/reject handshake.

Requests are directional (requester -> addressee). Accepting creates a mutual
`connections` row (canonicalized user_a_id < user_b_id) AND mirrors two
directional `trusted_connections` edges (source='connection') so existing
location/SOS readers keep working. Identity name-resolution reuses the SAME
platform directory Location shows (list_verified_recipients), read-only.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from db.db_client import get_db

logger = logging.getLogger(__name__)


class ConnectionsError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class IdentityUnresolvedError(ConnectionsError):
    def __init__(self, message: str, *, candidates: list[dict[str, Any]]) -> None:
        super().__init__("CONNECTION_IDENTITY_UNRESOLVED", message, status_code=409)
        self.candidates = candidates


def _default_directory_lookup(owner_user_id: str) -> list[dict[str, Any]]:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    return OneLocationAgentService().list_verified_recipients(owner_user_id=owner_user_id)


class ConnectionsService:
    def __init__(
        self,
        *,
        directory_lookup: Callable[[str], list[dict[str, Any]]] | None = None,
    ) -> None:
        self._directory_lookup = directory_lookup or _default_directory_lookup

    # ---- DB seam ----
    def _execute_one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        result = get_db().execute_raw(sql, params or {})
        return result.data[0] if result.data else None

    def _execute_many(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = get_db().execute_raw(sql, params or {})
        return result.data or []

    # ---- Resolution ----
    def _resolve_query(self, owner_user_id: str, query: str) -> str:
        needle = (query or "").strip().lower()
        if not needle:
            raise ConnectionsError("CONNECTION_QUERY_EMPTY", "No name given to look up.", status_code=422)
        people = self._directory_lookup(owner_user_id) or []
        matches = [p for p in people if needle in str(p.get("displayName") or "").strip().lower()]
        if len(matches) == 1:
            return str(matches[0].get("userId") or "")
        raise IdentityUnresolvedError(
            f"Could not uniquely resolve '{query}' in your directory.",
            candidates=matches,
        )

    # ---- Writes ----
    def create_request(
        self,
        requester_user_id: str,
        *,
        addressee_user_id: str | None = None,
        query: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        requester_user_id = (requester_user_id or "").strip()
        if not requester_user_id:
            raise ConnectionsError("CONNECTION_REQUESTER_MISSING", "Missing requester id.", status_code=422)

        if addressee_user_id:
            target = addressee_user_id.strip()
        elif query:
            target = self._resolve_query(requester_user_id, query)
        else:
            raise ConnectionsError(
                "CONNECTION_IDENTIFIER_MISSING",
                "Provide an addressee_user_id or a name query.",
                status_code=422,
            )

        if not target:
            raise ConnectionsError("CONNECTION_TARGET_MISSING", "Resolved an empty user id.", status_code=422)
        if target == requester_user_id:
            raise ConnectionsError("CONNECTION_NO_SELF", "You cannot connect with yourself.", status_code=422)

        # Idempotent: if a pending request already exists (either direction), return it.
        existing = self._execute_one(
            """
            SELECT id, requester_user_id, addressee_user_id, status, message
            FROM connection_requests
            WHERE status = 'pending'
              AND (
                (requester_user_id = :a AND addressee_user_id = :b)
                OR (requester_user_id = :b AND addressee_user_id = :a)
              )
            LIMIT 1
            """,
            {"a": requester_user_id, "b": target},
        )
        if existing:
            return {
                "id": existing.get("id"),
                "requesterUserId": existing.get("requester_user_id"),
                "addresseeUserId": existing.get("addressee_user_id"),
                "status": existing.get("status"),
                "message": existing.get("message"),
            }

        row = self._execute_one(
            """
            INSERT INTO connection_requests (
              requester_user_id, addressee_user_id, status, message, created_at, updated_at
            )
            VALUES (:requester, :addressee, 'pending', :message, NOW(), NOW())
            RETURNING id
            """,
            {"requester": requester_user_id, "addressee": target, "message": message},
        )
        return {
            "id": (row or {}).get("id"),
            "requesterUserId": requester_user_id,
            "addresseeUserId": target,
            "status": "pending",
            "message": message,
        }

    # ---- Reads ----
    def list_requests(self, user_id: str, *, direction: str) -> list[dict[str, Any]]:
        user_id = (user_id or "").strip()
        if direction == "incoming":
            where = "cr.addressee_user_id = :user_id"
            counterpart_col = "cr.requester_user_id"
        else:
            where = "cr.requester_user_id = :user_id"
            counterpart_col = "cr.addressee_user_id"
        rows = self._execute_many(
            f"""
            SELECT cr.id, cr.requester_user_id, cr.addressee_user_id, cr.status,
                   cr.message, cr.created_at,
                   {counterpart_col} AS counterpart_user_id,
                   a.display_name AS counterpart_display_name
            FROM connection_requests cr
            LEFT JOIN actor_identity_cache a ON a.user_id = {counterpart_col}
            WHERE {where} AND cr.status = 'pending'
            ORDER BY cr.created_at DESC
            """,
            {"user_id": user_id},
        )
        return [
            {
                "id": str(r.get("id") or ""),
                "requesterUserId": str(r.get("requester_user_id") or ""),
                "addresseeUserId": str(r.get("addressee_user_id") or ""),
                "status": str(r.get("status") or ""),
                "message": r.get("message"),
                "createdAt": r.get("created_at"),
                "counterpartUserId": str(r.get("counterpart_user_id") or ""),
                "counterpartDisplayName": r.get("counterpart_display_name"),
            }
            for r in rows
        ]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py -v`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/db/migrations/081_connections.sql \
        consent-protocol/hushh_mcp/services/connections_service.py \
        consent-protocol/tests/services/test_connections_service.py
git commit -m "feat(connections): add connection tables + create/list requests

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 2: `accept` / `reject` / `cancel` with mutual edge + trusted mirror

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_service.py`
- Test: `consent-protocol/tests/services/test_connections_service.py`

**Interfaces:**
- Produces:
  - `accept_request(user_id: str, request_id: str) -> dict` → `{ "status": "accepted", "connectionId", "requestId" }`. Only the addressee may accept. Creates the canonical `connections` row and two `trusted_connections` mirror edges. Idempotent.
  - `reject_request(user_id: str, request_id: str) -> dict` → `{ "status": "rejected", "requestId" }` (addressee only).
  - `cancel_request(user_id: str, request_id: str) -> dict` → `{ "status": "cancelled", "requestId" }` (requester only).
  - Private `_canonical_pair(x, y) -> tuple[str, str]` returning `(min, max)` by string order.

- [ ] **Step 1: Write the failing tests**

Append to `consent-protocol/tests/services/test_connections_service.py`:

```python
class _RecordingDB:
    """Captures every (sql, params) and returns queued rows per call."""

    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params or {}))
        rows = self._results.pop(0) if self._results else []
        return SimpleNamespace(data=rows)


def test_accept_creates_connection_and_two_trusted_edges():
    svc = _svc()
    # 1) load request row -> addressee is user-b (the acceptor)
    # 2) insert connections -> returns id
    # 3) insert trusted edge a->b
    # 4) insert trusted edge b->a
    # 5) update request -> accepted
    db = _RecordingDB(
        [
            [{"id": "req-1", "requester_user_id": "user-a", "addressee_user_id": "user-b", "status": "pending"}],
            [{"id": "conn-1"}],
            [{"id": "tc-1"}],
            [{"id": "tc-2"}],
            [{"id": "req-1"}],
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.accept_request("user-b", "req-1")
    assert out["status"] == "accepted"
    assert out["connectionId"] == "conn-1"
    # Two trusted_connections INSERTs happened.
    trusted_inserts = [c for c in db.calls if "INSERT INTO trusted_connections" in c[0]]
    assert len(trusted_inserts) == 2


def test_accept_rejected_when_not_addressee():
    svc = _svc()
    db = _RecordingDB(
        [[{"id": "req-1", "requester_user_id": "user-a", "addressee_user_id": "user-b", "status": "pending"}]]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        with pytest.raises(ConnectionsError) as exc:
            svc.accept_request("user-c", "req-1")
    assert exc.value.status_code == 403


def test_cancel_rejected_when_not_requester():
    svc = _svc()
    db = _RecordingDB(
        [[{"id": "req-1", "requester_user_id": "user-a", "addressee_user_id": "user-b", "status": "pending"}]]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        with pytest.raises(ConnectionsError) as exc:
            svc.cancel_request("user-b", "req-1")
    assert exc.value.status_code == 403
```

- [ ] **Step 2: Run to verify failure**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py -k "accept or cancel" -v`
Expected: FAIL with `AttributeError: 'ConnectionsService' object has no attribute 'accept_request'`.

- [ ] **Step 3: Implement accept/reject/cancel**

Append these methods to `ConnectionsService` in `connections_service.py`:

```python
    @staticmethod
    def _canonical_pair(x: str, y: str) -> tuple[str, str]:
        return (x, y) if x < y else (y, x)

    def _load_request(self, request_id: str) -> dict[str, Any]:
        row = self._execute_one(
            """
            SELECT id, requester_user_id, addressee_user_id, status
            FROM connection_requests
            WHERE id = :id
            LIMIT 1
            """,
            {"id": (request_id or "").strip()},
        )
        if not row:
            raise ConnectionsError("CONNECTION_REQUEST_NOT_FOUND", "Request not found.", status_code=404)
        return row

    def _mirror_trusted_edge(self, owner: str, trusted: str) -> None:
        self._execute_one(
            """
            INSERT INTO trusted_connections (
              owner_user_id, trusted_user_id, status, source, created_at, updated_at
            )
            VALUES (:owner, :trusted, 'active', 'connection', NOW(), NOW())
            ON CONFLICT (owner_user_id, trusted_user_id) DO UPDATE SET
              status = 'active', revoked_at = NULL, updated_at = NOW(), source = 'connection'
            RETURNING id
            """,
            {"owner": owner, "trusted": trusted},
        )

    def accept_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("addressee_user_id")) != user_id:
            raise ConnectionsError("CONNECTION_NOT_ADDRESSEE", "Only the addressee can accept.", status_code=403)
        if str(req.get("status")) == "accepted":
            return {"status": "accepted", "requestId": req.get("id"), "connectionId": None}
        if str(req.get("status")) != "pending":
            raise ConnectionsError("CONNECTION_NOT_PENDING", "Request is no longer pending.", status_code=409)

        requester = str(req.get("requester_user_id"))
        user_a, user_b = self._canonical_pair(requester, user_id)
        conn = self._execute_one(
            """
            INSERT INTO connections (user_a_id, user_b_id, status, source, created_at, updated_at)
            VALUES (:a, :b, 'active', 'request', NOW(), NOW())
            ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
              status = 'active', revoked_at = NULL, updated_at = NOW()
            RETURNING id
            """,
            {"a": user_a, "b": user_b},
        )
        # Mirror both directional trusted edges so location/SOS readers keep working.
        self._mirror_trusted_edge(requester, user_id)
        self._mirror_trusted_edge(user_id, requester)
        self._execute_one(
            """
            UPDATE connection_requests
            SET status = 'accepted', responded_at = NOW(), updated_at = NOW()
            WHERE id = :id
            RETURNING id
            """,
            {"id": req.get("id")},
        )
        return {"status": "accepted", "requestId": req.get("id"), "connectionId": (conn or {}).get("id")}

    def reject_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("addressee_user_id")) != user_id:
            raise ConnectionsError("CONNECTION_NOT_ADDRESSEE", "Only the addressee can reject.", status_code=403)
        self._execute_one(
            """
            UPDATE connection_requests
            SET status = 'rejected', responded_at = NOW(), updated_at = NOW()
            WHERE id = :id AND status = 'pending'
            RETURNING id
            """,
            {"id": req.get("id")},
        )
        return {"status": "rejected", "requestId": req.get("id")}

    def cancel_request(self, user_id: str, request_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        req = self._load_request(request_id)
        if str(req.get("requester_user_id")) != user_id:
            raise ConnectionsError("CONNECTION_NOT_REQUESTER", "Only the requester can cancel.", status_code=403)
        self._execute_one(
            """
            UPDATE connection_requests
            SET status = 'cancelled', responded_at = NOW(), updated_at = NOW()
            WHERE id = :id AND status = 'pending'
            RETURNING id
            """,
            {"id": req.get("id")},
        )
        return {"status": "cancelled", "requestId": req.get("id")}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_service.py \
        consent-protocol/tests/services/test_connections_service.py
git commit -m "feat(connections): accept/reject/cancel with mutual edge + trusted mirror

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 3: `search_directory` / `list_connections` / `remove_connection`

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_service.py`
- Test: `consent-protocol/tests/services/test_connections_service.py`

**Interfaces:**
- Produces:
  - `search_directory(user_id: str, *, query: str | None = None, page: int = 1, limit: int = 20) -> dict` → `{ "items": [ { "userId", "displayName", "photoUrl", "email", "relationship" } ], "page", "hasMore" }` where `relationship ∈ {"none","pending_outgoing","pending_incoming","connected"}`.
  - `list_connections(user_id: str) -> list[dict]` → `[ { "connectionId", "userId", "displayName", "photoUrl", "createdAt" } ]`.
  - `remove_connection(user_id: str, connection_id: str) -> dict` → `{ "removed": 0|1 }`; also revokes the two mirrored trusted edges.

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```python
def test_search_directory_annotates_relationship_and_excludes_self():
    svc = _svc()
    rows = [
        {"user_id": "user-b", "display_name": "Bob", "photo_url": None, "email": None,
         "rel_out": 1, "rel_in": 0, "connected": 0},
        {"user_id": "user-c", "display_name": "Cara", "photo_url": None, "email": None,
         "rel_out": 0, "rel_in": 0, "connected": 1},
    ]
    with patch("hushh_mcp.services.connections_service.get_db", _db_returning(rows)):
        out = svc.search_directory("user-a", query="", page=1, limit=20)
    by_id = {i["userId"]: i for i in out["items"]}
    assert by_id["user-b"]["relationship"] == "pending_outgoing"
    assert by_id["user-c"]["relationship"] == "connected"


def test_list_connections_maps_rows():
    svc = _svc()
    rows = [{"connection_id": "conn-1", "user_id": "user-b", "display_name": "Bob",
             "photo_url": None, "created_at": "2026-07-09T00:00:00Z"}]
    with patch("hushh_mcp.services.connections_service.get_db", _db_returning(rows)):
        out = svc.list_connections("user-a")
    assert out[0]["userId"] == "user-b"
    assert out[0]["connectionId"] == "conn-1"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py -k "search or list_connections" -v`
Expected: FAIL with `AttributeError: ... 'search_directory'`.

- [ ] **Step 3: Implement the three methods**

Append to `ConnectionsService`:

```python
    def search_directory(
        self, user_id: str, *, query: str | None = None, page: int = 1, limit: int = 20
    ) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        page = max(1, int(page or 1))
        limit = max(1, min(int(limit or 20), 50))
        offset = (page - 1) * limit
        needle = (query or "").strip()
        rows = self._execute_many(
            """
            SELECT
              a.user_id, a.display_name, a.photo_url, a.email,
              EXISTS (
                SELECT 1 FROM connection_requests cr
                WHERE cr.status = 'pending'
                  AND cr.requester_user_id = :user_id AND cr.addressee_user_id = a.user_id
              ) AS rel_out,
              EXISTS (
                SELECT 1 FROM connection_requests cr
                WHERE cr.status = 'pending'
                  AND cr.requester_user_id = a.user_id AND cr.addressee_user_id = :user_id
              ) AS rel_in,
              EXISTS (
                SELECT 1 FROM connections c
                WHERE c.status = 'active'
                  AND ((c.user_a_id = LEAST(:user_id, a.user_id) AND c.user_b_id = GREATEST(:user_id, a.user_id)))
              ) AS connected
            FROM actor_identity_cache a
            WHERE a.user_id <> :user_id
              AND (:needle = '' OR a.display_name ILIKE '%' || :needle || '%'
                   OR a.email ILIKE '%' || :needle || '%')
            ORDER BY COALESCE(a.display_name, a.email, a.user_id), a.user_id
            LIMIT :limit OFFSET :offset
            """,
            {"user_id": user_id, "needle": needle, "limit": limit + 1, "offset": offset},
        )
        has_more = len(rows) > limit
        rows = rows[:limit]

        def relationship(r: dict[str, Any]) -> str:
            if r.get("connected"):
                return "connected"
            if r.get("rel_out"):
                return "pending_outgoing"
            if r.get("rel_in"):
                return "pending_incoming"
            return "none"

        return {
            "items": [
                {
                    "userId": str(r.get("user_id") or ""),
                    "displayName": r.get("display_name"),
                    "photoUrl": r.get("photo_url"),
                    "email": r.get("email"),
                    "relationship": relationship(r),
                }
                for r in rows
            ],
            "page": page,
            "hasMore": has_more,
        }

    def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        user_id = (user_id or "").strip()
        rows = self._execute_many(
            """
            SELECT c.id AS connection_id,
                   CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END AS user_id,
                   a.display_name, a.photo_url, c.created_at
            FROM connections c
            LEFT JOIN actor_identity_cache a
              ON a.user_id = CASE WHEN c.user_a_id = :user_id THEN c.user_b_id ELSE c.user_a_id END
            WHERE c.status = 'active'
              AND (c.user_a_id = :user_id OR c.user_b_id = :user_id)
            ORDER BY c.created_at DESC
            """,
            {"user_id": user_id},
        )
        return [
            {
                "connectionId": str(r.get("connection_id") or ""),
                "userId": str(r.get("user_id") or ""),
                "displayName": r.get("display_name"),
                "photoUrl": r.get("photo_url"),
                "createdAt": r.get("created_at"),
            }
            for r in rows
        ]

    def remove_connection(self, user_id: str, connection_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        row = self._execute_one(
            """
            UPDATE connections
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE id = :id AND status = 'active'
              AND (user_a_id = :user_id OR user_b_id = :user_id)
            RETURNING user_a_id, user_b_id
            """,
            {"id": (connection_id or "").strip(), "user_id": user_id},
        )
        if not row:
            return {"removed": 0}
        # Revoke the two mirrored trusted edges as well.
        self._execute_one(
            """
            UPDATE trusted_connections
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE status = 'active'
              AND ((owner_user_id = :a AND trusted_user_id = :b)
                   OR (owner_user_id = :b AND trusted_user_id = :a))
            RETURNING id
            """,
            {"a": row.get("user_a_id"), "b": row.get("user_b_id")},
        )
        return {"removed": 1}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_service.py \
        consent-protocol/tests/services/test_connections_service.py
git commit -m "feat(connections): directory search, list + remove connection

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 4: FastAPI router + registration

**Files:**
- Create: `consent-protocol/api/routes/one/connections.py`
- Modify: `consent-protocol/api/routes/one/__init__.py`
- Test: `consent-protocol/tests/routes/test_connections_route.py`

**Interfaces:**
- Consumes: `ConnectionsService` (Task 1-3), `require_firebase_auth` from `api.middleware`.
- Produces HTTP endpoints (mounted under router prefix `/api/one`):
  - `GET /connections/directory?query=&page=&limit=` → `{ items, page, hasMore }`
  - `GET /connections` → `{ items }` (list_connections)
  - `GET /connections/requests?direction=incoming|outgoing` → `{ items }`
  - `POST /connections/requests` body `{ addressee_user_id?, query?, message? }` → `{ request }`
  - `POST /connections/requests/{request_id}/accept|reject|cancel` → `{ result }`
  - `DELETE /connections/{connection_id}` → `{ result }`

- [ ] **Step 1: Write the router**

Create `consent-protocol/api/routes/one/connections.py`:

```python
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from api.middleware import require_firebase_auth
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService

router = APIRouter(prefix="/api/one", tags=["Connections"])


def _service() -> ConnectionsService:
    return ConnectionsService()


def _handle(exc: Exception) -> HTTPException:
    if isinstance(exc, ConnectionsError):
        return HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": exc.message})
    return HTTPException(status_code=500, detail="Connections request failed.")


class CreateRequestBody(BaseModel):
    addressee_user_id: str | None = None
    query: str | None = None
    message: str | None = None


@router.get("/connections/directory")
async def connections_directory(
    query: str = Query(default=""),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return _service().search_directory(firebase_uid, query=query, page=page, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections")
async def list_connections(firebase_uid: str = Depends(require_firebase_auth)):
    try:
        return {"items": _service().list_connections(firebase_uid)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.get("/connections/requests")
async def list_connection_requests(
    direction: str = Query(default="incoming", pattern="^(incoming|outgoing)$"),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"items": _service().list_requests(firebase_uid, direction=direction)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests")
async def create_connection_request(
    body: CreateRequestBody,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {
            "request": _service().create_request(
                firebase_uid,
                addressee_user_id=body.addressee_user_id,
                query=body.query,
                message=body.message,
            )
        }
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests/{request_id}/accept")
async def accept_connection_request(
    request_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().accept_request(firebase_uid, request_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests/{request_id}/reject")
async def reject_connection_request(
    request_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().reject_request(firebase_uid, request_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.post("/connections/requests/{request_id}/cancel")
async def cancel_connection_request(
    request_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().cancel_request(firebase_uid, request_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc


@router.delete("/connections/{connection_id}")
async def remove_connection(
    connection_id: str = Path(...),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {"result": _service().remove_connection(firebase_uid, connection_id)}
    except Exception as exc:  # noqa: BLE001
        raise _handle(exc) from exc
```

- [ ] **Step 2: Register the router**

In `consent-protocol/api/routes/one/__init__.py`, add the import alongside the other sub-router imports and add the `include_router` call next to `location_router`:

```python
from api.routes.one.connections import router as connections_router
# ...
router.include_router(location_router)
router.include_router(connections_router)
```

(Match the existing import style in that file — if it imports as `from .location import router as location_router`, use `from .connections import router as connections_router`.)

- [ ] **Step 3: Write the route test**

Create `consent-protocol/tests/routes/test_connections_route.py`:

```python
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one.connections import router


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user-a"
    return TestClient(app)


def test_create_request_returns_request_payload():
    client = _client()
    with patch(
        "api.routes.one.connections.ConnectionsService"
    ) as svc_cls:
        svc_cls.return_value.create_request.return_value = {
            "id": "req-1", "requesterUserId": "user-a",
            "addresseeUserId": "user-b", "status": "pending", "message": None,
        }
        resp = client.post("/api/one/connections/requests", json={"addressee_user_id": "user-b"})
    assert resp.status_code == 200
    assert resp.json()["request"]["id"] == "req-1"


def test_directory_lists_items():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.search_directory.return_value = {"items": [], "page": 1, "hasMore": False}
        resp = client.get("/api/one/connections/directory?query=bo")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "page": 1, "hasMore": False}
```

(If `tests/routes/` does not exist, create it with an empty `__init__.py` to match `tests/services/`.)

- [ ] **Step 4: Run the route test**

Run: `cd consent-protocol && python -m pytest tests/routes/test_connections_route.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/api/routes/one/connections.py \
        consent-protocol/api/routes/one/__init__.py \
        consent-protocol/tests/routes/test_connections_route.py
git commit -m "feat(connections): FastAPI router for directory + request lifecycle

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 5: Restrict location eligibility to connections

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_location_agent_service.py:2356` (`list_verified_recipients`)
- Test: `consent-protocol/tests/services/test_location_recipient_scoping.py`

**Interfaces:**
- No signature change. Behavior: a user is eligible ONLY via an active `trusted_connections` edge (now populated from accepted connections) OR an approved marketplace relationship. The blanket `a.phone_verified = TRUE` clause is removed.

- [ ] **Step 1: Write the failing guard test**

Create `consent-protocol/tests/services/test_location_recipient_scoping.py`:

```python
from types import SimpleNamespace
from unittest.mock import patch

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


class _CapturingDB:
    def __init__(self):
        self.last_sql = None

    def execute_raw(self, sql, params=None):
        self.last_sql = sql
        return SimpleNamespace(data=[])


def test_list_verified_recipients_no_longer_uses_blanket_phone_verified():
    svc = OneLocationAgentService.__new__(OneLocationAgentService)
    db = _CapturingDB()
    with patch("hushh_mcp.services.one_location_agent_service.get_db", lambda: db):
        # _apply_kai_circle_recommendations may call the directory again; empty data is fine.
        svc.list_verified_recipients(owner_user_id="user-a")
    assert "phone_verified = TRUE" not in db.last_sql
    assert "trusted_connections" in db.last_sql
```

- [ ] **Step 2: Run to verify failure**

Run: `cd consent-protocol && python -m pytest tests/services/test_location_recipient_scoping.py -v`
Expected: FAIL — assertion error because `phone_verified = TRUE` is still in the SQL.

- [ ] **Step 3: Edit the query**

In `hushh_mcp/services/one_location_agent_service.py`, inside `list_verified_recipients`, replace the eligibility `AND ( ... )` block so the `OR` branch drops `a.phone_verified = TRUE`. The new `WHERE` eligibility becomes:

```python
        WHERE a.user_id <> :owner_user_id
          AND (
            EXISTS (
              SELECT 1
              FROM trusted_connections tc
              WHERE tc.status = 'active'
                AND tc.owner_user_id = :owner_user_id
                AND tc.trusted_user_id = a.user_id
            )
            OR (
              EXISTS (
                SELECT 1
                FROM advisor_investor_relationships air
                JOIN ria_profiles rp ON rp.id = air.ria_profile_id
                WHERE air.status = 'approved'
                  AND (
                    (air.investor_user_id = :owner_user_id AND rp.user_id = a.user_id)
                    OR (rp.user_id = :owner_user_id AND air.investor_user_id = a.user_id)
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM marketplace_public_profiles mp
                WHERE mp.user_id = a.user_id
                  AND mp.is_discoverable = FALSE
              )
            )
          )
```

(Only the removal of the `a.phone_verified = TRUE OR` line changes; the marketplace branch and everything else stay identical.)

- [ ] **Step 4: Run to verify pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_location_recipient_scoping.py -v`
Expected: PASS.

- [ ] **Step 5: Run the location service test suite (regression)**

Run: `cd consent-protocol && python -m pytest tests/services/ -k location -v`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_location_agent_service.py \
        consent-protocol/tests/services/test_location_recipient_scoping.py
git commit -m "fix(one-location): restrict recipients to connections, drop blanket phone_verified

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 6: Chat agent sends a request instead of auto-adding

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/connections_chat_service.py`
- Test: `consent-protocol/tests/services/test_connections_chat_service.py`

**Interfaces:**
- `ConnectionsChatService.__init__` now depends on `ConnectionsService` (with `create_request`) rather than `TrustedConnectionsService.add_connection`. The "add X" intent calls `create_request(user_id, query=name)`; response text becomes "Sent a connection request to {name}.". Remove/keep list + selection round-trip working against the new service (`create_request` + `IdentityUnresolvedError` still raised by `_resolve_query`).

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_connections_chat_service.py`:

```python
import asyncio
from unittest.mock import MagicMock

from hushh_mcp.services.connections_chat_service import ConnectionsChatService


def test_add_intent_sends_request():
    fake = MagicMock()
    fake.create_request.return_value = {"status": "pending"}
    svc = ConnectionsChatService(service=fake)
    out = asyncio.run(
        svc.handle_turn(user_id="user-a", message="add Priya to my trusted connections")
    )
    fake.create_request.assert_called_once()
    _, kwargs = fake.create_request.call_args
    assert kwargs.get("query") == "Priya"
    assert "request" in out["response"].lower()
    assert out["stateChanged"] is True
```

- [ ] **Step 2: Run to verify failure**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: FAIL (currently `_add` calls `add_connection`, not `create_request`).

- [ ] **Step 3: Update the chat service**

In `connections_chat_service.py`:

1. Replace the import block:

```python
from hushh_mcp.services.connections_service import (
    ConnectionsError,
    ConnectionsService,
    IdentityUnresolvedError,
)
```

2. Update `__init__`:

```python
    def __init__(self, service: ConnectionsService | None = None) -> None:
        self._service = service or ConnectionsService()
```

3. Update `_add`:

```python
    def _add(self, user_id: str, name: str, conv: str) -> dict[str, Any]:
        try:
            self._service.create_request(user_id, query=name)
        except IdentityUnresolvedError as exc:
            if len(exc.candidates) > 1:
                return self._selection_prompt(name, exc.candidates, op="add", conv=conv)
            return self._reply(
                f"I couldn't find “{name}” in your directory yet, so I didn't send a request.",
                conv,
                state_changed=False,
            )
        except ConnectionsError as exc:
            return self._reply(exc.message, conv, state_changed=False)
        return self._reply(
            f"Sent a connection request to {name}.", conv, state_changed=True
        )
```

4. In `_complete_selection`, replace the add branch `self._service.add_connection(user_id, trusted_user_id=trusted_user_id)` with `self._service.create_request(user_id, addressee_user_id=trusted_user_id)` and update its success text to `f"Sent a connection request to {label}."`. Replace `TrustedConnectionsError` references with `ConnectionsError`. For `_remove`/`_list`, if `ConnectionsService` does not expose `remove_connection(user_id, target_user_id)` by name, keep those intents replying that removal now happens from the Connect page (return `self._reply("You can manage connections from the Connect page now.", conv, state_changed=False)`), OR wire `_list` to `self._service.list_connections(user_id)` mapping `displayName`. Use `list_connections` for `_list`:

```python
    def _list(self, user_id: str, conv: str) -> dict[str, Any]:
        rows = self._service.list_connections(user_id)
        if not rows:
            return self._reply("You don't have any connections yet.", conv, state_changed=False)
        names = [str(r.get("displayName") or r.get("userId") or "someone") for r in rows]
        return self._reply("Your connections: " + ", ".join(names) + ".", conv, state_changed=False)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_chat_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/connections_chat_service.py \
        consent-protocol/tests/services/test_connections_chat_service.py
git commit -m "feat(connections): chat 'add' now sends a connection request

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 7: Fold incoming requests into consent pending count + list

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/consent_center_service.py`
- Test: `consent-protocol/tests/services/test_consent_center_connection_requests.py`

**Interfaces:**
- `_get_surface_count(...)` for `mode="consents"`, `surface="pending"` adds the count of incoming pending connection requests (`ConnectionsService.list_requests(user_id, direction="incoming")`).
- `list_center(...)` (investor pending branch) appends each incoming pending connection request as an entry dict with `"kind": "connection_request"`, `"status": "pending"`, `"request_id"`, `"counterpart_label"`, `"counterpart_id"`, `"action": "connection_request"`.

**Note for implementer:** `consent_center_service.py` is large and async. Read `get_center_summary` (~1741), `_get_surface_count` (~1419-1537), and `list_center` (investor pending branch ~1835) before editing. The connection count/entries must appear ONLY for `mode="consents"` (the default the Shield badge reads), not double-counted under `mode="connections"`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_consent_center_connection_requests.py`:

```python
import asyncio
from unittest.mock import MagicMock, patch

from hushh_mcp.services.consent_center_service import ConsentCenterService


def test_consents_pending_count_includes_incoming_connection_requests():
    svc = ConsentCenterService.__new__(ConsentCenterService)

    fake_conn = MagicMock()
    fake_conn.list_requests.return_value = [{"id": "req-1"}, {"id": "req-2"}]

    with patch(
        "hushh_mcp.services.consent_center_service.ConnectionsService",
        return_value=fake_conn,
    ):
        count = asyncio.run(
            svc._incoming_connection_request_count("user-a")
        )
    assert count == 2
    fake_conn.list_requests.assert_called_once_with("user-a", direction="incoming")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd consent-protocol && python -m pytest tests/services/test_consent_center_connection_requests.py -v`
Expected: FAIL — `AttributeError: ... '_incoming_connection_request_count'`.

- [ ] **Step 3: Add the helper + wire into count and list**

In `consent_center_service.py`:

1. Add the import near the other service imports at the top:

```python
from hushh_mcp.services.connections_service import ConnectionsService
```

2. Add a helper method on `ConsentCenterService`:

```python
    async def _incoming_connection_request_count(self, user_id: str) -> int:
        from starlette.concurrency import run_in_threadpool

        rows = await run_in_threadpool(
            ConnectionsService().list_requests, user_id, direction="incoming"
        )
        return len(rows or [])

    async def _incoming_connection_request_entries(self, user_id: str) -> list[dict]:
        from starlette.concurrency import run_in_threadpool

        rows = await run_in_threadpool(
            ConnectionsService().list_requests, user_id, direction="incoming"
        )
        return [
            {
                "id": r.get("id"),
                "request_id": r.get("id"),
                "kind": "connection_request",
                "status": "pending",
                "action": "connection_request",
                "counterpart_type": "self",
                "counterpart_id": r.get("counterpartUserId"),
                "counterpart_label": r.get("counterpartDisplayName") or "Someone",
                "reason": r.get("message") or "wants to connect with you",
            }
            for r in (rows or [])
        ]
```

3. In `_get_surface_count`, inside the `mode="consents"` + `surface="pending"` branch (the `return (...) + location_count` at ~1470-1482), add the connection term:

```python
        connection_count = await self._incoming_connection_request_count(user_id)
        return (
            len(self._collapse_consent_chains(
                self._filter_mode_entries(
                    await self._load_investor_pending_entries(user_id),
                    actor=normalized_actor, mode=normalized_mode,
                )
            ))
            + location_count
            + connection_count
        )
```

4. In `list_center`, in the investor pending branch (~1835), extend the returned entries list with `await self._incoming_connection_request_entries(user_id)` so the Requests tab renders them.

- [ ] **Step 4: Run to verify pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_consent_center_connection_requests.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/consent_center_service.py \
        consent-protocol/tests/services/test_consent_center_connection_requests.py
git commit -m "feat(connections): surface incoming requests in consent pending count + list

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Phase 2 — Next.js proxy routes

### Task 8: Proxy routes for directory, connections list, and requests

**Files:**
- Create: `hushh-webapp/app/api/connections/directory/route.ts`
- Create: `hushh-webapp/app/api/connections/route.ts`
- Create: `hushh-webapp/app/api/connections/requests/route.ts`

**Interfaces:**
- Each route forwards to the Python backend at `${getPythonApiUrl()}/api/one/connections...`, passing through the `Authorization` header and returning JSON verbatim.
- Consumes: `getPythonApiUrl` from `@/app/api/_utils/backend`, request-id helpers from `@/app/api/_utils/request-id`.

- [ ] **Step 1: Create the directory proxy**

Create `hushh-webapp/app/api/connections/directory/route.ts`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const qs = searchParams.toString();
  try {
    const response = await fetch(`${BACKEND_URL}/api/one/connections/directory?${qs}`, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        Authorization: authHeader,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connections_directory error:`, error);
    return withRequestIdJson(requestId, { items: [], page: 1, hasMore: false, degraded: true }, { status: 200 });
  }
}
```

- [ ] **Step 2: Create the connections-list proxy**

Create `hushh-webapp/app/api/connections/route.ts`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  try {
    const response = await fetch(`${BACKEND_URL}/api/one/connections`, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        Authorization: authHeader,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connections_list error:`, error);
    return withRequestIdJson(requestId, { items: [], degraded: true }, { status: 200 });
  }
}
```

- [ ] **Step 3: Create the requests proxy (GET list + POST create)**

Create `hushh-webapp/app/api/connections/requests/route.ts`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const qs = searchParams.toString();
  try {
    const response = await fetch(`${BACKEND_URL}/api/one/connections/requests?${qs}`, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        Authorization: authHeader,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connection_requests_list error:`, error);
    return withRequestIdJson(requestId, { items: [], degraded: true }, { status: 200 });
  }
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const body = await request.text();
  try {
    const response = await fetch(`${BACKEND_URL}/api/one/connections/requests`, {
      method: "POST",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        Authorization: authHeader,
      }),
      body,
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connection_request_create error:`, error);
    return withRequestIdJson(requestId, { error: "Failed to create connection request" }, { status: 502 });
  }
}
```

- [ ] **Step 4: Verify build/typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new type errors in `app/api/connections/**`.
(If `createUpstreamHeaders`/`withRequestIdJson`/`resolveRequestId` names differ, open `app/api/_utils/request-id.ts` and match the exports — the `pending/route.ts` file is the reference.)

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/app/api/connections/directory/route.ts \
        hushh-webapp/app/api/connections/route.ts \
        hushh-webapp/app/api/connections/requests/route.ts
git commit -m "feat(connections): Next proxy routes for directory, list, requests

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 9: Proxy routes for accept / reject / cancel / delete

**Files:**
- Create: `hushh-webapp/app/api/connections/requests/[id]/accept/route.ts`
- Create: `hushh-webapp/app/api/connections/requests/[id]/reject/route.ts`
- Create: `hushh-webapp/app/api/connections/requests/[id]/cancel/route.ts`
- Create: `hushh-webapp/app/api/connections/[id]/route.ts`

**Interfaces:**
- Accept/reject/cancel: `POST` → forwards to `${BACKEND}/api/one/connections/requests/{id}/{action}`.
- Delete: `DELETE` → forwards to `${BACKEND}/api/one/connections/{id}`.
- Next.js 15 route params are async: `context: { params: Promise<{ id: string }> }`.

- [ ] **Step 1: Create the accept route**

Create `hushh-webapp/app/api/connections/requests/[id]/accept/route.ts`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const { id } = await context.params;
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/one/connections/requests/${encodeURIComponent(id)}/accept`,
      {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          Authorization: authHeader,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connection_accept error:`, error);
    return withRequestIdJson(requestId, { error: "Failed to accept request" }, { status: 502 });
  }
}
```

- [ ] **Step 2: Create the reject route**

Create `hushh-webapp/app/api/connections/requests/[id]/reject/route.ts` — identical to the accept route but with the backend path segment `/reject` and error label `connection_reject`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const { id } = await context.params;
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/one/connections/requests/${encodeURIComponent(id)}/reject`,
      {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          Authorization: authHeader,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connection_reject error:`, error);
    return withRequestIdJson(requestId, { error: "Failed to reject request" }, { status: 502 });
  }
}
```

- [ ] **Step 3: Create the cancel route**

Create `hushh-webapp/app/api/connections/requests/[id]/cancel/route.ts` — same shape, backend path segment `/cancel`, error label `connection_cancel`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const { id } = await context.params;
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/one/connections/requests/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          Authorization: authHeader,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connection_cancel error:`, error);
    return withRequestIdJson(requestId, { error: "Failed to cancel request" }, { status: 502 });
  }
}
```

- [ ] **Step 4: Create the delete-connection route**

Create `hushh-webapp/app/api/connections/[id]/route.ts`:

```ts
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return withRequestIdJson(requestId, { error: "Authorization header required" }, { status: 401 });
  }
  const { id } = await context.params;
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/one/connections/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          Authorization: authHeader,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const payload = await response.json().catch(() => ({}));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} connection_remove error:`, error);
    return withRequestIdJson(requestId, { error: "Failed to remove connection" }, { status: 502 });
  }
}
```

- [ ] **Step 5: Verify typecheck & commit**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new type errors.

```bash
git add hushh-webapp/app/api/connections/requests/[id]/accept/route.ts \
        hushh-webapp/app/api/connections/requests/[id]/reject/route.ts \
        hushh-webapp/app/api/connections/requests/[id]/cancel/route.ts \
        hushh-webapp/app/api/connections/[id]/route.ts
git commit -m "feat(connections): Next proxy routes for accept/reject/cancel/delete

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Phase 3 — Frontend service, nav, page, consent UI

### Task 10: `ConnectionsService` (TS) + types

**Files:**
- Create: `hushh-webapp/lib/services/connections-service.ts`
- Test: `hushh-webapp/__tests__/services/connections-service.test.ts`

**Interfaces:**
- Produces `ConnectionsService` (static methods) + types:
  - `DirectoryPerson = { userId: string; displayName: string | null; photoUrl: string | null; email: string | null; relationship: "none" | "pending_outgoing" | "pending_incoming" | "connected" }`
  - `ConnectionSummaryEntry = { connectionId: string; userId: string; displayName: string | null; photoUrl: string | null; createdAt: string | null }`
  - `ConnectionRequest = { id: string; requesterUserId: string; addresseeUserId: string; status: string; message: string | null; counterpartUserId: string; counterpartDisplayName: string | null }`
  - `searchDirectory({ idToken, query, page, limit }): Promise<{ items: DirectoryPerson[]; page: number; hasMore: boolean }>`
  - `listConnections({ idToken }): Promise<ConnectionSummaryEntry[]>`
  - `listRequests({ idToken, direction }): Promise<ConnectionRequest[]>`
  - `sendRequest({ idToken, addresseeUserId, message? }): Promise<void>`
  - `accept({ idToken, requestId }): Promise<void>` / `reject(...)` / `cancel(...)`
  - `removeConnection({ idToken, connectionId }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/services/connections-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import { ConnectionsService } from "@/lib/services/connections-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConnectionsService", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("searchDirectory hits the directory endpoint with query + auth", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({ items: [{ userId: "u2", displayName: "Bo", photoUrl: null, email: null, relationship: "none" }], page: 1, hasMore: false }),
    );
    const out = await ConnectionsService.searchDirectory({ idToken: "tok", query: "bo", page: 1 });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toContain("/api/connections/directory");
    expect(path).toContain("query=bo");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(out.items[0].userId).toBe("u2");
  });

  it("sendRequest POSTs the addressee id", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ request: { id: "r1" } }));
    await ConnectionsService.sendRequest({ idToken: "tok", addresseeUserId: "u2" });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/connections/requests");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ addressee_user_id: "u2", message: undefined });
  });

  it("accept POSTs to the accept endpoint", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ result: { status: "accepted" } }));
    await ConnectionsService.accept({ idToken: "tok", requestId: "r1" });
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe("/api/connections/requests/r1/accept");
    expect(opts.method).toBe("POST");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hushh-webapp && npx vitest run __tests__/services/connections-service.test.ts`
Expected: FAIL — cannot resolve `@/lib/services/connections-service`.

- [ ] **Step 3: Implement the service**

Create `hushh-webapp/lib/services/connections-service.ts`:

```ts
import { ApiService } from "@/lib/services/api-service";

export type ConnectionRelationship =
  | "none"
  | "pending_outgoing"
  | "pending_incoming"
  | "connected";

export interface DirectoryPerson {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  email: string | null;
  relationship: ConnectionRelationship;
}

export interface DirectoryPage {
  items: DirectoryPerson[];
  page: number;
  hasMore: boolean;
}

export interface ConnectionSummaryEntry {
  connectionId: string;
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string | null;
}

export interface ConnectionRequest {
  id: string;
  requesterUserId: string;
  addresseeUserId: string;
  status: string;
  message: string | null;
  counterpartUserId: string;
  counterpartDisplayName: string | null;
}

function authHeaders(idToken: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` };
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string })?.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export class ConnectionsService {
  static async searchDirectory(opts: {
    idToken: string;
    query?: string;
    page?: number;
    limit?: number;
  }): Promise<DirectoryPage> {
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    params.set("page", String(opts.page ?? 1));
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    const response = await ApiService.apiFetch(`/api/connections/directory?${params.toString()}`, {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    return jsonOrThrow<DirectoryPage>(response);
  }

  static async listConnections(opts: { idToken: string }): Promise<ConnectionSummaryEntry[]> {
    const response = await ApiService.apiFetch("/api/connections", {
      method: "GET",
      headers: authHeaders(opts.idToken),
    });
    const payload = await jsonOrThrow<{ items: ConnectionSummaryEntry[] }>(response);
    return payload.items ?? [];
  }

  static async listRequests(opts: {
    idToken: string;
    direction: "incoming" | "outgoing";
  }): Promise<ConnectionRequest[]> {
    const response = await ApiService.apiFetch(
      `/api/connections/requests?direction=${opts.direction}`,
      { method: "GET", headers: authHeaders(opts.idToken) },
    );
    const payload = await jsonOrThrow<{ items: ConnectionRequest[] }>(response);
    return payload.items ?? [];
  }

  static async sendRequest(opts: {
    idToken: string;
    addresseeUserId: string;
    message?: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch("/api/connections/requests", {
      method: "POST",
      headers: authHeaders(opts.idToken),
      body: JSON.stringify({ addressee_user_id: opts.addresseeUserId, message: opts.message }),
    });
    await jsonOrThrow<unknown>(response);
  }

  static async accept(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/connections/requests/${encodeURIComponent(opts.requestId)}/accept`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async reject(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/connections/requests/${encodeURIComponent(opts.requestId)}/reject`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async cancel(opts: { idToken: string; requestId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/connections/requests/${encodeURIComponent(opts.requestId)}/cancel`,
      { method: "POST", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }

  static async removeConnection(opts: { idToken: string; connectionId: string }): Promise<void> {
    const response = await ApiService.apiFetch(
      `/api/connections/${encodeURIComponent(opts.connectionId)}`,
      { method: "DELETE", headers: authHeaders(opts.idToken) },
    );
    await jsonOrThrow<unknown>(response);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd hushh-webapp && npx vitest run __tests__/services/connections-service.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/services/connections-service.ts \
        hushh-webapp/__tests__/services/connections-service.test.ts
git commit -m "feat(connections): TS ConnectionsService client + types

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 11: Scope-aware `/connect` bottom-nav routing

**Files:**
- Modify: `hushh-webapp/lib/navigation/routes.ts`
- Modify: `hushh-webapp/lib/navigation/app-bottom-nav.ts`
- Test: `hushh-webapp/__tests__/navigation/connect-nav.test.ts`

**Interfaces:**
- `ROUTES.CONNECT = "/connect"`.
- `resolveBottomNavAction("connect", "one")` → `{ type: "route", href: "/connect" }`; `resolveBottomNavAction("connect", "investor" | "ria")` → `{ type: "route", href: "/marketplace" }`.
- `/connect` is recognized as the `connect` slot in the "one" scope (active-state highlighting).

- [ ] **Step 1: Add the route constant**

In `hushh-webapp/lib/navigation/routes.ts`, add to the `ROUTES` object (near `MARKETPLACE`, line 47):

```ts
  CONNECT: "/connect",
```

- [ ] **Step 2: Write the failing test**

Create `hushh-webapp/__tests__/navigation/connect-nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { resolveBottomNavAction } from "@/lib/navigation/app-bottom-nav";

describe("connect bottom-nav routing", () => {
  it("routes to /connect in the one scope", () => {
    expect(resolveBottomNavAction("connect", "one")).toEqual({ type: "route", href: "/connect" });
  });

  it("routes to /marketplace in the investor scope", () => {
    expect(resolveBottomNavAction("connect", "investor")).toEqual({ type: "route", href: "/marketplace" });
  });

  it("routes to /marketplace in the ria scope", () => {
    expect(resolveBottomNavAction("connect", "ria")).toEqual({ type: "route", href: "/marketplace" });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd hushh-webapp && npx vitest run __tests__/navigation/connect-nav.test.ts`
Expected: FAIL — one-scope case returns `/marketplace`.

- [ ] **Step 4: Make the connect action scope-aware**

In `hushh-webapp/lib/navigation/app-bottom-nav.ts`, change the `case "connect"` in `resolveBottomNavAction` (line 316-317) to:

```ts
    case "connect":
      return {
        type: "route",
        href: scope === "one" ? ROUTES.CONNECT : ROUTES.MARKETPLACE,
      };
```

Then update `resolveOneNavSlot` (the `MARKETPLACE` check at lines 116-118) and `resolveOneActiveNav` (lines 159-161) so `/connect` maps to the `connect` slot. In BOTH functions, add before the existing `ROUTES.MARKETPLACE` branch:

```ts
  if (isBottomNavRoute(normalizedPathname, ROUTES.CONNECT)) {
    return "connect";
  }
```

Also add `/connect` to `isCommonBottomNavRoute` (lines 54-60) so scope persistence works on the new page:

```ts
export function isCommonBottomNavRoute(pathname: string | null | undefined): boolean {
  const normalizedPathname = normalizeBottomNavPathname(pathname);
  return (
    isBottomNavRoute(normalizedPathname, ROUTES.MARKETPLACE) ||
    isBottomNavRoute(normalizedPathname, ROUTES.CONNECT) ||
    isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd hushh-webapp && npx vitest run __tests__/navigation/connect-nav.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/navigation/routes.ts \
        hushh-webapp/lib/navigation/app-bottom-nav.ts \
        hushh-webapp/__tests__/navigation/connect-nav.test.ts
git commit -m "feat(connections): scope-aware Connect tab -> /connect in one scope

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 12: `/connect` people directory page

**Files:**
- Create: `hushh-webapp/app/connect/page.tsx`
- Create: `hushh-webapp/app/connect/page-client.tsx`
- Create: `hushh-webapp/lib/connections/relationship-label.ts`
- Test: `hushh-webapp/__tests__/connections/relationship-label.test.ts`

**Interfaces:**
- Produces `relationshipCta(relationship: ConnectionRelationship): { label: string; disabled: boolean; action: "connect" | "respond" | "none" }` — pure helper used by the page and unit-tested.
- Page uses `useAuth()`, `useDebouncedValue`, and `ConnectionsService`.

- [ ] **Step 1: Write the failing test for the CTA helper**

Create `hushh-webapp/__tests__/connections/relationship-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { relationshipCta } from "@/lib/connections/relationship-label";

describe("relationshipCta", () => {
  it("offers Connect when there is no relationship", () => {
    expect(relationshipCta("none")).toEqual({ label: "Connect", disabled: false, action: "connect" });
  });
  it("shows Requested and disables when outgoing pending", () => {
    expect(relationshipCta("pending_outgoing")).toEqual({ label: "Requested", disabled: true, action: "none" });
  });
  it("prompts Respond when incoming pending", () => {
    expect(relationshipCta("pending_incoming")).toEqual({ label: "Respond", disabled: false, action: "respond" });
  });
  it("shows Connected and disables when connected", () => {
    expect(relationshipCta("connected")).toEqual({ label: "Connected", disabled: true, action: "none" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd hushh-webapp && npx vitest run __tests__/connections/relationship-label.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement the CTA helper**

Create `hushh-webapp/lib/connections/relationship-label.ts`:

```ts
import type { ConnectionRelationship } from "@/lib/services/connections-service";

export interface RelationshipCta {
  label: string;
  disabled: boolean;
  action: "connect" | "respond" | "none";
}

export function relationshipCta(relationship: ConnectionRelationship): RelationshipCta {
  switch (relationship) {
    case "connected":
      return { label: "Connected", disabled: true, action: "none" };
    case "pending_outgoing":
      return { label: "Requested", disabled: true, action: "none" };
    case "pending_incoming":
      return { label: "Respond", disabled: false, action: "respond" };
    default:
      return { label: "Connect", disabled: false, action: "connect" };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd hushh-webapp && npx vitest run __tests__/connections/relationship-label.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Create the server page wrapper**

Create `hushh-webapp/app/connect/page.tsx`:

```tsx
import { Suspense } from "react";

import ConnectPageClient from "./page-client";

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectPageClient />
    </Suspense>
  );
}
```

- [ ] **Step 6: Create the client page**

Create `hushh-webapp/app/connect/page-client.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useRequireAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import {
  ConnectionsService,
  type ConnectionSummaryEntry,
  type DirectoryPerson,
} from "@/lib/services/connections-service";
import { relationshipCta } from "@/lib/connections/relationship-label";

export default function ConnectPageClient() {
  const { user } = useRequireAuth();
  const router = useRouter();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);

  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [connections, setConnections] = useState<ConnectionSummaryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      setConnections(await ConnectionsService.listConnections({ idToken }));
    } catch {
      /* non-fatal: connections section stays empty */
    }
  }, [user]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user) return;
      try {
        setLoading(true);
        setError(null);
        const idToken = await user.getIdToken();
        const page = await ConnectionsService.searchDirectory({ idToken, query: debouncedQuery, page: 1 });
        if (!cancelled) setPeople(page.items);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load people");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, debouncedQuery]);

  const handleConnect = useCallback(
    async (person: DirectoryPerson) => {
      if (!user) return;
      const cta = relationshipCta(person.relationship);
      if (cta.action === "respond") {
        router.push(buildConsentCenterHref("pending"));
        return;
      }
      if (cta.action !== "connect") return;
      try {
        setBusyId(person.userId);
        const idToken = await user.getIdToken();
        await ConnectionsService.sendRequest({ idToken, addresseeUserId: person.userId });
        setPeople((prev) =>
          prev.map((p) =>
            p.userId === person.userId ? { ...p, relationship: "pending_outgoing" } : p,
          ),
        );
        toast.success("Connection request sent");
      } catch (sendError) {
        toast.error(sendError instanceof Error ? sendError.message : "Failed to send request");
      } finally {
        setBusyId(null);
      }
    },
    [router, user],
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">Connect</h1>
        <p className="text-sm text-muted-foreground">Find people on Hushh and send a connection request.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          My connections ({connections.length})
        </h2>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no connections yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connections.map((c) => (
              <li key={c.connectionId} className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                <span className="text-sm font-medium text-foreground">{c.displayName || c.userId}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">People</h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people by name or email"
          aria-label="Search people"
          className="min-h-11 w-full rounded-full border border-border bg-background px-4 text-sm text-foreground"
        />
        {loading ? <p className="text-sm text-muted-foreground">Searching…</p> : null}
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        {!loading && !error && people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No people found.</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {people.map((person) => {
            const cta = relationshipCta(person.relationship);
            return (
              <li key={person.userId} className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                <span className="text-sm font-medium text-foreground">{person.displayName || person.email || person.userId}</span>
                <button
                  type="button"
                  disabled={cta.disabled || busyId === person.userId}
                  onClick={() => void handleConnect(person)}
                  className="inline-flex min-h-9 items-center justify-center rounded-full bg-foreground px-4 text-xs font-medium text-background disabled:opacity-50"
                >
                  {busyId === person.userId ? "Sending…" : cta.label}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
```

- [ ] **Step 7: Verify typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new type errors.
(If `buildConsentCenterHref` is exported from a different module, match the import used by `app-bottom-nav.ts` line 3: `@/lib/consent/consent-sheet-route`.)

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/app/connect/page.tsx \
        hushh-webapp/app/connect/page-client.tsx \
        hushh-webapp/lib/connections/relationship-label.ts \
        hushh-webapp/__tests__/connections/relationship-label.test.ts
git commit -m "feat(connections): /connect people directory with debounced search

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 13: Consent UI — render + act on connection requests

**Files:**
- Modify: `hushh-webapp/lib/services/consent-center-service.ts` (extend `kind` union)
- Modify: `hushh-webapp/components/consent/consent-center-page.tsx` (approve/deny branch)
- Modify: `hushh-webapp/components/consent/consent-inbox-dropdown.tsx` (preview line)
- Test: `hushh-webapp/__tests__/consent/connection-request-entry.test.ts`

**Interfaces:**
- Consumes: `ConnectionsService.accept` / `.reject` (Task 10), the `connection_request` entry kind from backend (Task 7).
- Produces: a pure classifier `isConnectionRequestEntry(entry): boolean` in `consent-center-page.tsx` used to dispatch approve/deny to `ConnectionsService`.

- [ ] **Step 1: Extend the entry kind union**

In `hushh-webapp/lib/services/consent-center-service.ts`, extend the `ConsentCenterEntry["kind"]` union (lines 26-31) to add `"connection_request"`:

```ts
  kind:
    | "incoming_request"
    | "outgoing_request"
    | "active_grant"
    | "history"
    | "invite"
    | "connection_request";
```

- [ ] **Step 2: Write the failing test for the classifier**

Create `hushh-webapp/__tests__/consent/connection-request-entry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { isConnectionRequestEntry } from "@/components/consent/connection-request-entry";

describe("isConnectionRequestEntry", () => {
  it("is true for connection_request kind", () => {
    expect(isConnectionRequestEntry({ kind: "connection_request" })).toBe(true);
  });
  it("is false for other kinds", () => {
    expect(isConnectionRequestEntry({ kind: "incoming_request" })).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd hushh-webapp && npx vitest run __tests__/consent/connection-request-entry.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 4: Create the classifier module**

Create `hushh-webapp/components/consent/connection-request-entry.ts`:

```ts
export function isConnectionRequestEntry(entry: { kind?: string | null }): boolean {
  return entry?.kind === "connection_request";
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd hushh-webapp && npx vitest run __tests__/consent/connection-request-entry.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 6: Wire the classifier into approve/deny dispatch**

In `components/consent/consent-center-page.tsx`:

1. Import the classifier and the service near the other imports:

```tsx
import { isConnectionRequestEntry } from "@/components/consent/connection-request-entry";
import { ConnectionsService } from "@/lib/services/connections-service";
import { useAuth } from "@/hooks/use-auth";
```

(If `useAuth` is already imported, skip that line.)

2. In `approveEntry` (lines 1405-1424), add a branch at the TOP of the callback body (before the location/marketplace branches):

```tsx
    if (isConnectionRequestEntry(entry)) {
      void (async () => {
        if (!user) return;
        try {
          const idToken = await user.getIdToken();
          await ConnectionsService.accept({ idToken, requestId: entry.request_id || entry.id });
          window.dispatchEvent(new CustomEvent("consent-action-complete"));
        } catch (e) {
          /* toast handled by caller UI */
        }
      })();
      return;
    }
```

3. In `denyEntry` (lines 1425-1444), add the mirror branch calling `ConnectionsService.reject({ idToken, requestId: entry.request_id || entry.id })`.

(`user` comes from `useAuth()`; if the component does not already have it, add `const { user } = useAuth();` near the other hooks. The `consent-action-complete` event name must match `CONSENT_ACTION_COMPLETE_EVENT` in `lib/consent/consent-events.ts` — import and dispatch that constant instead of the string literal if it is exported, e.g. `dispatchConsentActionComplete()`.)

- [ ] **Step 7: Add the dropdown preview line**

In `components/consent/consent-inbox-dropdown.tsx`, in the `entrySummary` function (line ~51), add before the final `return`:

```ts
  if (entry.kind === "connection_request") return "Wants to connect with you.";
```

- [ ] **Step 8: Verify typecheck + full frontend test run**

Run: `cd hushh-webapp && npx tsc --noEmit && npx vitest run __tests__/consent __tests__/connections __tests__/navigation __tests__/services/connections-service.test.ts`
Expected: no type errors; all listed tests PASS.

- [ ] **Step 9: Commit**

```bash
git add hushh-webapp/lib/services/consent-center-service.ts \
        hushh-webapp/components/consent/consent-center-page.tsx \
        hushh-webapp/components/consent/consent-inbox-dropdown.tsx \
        hushh-webapp/components/consent/connection-request-entry.ts \
        hushh-webapp/__tests__/consent/connection-request-entry.test.ts
git commit -m "feat(connections): render + accept/deny connection requests in consent center

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Phase 4 — End-to-end verification

### Task 14: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Backend test suite**

Run: `cd consent-protocol && python -m pytest tests/services/test_connections_service.py tests/routes/test_connections_route.py tests/services/test_connections_chat_service.py tests/services/test_location_recipient_scoping.py tests/services/test_consent_center_connection_requests.py -v`
Expected: all PASS.

- [ ] **Step 2: Frontend test + typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit && npx vitest run __tests__/connections __tests__/navigation __tests__/consent __tests__/services/connections-service.test.ts`
Expected: no type errors; all PASS.

- [ ] **Step 3: Lint**

Run: `cd hushh-webapp && npx next lint --dir app/connect --dir lib/connections --dir lib/services 2>&1 | tail -20`
Expected: no new errors in the new files. (Match the repo's lint command if `next lint` is not configured; fall back to `npm run lint` if present.)

- [ ] **Step 4: Manual E2E via the run/verify skill**

Use the `verify` skill (or `run`) to drive the app: sign in as user A, open the Connect tab (default scope) → `/connect`, search for user B (debounce), tap Connect. Sign in as user B → confirm the Shield badge count incremented and the Requests tab shows "Wants to connect with you." Tap Allow → confirm both users now appear in each other's "My connections" and that user B is now an eligible location recipient for user A (location share picker). Document results.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(connections): end-to-end verification fixes

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** Directory+search → Tasks 8/10/12. Two-way graph → Tasks 1-4. Consent surfacing + guard badge → Tasks 7/13. Location eligibility fix → Task 5. Chat agent → Task 6. Nav split → Task 11. Full-stack → all phases. ✅
- **`connection_request` kind** is defined in the backend (Task 7) and the frontend union (Task 13) with the same string — keep them in sync.
- **Trusted mirror** is written on accept (Task 2) and revoked on remove (Task 3); the location fix (Task 5) reads `trusted_connections`, so accepted connections become eligible recipients and removed ones stop being eligible. ✅
- **Auth:** every new backend endpoint uses `require_firebase_auth`; every proxy passes `Authorization` through; every TS call sends `Bearer ${idToken}`. ✅
- If any referenced helper name (`createUpstreamHeaders`, `buildConsentCenterHref`, `CONSENT_ACTION_COMPLETE_EVENT`, consent-center method line numbers) has drifted, open the cited reference file and match the current export before implementing — do not invent names.
