# Connections-Scoped Location Recipients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope One Location recipients (the "Ready people" list and all quick-action pickers) to the user's accepted connections only, with an empty-state prompt when there are none.

**Architecture:** Swap the recipient source at a single backend seam — `list_verified_recipients` — from the broad verified-actor directory to the active `connections` graph. Add an opt-in connection guard on the direct-share route (`POST /location/grants`) while leaving the request-approval / public-invite grant path untouched. On the frontend, simplify the quick-action recipient selection to use the (now connection-scoped) ranked recipients, and add an "Add connections" empty state that links to `/connect`.

**Tech Stack:** Python (FastAPI service + psycopg SQL), pytest with in-memory probe services; Next.js / React, TypeScript, Tailwind, Vitest + React Testing Library.

## Global Constraints

- Recipient object shape (`OneLocationRecipient`) MUST NOT change — frontend types stay as-is.
- The `connections → trusted_connections` mirror stays in place (SOS/network payloads still read it). Do not remove it.
- Existing active share grants and public-invite links MUST keep working — the change governs *who you can newly pick*, not who is currently sharing.
- Empty-state copy (exact): title `Build your trusted circle`, description `Add connections so the people you trust can receive your live location.`, button label `Add connections`, link target `/connect`.
- Error for a blocked non-connection share: code `LOCATION_RECIPIENT_NOT_CONNECTED`, message `You can only share your live location with your connections.`, HTTP status `403`.
- Connection membership is canonical/undirected: an active row in `connections` where the owner is `user_a_id` OR `user_b_id` and `status = 'active'`.

---

### Task 1: Backend — source recipient directory from `connections`

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_location_agent_service.py:2423-2492` (`list_verified_recipients`)
- Test: `consent-protocol/tests/services/test_one_location_agent_service.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `list_verified_recipients(*, owner_user_id: str, limit: int = 50) -> list[dict]` — unchanged signature; now returns only the owner's active connections (each still passed through `_recipient_payload` and `_apply_kai_circle_recommendations`, so the object shape is identical).

- [ ] **Step 1: Update the in-memory test service to model the `connections` table**

In `test_one_location_agent_service.py`, in `FourUserMemoryService.__init__` (near line 237-238, alongside `self.network_connections` / `self.trusted_connections`), add a connections store:

```python
        self.connections: dict[str, dict] = {}
```

Add a seeding helper method on `FourUserMemoryService` (place it right after `__init__`):

```python
    def _seed_connection(self, owner: str, other: str, *, status: str = "active") -> None:
        a, b = sorted((owner, other))
        self.connections[f"{a}:{b}"] = {
            "id": f"conn-{a}-{b}",
            "user_a_id": a,
            "user_b_id": b,
            "status": status,
        }
```

- [ ] **Step 2: Replace the recipient-directory branch in the memory service `_execute_many`**

In `FourUserMemoryService._execute_many`, replace the entire `if "FROM actor_identity_cache a" in sql:` block (currently lines ~302-355) with a connections-sourced branch:

```python
        if "FROM connections c" in sql and "one_location_recipient_keys" in sql:
            owner = params["owner_user_id"]
            connected_ids = {
                (conn["user_b_id"] if conn["user_a_id"] == owner else conn["user_a_id"])
                for conn in self.connections.values()
                if conn.get("status") == "active"
                and owner in {conn["user_a_id"], conn["user_b_id"]}
            }
            rows = []
            for user_id in sorted(connected_ids):
                identity = self.identities.get(user_id)
                if not identity:
                    continue
                key = self._active_key(user_id)
                rows.append(
                    {
                        **identity,
                        "key_id": key["key_id"] if key else None,
                        "public_key_jwk": key["public_key_jwk"] if key else None,
                        "algorithm": key["algorithm"] if key else None,
                        "key_created_at": key["created_at"] if key else None,
                    }
                )
            return rows
```

- [ ] **Step 3: Rewrite the two probe tests to assert the new query shape**

Replace `test_verified_recipient_directory_filters_self_and_allows_explicit_network_connection` (lines ~108-117) with:

```python
def test_verified_recipient_directory_sources_from_connections() -> None:
    service = RecipientDirectoryProbe()

    assert service.list_verified_recipients(owner_user_id="owner") == []
    assert "FROM connections c" in service.sql
    assert "c.status = 'active'" in service.sql
    assert "c.user_a_id = :owner_user_id OR c.user_b_id = :owner_user_id" in service.sql
    assert "one_location_recipient_keys" in service.sql
    assert "a.user_id <> :owner_user_id" in service.sql
    assert "ORDER BY COALESCE" in service.sql
    assert service.params["owner_user_id"] == "owner"
```

Replace `test_list_verified_recipients_rule1_uses_trusted_connections` (lines ~120-147) with:

```python
def test_list_verified_recipients_sources_from_connections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    svc = OneLocationAgentService()
    captured: dict[str, object] = {}

    def fake_execute_many(sql: str, params: dict | None = None) -> list[dict]:
        captured["sql"] = sql
        captured["params"] = params
        return [
            {
                "user_id": "friend",
                "display_name": "Friend",
                "phone_number": None,
                "phone_verified": True,
                "key_id": "k1",
                "public_key_jwk": "{}",
                "algorithm": "ECDH-P256-AES256-GCM",
                "key_created_at": None,
            }
        ]

    monkeypatch.setattr(svc, "_execute_many", fake_execute_many)
    monkeypatch.setattr(svc, "_apply_kai_circle_recommendations", lambda **kw: kw["recipients"])
    out = svc.list_verified_recipients(owner_user_id="owner")
    assert "FROM connections c" in captured["sql"]
    assert "a.phone_verified = TRUE" not in captured["sql"]
    assert out and out[0]["userId"] == "friend"
```

- [ ] **Step 4: Rewrite the marketplace/eligibility tests to connections-only semantics**

Replace `test_marketplace_connection_makes_user_a_location_recipient` (lines ~2024-2046) with:

```python
def test_marketplace_connection_alone_is_not_a_location_recipient() -> None:
    # A marketplace (advisor<->investor) relationship no longer grants location
    # visibility on its own -- only an accepted connection does.
    service = FourUserMemoryService()
    service.professional_relationships.append(
        {
            "investor_user_id": "user_a",
            "ria_user_id": "user_b",
            "status": "approved",
            "ria_display_name": "User B",
            "ria_verification_status": "verified",
            "relationship_share_status": "active",
        }
    )

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert "user_b" not in recipient_ids
```

Replace `test_marketplace_visibility_off_hides_user_from_location_directory` (lines ~2049-2068) with:

```python
def test_phone_verified_user_without_connection_is_not_a_recipient() -> None:
    # The broad phone-verified directory no longer seeds recipients.
    service = FourUserMemoryService()

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert recipient_ids == set()
```

Replace `test_explicit_network_connection_overrides_marketplace_visibility_off` (lines ~2071-2097) with:

```python
def test_active_connection_makes_user_a_location_recipient() -> None:
    service = FourUserMemoryService()
    service._seed_connection("user_a", "user_b")

    recipient_ids = {
        recipient["userId"]
        for recipient in service.list_verified_recipients(owner_user_id="user_a")
    }

    assert recipient_ids == {"user_b"}
```

- [ ] **Step 5: Adapt the recommendation-ranking test to connections-only**

`test_kai_circle_recipient_directory_uses_safe_recommendation_signals` (lines ~1168-1350) builds its directory from the old broad model. Under connections-only, only connected users appear. Seed connections for every user the test asserts is a recipient, right after the `register_recipient_key` loop (after line ~1202):

```python
    for peer in (user_b, user_c, user_d, user_f, user_g):
        service._seed_connection(user_a, peer)
```

Then run the test and remove/adjust any assertion that asserts a *non-connected* user appears in the directory (the recommendation-signal enrichment still applies to connected recipients; membership in the directory is now gated on connections). Keep the `recommendationCategory` / `trustLevel` assertions for users that remain recipients.

Run: `cd consent-protocol && python -m pytest tests/services/test_one_location_agent_service.py::test_kai_circle_recipient_directory_uses_safe_recommendation_signals -v`
Adjust assertions until it passes with the connections-only directory.

- [ ] **Step 6: Run the new/updated tests to verify they FAIL against the old implementation**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_location_agent_service.py -k "recipient or connection or kai_circle" -v`
Expected: FAILs — the source still queries `actor_identity_cache`/`trusted_connections`, so `"FROM connections c"` assertions fail and connection-seeded recipients are empty.

- [ ] **Step 7: Rewrite `list_verified_recipients` to source from `connections`**

In `one_location_agent_service.py`, replace the SQL body of `list_verified_recipients` (the `rows = self._execute_many(""" ... """, {...})` block at lines ~2443-2492) with:

```python
        rows = self._execute_many(
            """
            SELECT
              a.user_id, a.display_name, a.phone_number, a.phone_verified,
              k.key_id, k.public_key_jwk, k.algorithm, k.created_at AS key_created_at
            FROM connections c
            JOIN actor_identity_cache a
              ON a.user_id = CASE
                   WHEN c.user_a_id = :owner_user_id THEN c.user_b_id
                   ELSE c.user_a_id
                 END
            LEFT JOIN LATERAL (
              SELECT key_id, public_key_jwk, algorithm, created_at
              FROM one_location_recipient_keys
              WHERE user_id = a.user_id
                AND status = 'active'
              ORDER BY created_at DESC
              LIMIT 1
            ) k ON TRUE
            WHERE c.status = 'active'
              AND (c.user_a_id = :owner_user_id OR c.user_b_id = :owner_user_id)
              AND a.user_id <> :owner_user_id
            ORDER BY COALESCE(a.display_name, a.phone_number, a.user_id), a.user_id
            LIMIT :limit
            """,
            {"owner_user_id": owner_user_id, "limit": max(1, min(int(limit), 100))},
        )
```

Also update the docstring/comment block above the query (lines ~2426-2442) to describe the new rule: "A user appears as a One Location recipient only when the owner has an active connection with them (the two-way `connections` graph)."

- [ ] **Step 8: Run the tests to verify they PASS**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_location_agent_service.py -v`
Expected: PASS (all recipient/connection/kai_circle tests green; create_grant tests unaffected because the guard in Task 2 is opt-in).

- [ ] **Step 9: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_location_agent_service.py consent-protocol/tests/services/test_one_location_agent_service.py
git commit -s -m "feat(one-location): source location recipients from connections graph"
```

---

### Task 2: Backend — connection guard on the direct-share route

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_location_agent_service.py` (`create_grant` at line ~2597; add `_is_active_connection` helper near it)
- Modify: `consent-protocol/api/routes/one/location.py:412-428` (`create_location_grant`)
- Test: `consent-protocol/tests/services/test_one_location_agent_service.py`

**Interfaces:**
- Consumes: `list_verified_recipients` unchanged.
- Produces:
  - `_is_active_connection(*, owner_user_id: str, other_user_id: str) -> bool`
  - `create_grant(..., enforce_connection: bool = False)` — when `True`, raises `OneLocationAgentError("LOCATION_RECIPIENT_NOT_CONNECTED", ..., status_code=403)` if the recipient is not an active connection. Default `False` preserves the request-approval / public-invite grant path.

- [ ] **Step 1: Add the connections membership branch to the memory service `_execute_one`**

In `FourUserMemoryService._execute_one` (starts at line ~548), add near the top (before other branches):

```python
        if "SELECT 1" in sql and "FROM connections" in sql and "status = 'active'" in sql:
            a = params.get("a")
            b = params.get("b")
            for conn in self.connections.values():
                if conn.get("status") != "active":
                    continue
                pair = {conn["user_a_id"], conn["user_b_id"]}
                if pair == {a, b}:
                    return {"exists": 1}
            return None
```

- [ ] **Step 2: Write the failing guard tests**

Add to `test_one_location_agent_service.py`:

```python
def test_create_grant_enforce_connection_rejects_non_connection() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    with pytest.raises(OneLocationAgentError) as err:
        service.create_grant(
            owner_user_id="user_a",
            recipient_user_id="user_b",
            recipient_key_id="key-user_b",
            duration_hours=1,
            enforce_connection=True,
        )
    assert err.value.code == "LOCATION_RECIPIENT_NOT_CONNECTED"
    assert err.value.status_code == 403


def test_create_grant_enforce_connection_allows_connection() -> None:
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )
    service._seed_connection("user_a", "user_b")

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
        enforce_connection=True,
    )
    assert grant["recipientUserId"] == "user_b"


def test_create_grant_without_enforce_allows_non_connection() -> None:
    # The request-approval / public-invite path must keep working.
    service = FourUserMemoryService()
    service.register_recipient_key(
        user_id="user_b",
        key_id="key-user_b",
        public_key_jwk={"kty": "EC", "crv": "P-256", "x": "user_b", "y": "user_b"},
    )

    grant = service.create_grant(
        owner_user_id="user_a",
        recipient_user_id="user_b",
        recipient_key_id="key-user_b",
        duration_hours=1,
    )
    assert grant["recipientUserId"] == "user_b"
```

Note: confirm `OneLocationAgentError` exposes `.code` and `.status_code` (it is raised elsewhere with those fields, e.g. line ~2608). If the attribute names differ, match the existing pattern used by other tests in this file.

- [ ] **Step 3: Run the guard tests to verify they FAIL**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_location_agent_service.py -k "enforce_connection or without_enforce" -v`
Expected: FAIL — `create_grant` has no `enforce_connection` parameter (TypeError) / no guard.

- [ ] **Step 4: Add the `_is_active_connection` helper**

In `one_location_agent_service.py`, add immediately above `create_grant` (line ~2597):

```python
    def _is_active_connection(self, *, owner_user_id: str, other_user_id: str) -> bool:
        row = self._execute_one(
            """
            SELECT 1
            FROM connections
            WHERE status = 'active'
              AND (
                (user_a_id = :a AND user_b_id = :b)
                OR (user_a_id = :b AND user_b_id = :a)
              )
            LIMIT 1
            """,
            {"a": owner_user_id, "b": other_user_id},
        )
        return row is not None
```

- [ ] **Step 5: Add the `enforce_connection` parameter and guard to `create_grant`**

Add the parameter to the signature (line ~2597-2606), after `require_recipient_phone_verified`:

```python
        require_recipient_phone_verified: bool = True,
        enforce_connection: bool = False,
    ) -> dict[str, Any]:
```

Then insert the guard right after the self-recipient check (after line ~2612, before the duration normalization):

```python
        if enforce_connection and not self._is_active_connection(
            owner_user_id=owner_user_id, other_user_id=recipient_user_id
        ):
            raise OneLocationAgentError(
                "LOCATION_RECIPIENT_NOT_CONNECTED",
                "You can only share your live location with your connections.",
                status_code=403,
            )
```

- [ ] **Step 6: Pass `enforce_connection=True` from the direct-share route**

In `api/routes/one/location.py`, in `create_location_grant` (lines ~418-425), add the flag:

```python
            "grant": _service().create_grant(
                owner_user_id=_user_id(token_data),
                recipient_user_id=payload.recipient_user_id,
                recipient_key_id=payload.recipient_key_id,
                duration_hours=payload.duration_hours,
                reason=payload.reason,
                enforce_connection=True,
            )
```

Leave `approve_access_request`'s `create_grant` call (service line ~3979) unchanged — it must keep `enforce_connection` at its default `False`.

- [ ] **Step 7: Run the tests to verify they PASS**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_location_agent_service.py -v`
Expected: PASS (guard tests green; existing create_grant/public-invite/request tests still green).

- [ ] **Step 8: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_location_agent_service.py consent-protocol/api/routes/one/location.py consent-protocol/tests/services/test_one_location_agent_service.py
git commit -s -m "feat(one-location): guard direct location share to connections only"
```

---

### Task 3: Frontend — quick actions use the connection-scoped share-ready list

**Files:**
- Create/modify: `hushh-webapp/lib/one-location/sos-trigger.ts` (add `selectShareReadyRecipients`)
- Modify: `hushh-webapp/app/one/location/page.tsx:2001-2023` (`sosTrustedRecipients` / `sosActionRecipients`) and the import at line ~159
- Test: `hushh-webapp/lib/one-location/__tests__/sos-trigger.test.ts`

**Interfaces:**
- Consumes: existing `isShareReadyRecipient` (already used in `page.tsx`).
- Produces: `selectShareReadyRecipients(recipients: OneLocationRecipient[]): OneLocationRecipient[]` — returns the share-ready subset (all recipients are now connections, so no trusted-graph filtering is needed).

- [ ] **Step 1: Write the failing test**

In `sos-trigger.test.ts`, add (adjust the recipient fixture factory to match existing helpers in the file — reuse `rA`/`rB` style objects already defined there):

```typescript
import { selectShareReadyRecipients } from "@/lib/one-location/sos-trigger";

describe("selectShareReadyRecipients", () => {
  it("returns only share-ready recipients", () => {
    const ready = { userId: "a", canReceiveLocation: true } as never;
    const notReady = { userId: "b", canReceiveLocation: false } as never;
    const result = selectShareReadyRecipients([ready, notReady]);
    expect(result.map((r) => r.userId)).toEqual(["a"]);
  });

  it("returns empty for an empty list", () => {
    expect(selectShareReadyRecipients([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/sos-trigger.test.ts -t "selectShareReadyRecipients"`
Expected: FAIL with "selectShareReadyRecipients is not a function" / import error.

- [ ] **Step 3: Implement `selectShareReadyRecipients`**

In `sos-trigger.ts`, add (place next to `selectSosConnectedRecipients`; reuse the existing share-ready predicate the file/module already exports or import `isShareReadyRecipient` from its current location):

```typescript
export function selectShareReadyRecipients(
  recipients: OneLocationRecipient[],
): OneLocationRecipient[] {
  return recipients.filter((r) => r.canReceiveLocation === true);
}
```

If a canonical `isShareReadyRecipient` predicate already exists in the codebase (it is used in `page.tsx`), import and use it here instead of re-implementing the `canReceiveLocation` check, to stay DRY:

```typescript
import { isShareReadyRecipient } from "<its current module>";

export function selectShareReadyRecipients(
  recipients: OneLocationRecipient[],
): OneLocationRecipient[] {
  return recipients.filter(isShareReadyRecipient);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/sos-trigger.test.ts -t "selectShareReadyRecipients"`
Expected: PASS.

- [ ] **Step 5: Use the connection-scoped list in `page.tsx`**

In `app/one/location/page.tsx`, delete the `sosTrustedRecipients` memo (lines ~2004-2012) and replace the `sosActionRecipients` memo (lines ~2020-2023) with:

```typescript
  // All quick actions (SOS, check-in, drive-to, pick-me-up, safe-arrival) share
  // the same recipients: your connections that are ready for private sharing.
  // Recipients are already scoped to the connections graph server-side.
  const sosActionRecipients = useMemo(
    () => selectShareReadyRecipients(rankedRecipients),
    [rankedRecipients],
  );
```

Update the import at line ~159: remove `selectSosConnectedRecipients` if it is no longer referenced in this file (verify with a search — it is also used in `lib/agent/specialist-directive-runtime.ts`, so keep the export in `sos-trigger.ts`), and add `selectShareReadyRecipients`.

- [ ] **Step 6: Verify types and the full sos-trigger suite pass**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/sos-trigger.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. (If `tsc --noEmit` is not the project's typecheck command, use the one in `package.json`.)

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/lib/one-location/sos-trigger.ts hushh-webapp/lib/one-location/__tests__/sos-trigger.test.ts hushh-webapp/app/one/location/page.tsx
git commit -s -m "feat(one-location): quick actions use connection-scoped recipients"
```

---

### Task 4: Frontend — "Ready people" empty state links to Connect

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/primitives.tsx:261-277` (`EmptyState` — add `action` prop)
- Modify: `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx:816-851` (Ready people empty state + copy; add `next/link` import)
- Test: `hushh-webapp/components/one-location/redesign/__tests__/primitives.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `EmptyState` now accepts an optional `action?: ReactNode` rendered under the description.

- [ ] **Step 1: Write the failing test for `EmptyState` action**

Create `hushh-webapp/components/one-location/redesign/__tests__/primitives.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "@/components/one-location/redesign/primitives";

describe("EmptyState", () => {
  it("renders an action node when provided", () => {
    render(
      <EmptyState
        title="Build your trusted circle"
        description="Add connections so the people you trust can receive your live location."
        action={<a href="/connect">Add connections</a>}
      />,
    );
    expect(screen.getByText("Build your trusted circle")).toBeTruthy();
    const link = screen.getByText("Add connections").closest("a");
    expect(link?.getAttribute("href")).toBe("/connect");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/primitives.test.tsx`
Expected: FAIL — `EmptyState` does not render/accept `action`.

- [ ] **Step 3: Add the `action` prop to `EmptyState`**

In `primitives.tsx`, update `EmptyState` (lines ~261-277):

```tsx
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "flex flex-col items-center gap-2 p-6 text-center")}>
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className={MUTED_TEXT}>{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/primitives.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the Connect CTA into the "Ready people" empty state**

In `location-redesign-hub.tsx`, add the import at the top with the other imports:

```tsx
import Link from "next/link";
```

Replace the non-search empty state in `PeopleHub` (the `EmptyState` at lines ~841-848) so that when there is no search query it prompts to add connections. Update the block to:

```tsx
        ) : (
          <div className="mt-3">
            <EmptyState
              title={hasSearchQuery ? "No matching people" : "Build your trusted circle"}
              description={
                hasSearchQuery
                  ? "Try a different name."
                  : "Add connections so the people you trust can receive your live location."
              }
              action={
                hasSearchQuery ? undefined : (
                  <Link
                    href="/connect"
                    className="inline-flex h-9 items-center rounded-full bg-[#d4a574] px-4 text-sm font-semibold text-white hover:bg-[#d4a574]/90"
                  >
                    Add connections
                  </Link>
                )
              }
            />
          </div>
        )}
```

- [ ] **Step 6: Update the "Ready people" section copy**

In the same file, update the `SectionCard` copy that describes readiness. The "Trusted Circle" `SectionCard` description (line ~785) currently reads "Only approved, ready people can receive private live location." Change it to reflect connections:

```tsx
        description="Only your connections can receive private live location."
```

- [ ] **Step 7: Verify build/typecheck and the redesign tests pass**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/primitives.test.tsx && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/primitives.tsx hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx hushh-webapp/components/one-location/redesign/__tests__/primitives.test.tsx
git commit -s -m "feat(one-location): prompt to add connections when trusted circle is empty"
```

---

## Manual Verification (after all tasks)

Use the `verify` / `run` skill to drive the app:

1. As a user with **zero connections**, open One Location → People tab. The "Ready people" section shows "Build your trusted circle" with an "Add connections" button that navigates to `/connect`.
2. Open a quick action (e.g. Check-in). Its recipient list is empty (no connections) — it reflects the same connection-scoped source.
3. Create a mutual connection with another test user (via `/connect`). Return to One Location → the connection now appears as a recipient (and as share-ready once they've registered a recipient key).
4. Attempt a direct share to the connection → succeeds. (Backend) A direct `POST /location/grants` to a non-connection returns `403 LOCATION_RECIPIENT_NOT_CONNECTED`.
5. Confirm an existing public-invite link still resolves and its approval still creates a grant (request-approval path unaffected).

## Self-Review Notes

- **Spec coverage:** recipient source swap (Task 1) ✓; strict guard (Task 2) ✓; quick actions use same connections (Task 3) ✓; empty-state prompt + copy (Task 4) ✓; trusted mirror left in place (untouched — no task removes it) ✓; existing grants/links untouched (guard is opt-in; approve_access_request unchanged) ✓.
- **Out of scope (per spec):** connection addons; removing the trusted mirror; migrating existing non-connection grants; a friends-on-a-map marker view.
- **Type consistency:** `selectShareReadyRecipients` used identically in Task 3 test and `page.tsx`; `_is_active_connection`/`enforce_connection` names consistent across Task 2 service + route; `EmptyState` `action` prop consistent across Task 4.
