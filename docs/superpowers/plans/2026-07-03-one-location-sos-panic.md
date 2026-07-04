# One + Location — SOS Panic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a one-tap (countdown-guarded) **SOS panic** action in the One app's Location `Now` tab that alerts every share-ready trusted contact and starts a real encrypted live-location share to each — reusing the existing share pipeline — plus a login-time seed that connects a fresh user to a configured list of developer accounts so SOS works end-to-end.

**Architecture:** SOS is an *orchestration of existing primitives*. The panic action reuses `OneLocationService.createGrant` (8h, `reason:'sos_panic'`) + the existing `watchCurrentPosition`→`publishMovement` live loop (which auto-starts on any active owner grant) + `revokeGrant` for stop. The active incident (grant ids + start time) is tracked in localStorage because grant metadata isn't exposed via `getState`. The only net-new backend is one idempotent seed endpoint that inserts `one_location_network_connections` rows (mirroring `claim_circle_invite`). No new tables, no migration.

**Tech Stack:** Python (FastAPI, raw SQL over PostgreSQL, Pydantic v2, pytest), TypeScript, React, Next.js App Router, Tailwind, Vitest + React Testing Library, Capacitor.

## Visual Map

```text
LOGIN (post vault-unlock)
  PostAuthOnboardingSyncBridge → PostUnlockSyncService.run
    → OneLocationService.seedTrustedContacts()  → POST /api/one/location/seed-trusted
        → seed_trusted_connections: if 0 active connections, INSERT
          one_location_network_connections to each SOS_SEED_DEV_USER_IDS dev

LOCATION · Now tab
  SosPanel  ── idle ──▶  TAP TO PANIC ─▶ 3–5s countdown (Cancel) ─▶ onTrigger
            ── active ─▶ LIVE LOCATION ACTIVE + "I'm safe" ─▶ onStop
            WHO GETS ALERTED? = share-ready recipients (read-only)

PANIC  handleTriggerSos
  for each share-ready recipient:
    createGrant(durationHours:8, reason:"sos_panic") → one_location_share_grants
                                                     → FCM + in-app notify + one_location_events
    record grant id → SosIncident (localStorage)
  existing watchCurrentPosition→publishMovement loop auto-streams envelopes

STOP  handleStopSos
  revokeGrant for each incident grant id → status=revoked → clear incident
  (8h TTL is the backstop)
```

## Global Constraints

- **Reuse over rebuild:** do NOT create new grant/envelope/notification/audit code. Use `create_grant`, `store_encrypted_envelope`, `revoke_grant`, `list_verified_recipients` as-is. The live-update loop and notifications fire automatically off active owner grants.
- **Audit table is `one_location_events`** (migration `061`). The `kai_location_*` tables are legacy/dead — never write to them.
- **Coordinate-free:** no `latitude`/`longitude`/coordinate keys in grant metadata, the incident record, notifications, events, or any non-ciphertext field. Position exists only inside `one_location_envelopes.ciphertext` (handled entirely by the reused envelope path).
- **SOS grant tag:** pass `reason: "sos_panic"` (backend already writes it to grant `metadata`).
- **Grant duration:** `durationHours: 8` (server caps at 24; 8 is the SOS safety cap).
- **Recipients alerted:** ALL share-ready trusted contacts (`canReceiveLocation === true`). Per-contact toggles are display-only for now. If some contacts aren't ready, surface it in a toast — never skip silently.
- **Seed gate:** insert connections only when the user has **zero active** `one_location_network_connections`; idempotent via `ON CONFLICT (user_a_id, user_b_id)`.
- **Seed config:** dev IDs from env `SOS_SEED_DEV_USER_IDS` (comma-separated).
- **Ordered pair invariant:** `one_location_network_connections` requires `user_a_id < user_b_id`; `inviter_user_id`/`invitee_user_id` must each be one of the pair; no self-pair. Use `LEAST/GREATEST` in SQL.
- **Palette:** SOS panic + stop affordances use `destructive`/critical tokens (`variant="destructive"`, `.app-critical-*`). Avoid raw brand hexes in new code (self-imposed; not CI-enforced).
- **Backward compatible:** all new fields (`createGrant.reason`, seed endpoint, VM fields) are additive/optional. Existing share/chat flows untouched.
- **Prerequisite (config, not code):** the supplied dev accounts must be phone-verified and have opened One Location once (published a location key). Not-yet-ready accounts appear in the list but aren't alerted until ready.
- **Discipline:** DRY, YAGNI, TDD, frequent commits. All commits signed off (`git commit -s`).

## File Structure

**Backend (modify):**
- `consent-protocol/hushh_mcp/services/one_location_agent_service.py` — add `seed_trusted_connections(...)` method.
- `consent-protocol/api/routes/one/location.py` — add `POST /location/seed-trusted` route + `SOS_SEED_DEV_USER_IDS` helper.

**Backend (create):**
- `consent-protocol/tests/test_one_location_sos_seed.py` — seed method unit tests.

**Frontend (modify):**
- `hushh-webapp/lib/one-location/service.ts` — add `reason?` to `createGrant`; add `seedTrustedContacts(...)`.
- `hushh-webapp/app/one/location/page.tsx` — `handleTriggerSos`, `handleStopSos`, SOS incident state, VM wiring.
- `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx` — `LocationHubViewModel` SOS fields; render `SosPanel` in `NowHub`.
- `hushh-webapp/lib/services/post-unlock-sync-service.ts` — add SOS seed step to `run(...)`.

**Frontend (create):**
- `hushh-webapp/lib/one-location/sos-incident.ts` — localStorage incident store.
- `hushh-webapp/lib/one-location/__tests__/sos-incident.test.ts`
- `hushh-webapp/components/one-location/redesign/sos-panel.tsx` — the SOS panel UI.
- `hushh-webapp/components/one-location/redesign/__tests__/sos-panel.test.tsx`
- `hushh-webapp/lib/services/__tests__/post-unlock-sync-service.sos.test.ts`

---

## Task 1: Backend — `seed_trusted_connections` service method

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_location_agent_service.py` (add a method on `OneLocationAgentService`; place it near `claim_circle_invite`, ~line 3260)
- Test: `consent-protocol/tests/test_one_location_sos_seed.py` (create)

**Interfaces:**
- Consumes (existing on the class): `self._execute_one(sql, params)`, the module helper `_json_param(obj)`, and `OneLocationAgentError(code, message, status_code=...)`.
- Produces: `seed_trusted_connections(*, owner_user_id: str, dev_user_ids: list[str]) -> dict[str, Any]` returning `{"seeded": int, "existingCount": int, "skippedSelf": int}`.

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_one_location_sos_seed.py
import pytest

from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentService,
    OneLocationAgentError,
)


def _service_with_fake_db(count_existing, insert_sink):
    """Build a service without touching a real DB; stub _execute_one."""
    service = OneLocationAgentService.__new__(OneLocationAgentService)

    def fake_execute_one(sql, params):
        if "COUNT(*)" in sql:
            return {"n": count_existing}
        # INSERT path — record params, return a fake row.
        insert_sink.append(params)
        return {"id": f"conn-{len(insert_sink)}"}

    service._execute_one = fake_execute_one  # type: ignore[attr-defined]
    return service


def test_seed_inserts_one_connection_per_dev_when_no_existing():
    inserts: list[dict] = []
    service = _service_with_fake_db(0, inserts)
    result = service.seed_trusted_connections(
        owner_user_id="owner1", dev_user_ids=["devA", "devB", "devC"]
    )
    assert result["seeded"] == 3
    assert result["existingCount"] == 0
    assert len(inserts) == 3


def test_seed_skips_when_user_already_connected():
    inserts: list[dict] = []
    service = _service_with_fake_db(2, inserts)
    result = service.seed_trusted_connections(
        owner_user_id="owner1", dev_user_ids=["devA", "devB"]
    )
    assert result["seeded"] == 0
    assert result["existingCount"] == 2
    assert inserts == []  # gated: no inserts when already connected


def test_seed_skips_self_and_blanks():
    inserts: list[dict] = []
    service = _service_with_fake_db(0, inserts)
    result = service.seed_trusted_connections(
        owner_user_id="owner1", dev_user_ids=["owner1", "", "devB"]
    )
    assert result["seeded"] == 1
    assert result["skippedSelf"] == 2
    assert len(inserts) == 1
    # ordered pair invariant: user_a_id < user_b_id
    params = inserts[0]
    assert params["user_a_id"] < params["user_b_id"]
    assert params["inviter_user_id"] == "owner1"
    assert params["invitee_user_id"] == "devB"


def test_seed_rejects_missing_owner():
    service = OneLocationAgentService.__new__(OneLocationAgentService)
    with pytest.raises(OneLocationAgentError):
        service.seed_trusted_connections(owner_user_id="  ", dev_user_ids=["devA"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_one_location_sos_seed.py -v`
Expected: FAIL — `AttributeError: ... has no attribute 'seed_trusted_connections'`.

- [ ] **Step 3: Implement the method**

Add this method to `OneLocationAgentService` (place near `claim_circle_invite`, ~line 3260). It mirrors the `claim_circle_invite` INSERT (ordered pair via `LEAST/GREATEST`, idempotent `ON CONFLICT`), with `invite_id = NULL` and a `{"source": "sos_seed"}` metadata tag:

```python
    def seed_trusted_connections(
        self,
        *,
        owner_user_id: str,
        dev_user_ids: list[str],
    ) -> dict[str, Any]:
        """Seed a fresh user's trusted network with configured developer accounts.

        Only runs when the user has zero active network connections. Inserts one
        active `one_location_network_connections` row per dev id (skipping self and
        blanks). Idempotent via ON CONFLICT — re-running reactivates rather than
        erroring. A seeded active connection satisfies eligibility rule #1 in
        `list_verified_recipients`, so the dev id immediately becomes a recipient.
        """
        owner_user_id = (owner_user_id or "").strip()
        if not owner_user_id:
            raise OneLocationAgentError(
                "LOCATION_SEED_INVALID", "Missing owner user id.", status_code=422
            )

        existing = self._execute_one(
            """
            SELECT COUNT(*) AS n
            FROM one_location_network_connections
            WHERE status = 'active'
              AND (user_a_id = :uid OR user_b_id = :uid)
            """,
            {"uid": owner_user_id},
        )
        existing_count = int((existing or {}).get("n") or 0)
        if existing_count > 0:
            return {"seeded": 0, "existingCount": existing_count, "skippedSelf": 0}

        seeded = 0
        skipped_self = 0
        for raw_dev_id in dev_user_ids:
            dev_id = (raw_dev_id or "").strip()
            if not dev_id or dev_id == owner_user_id:
                skipped_self += 1
                continue
            user_a_id, user_b_id = sorted((owner_user_id, dev_id))
            self._execute_one(
                """
                INSERT INTO one_location_network_connections (
                  user_a_id, user_b_id, inviter_user_id, invitee_user_id,
                  invite_id, status, connected_at, created_at, updated_at, metadata
                )
                VALUES (
                  LEAST(CAST(:user_a_id AS TEXT), CAST(:user_b_id AS TEXT)),
                  GREATEST(CAST(:user_a_id AS TEXT), CAST(:user_b_id AS TEXT)),
                  :inviter_user_id, :invitee_user_id,
                  NULL, 'active', NOW(), NOW(), NOW(),
                  CAST(:metadata_json AS JSONB)
                )
                ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
                  status = 'active',
                  updated_at = NOW(),
                  revoked_at = NULL,
                  metadata = EXCLUDED.metadata
                RETURNING id
                """,
                {
                    "user_a_id": user_a_id,
                    "user_b_id": user_b_id,
                    "inviter_user_id": owner_user_id,
                    "invitee_user_id": dev_id,
                    "metadata_json": _json_param({"source": "sos_seed"}),
                },
            )
            seeded += 1

        return {
            "seeded": seeded,
            "existingCount": existing_count,
            "skippedSelf": skipped_self,
        }
```

> If `_json_param` is not already imported/visible in this module scope, it is defined in this same file (used by `create_grant`/`claim_circle_invite`) — reuse the exact reference already used there. Do NOT add a second import.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_one_location_sos_seed.py -v`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_location_agent_service.py consent-protocol/tests/test_one_location_sos_seed.py
git commit -s -m "feat(one-location): seed_trusted_connections for SOS trusted contacts"
```

---

## Task 2: Backend — `POST /location/seed-trusted` route + env config

**Files:**
- Modify: `consent-protocol/api/routes/one/location.py` (add helper near other module-level `os.getenv` helpers ~line 117; add route near `POST /location/grants` ~line 329)
- Test: `consent-protocol/tests/test_one_location_seed_route.py` (create)

**Interfaces:**
- Consumes: `seed_trusted_connections(...)` (Task 1); existing route helpers `_service()`, `_user_id(token_data)`, `_handle_error(exc)`, dependency `require_vault_owner_token`, and `os` (already imported in this file).
- Produces: `POST /api/one/location/seed-trusted` returning `{"result": {...}}`; module helper `_sos_seed_dev_user_ids() -> list[str]`.

- [ ] **Step 1: Write the failing test**

```python
# consent-protocol/tests/test_one_location_seed_route.py
import importlib


def test_sos_seed_dev_user_ids_parses_csv(monkeypatch):
    module = importlib.import_module("api.routes.one.location")
    monkeypatch.setenv("SOS_SEED_DEV_USER_IDS", " devA , devB ,, devC ")
    assert module._sos_seed_dev_user_ids() == ["devA", "devB", "devC"]


def test_sos_seed_dev_user_ids_empty_when_unset(monkeypatch):
    module = importlib.import_module("api.routes.one.location")
    monkeypatch.delenv("SOS_SEED_DEV_USER_IDS", raising=False)
    assert module._sos_seed_dev_user_ids() == []


def test_seed_route_is_registered():
    module = importlib.import_module("api.routes.one.location")
    paths = {getattr(r, "path", None) for r in module.router.routes}
    assert "/api/one/location/seed-trusted" in paths
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_one_location_seed_route.py -v`
Expected: FAIL — `_sos_seed_dev_user_ids` missing / route not registered.

- [ ] **Step 3: Add the env helper**

In `consent-protocol/api/routes/one/location.py`, near the other `os.getenv` helpers (~line 117), add:

```python
def _sos_seed_dev_user_ids() -> list[str]:
    """Configured developer accounts to seed as SOS trusted contacts.

    Comma-separated env list, e.g. SOS_SEED_DEV_USER_IDS="uid1,uid2,uid3".
    """
    raw = str(os.getenv("SOS_SEED_DEV_USER_IDS", "") or "")
    return [item.strip() for item in raw.split(",") if item.strip()]
```

- [ ] **Step 4: Add the route**

Near `POST /location/grants` (~line 329), add:

```python
@router.post("/location/seed-trusted")
async def seed_trusted_contacts(
    token_data: dict = Depends(require_vault_owner_token),
):
    """Seed the current user's trusted network with configured dev accounts.

    Idempotent and gated on the user having zero active connections. Used by the
    post-unlock bridge so a fresh user has SOS recipients.
    """
    try:
        return {
            "result": _service().seed_trusted_connections(
                owner_user_id=_user_id(token_data),
                dev_user_ids=_sos_seed_dev_user_ids(),
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_one_location_seed_route.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/api/routes/one/location.py consent-protocol/tests/test_one_location_seed_route.py
git commit -s -m "feat(one-location): POST /location/seed-trusted endpoint + env config"
```

---

## Task 3: Frontend — `createGrant` reason + `seedTrustedContacts`

**Files:**
- Modify: `hushh-webapp/lib/one-location/service.ts` (`createGrant` ~318-337; add `seedTrustedContacts` after it)
- Test: `hushh-webapp/lib/one-location/__tests__/service-sos.test.ts` (create)

**Interfaces:**
- Consumes: existing module functions used by the class — `apiJson`, `jsonAuthHeaders` (already imported at the top of `service.ts`).
- Produces:
  - `OneLocationService.createGrant` input gains optional `reason?: string` (sent only when present).
  - `OneLocationService.seedTrustedContacts(params: { vaultOwnerToken: string }): Promise<{ seeded: number; existingCount: number; skippedSelf: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// hushh-webapp/lib/one-location/__tests__/service-sos.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { OneLocationService } from "@/lib/one-location/service";

// Capture outgoing requests by stubbing global fetch (apiJson wraps fetch).
function stubFetch(payload: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OneLocationService SOS additions", () => {
  it("createGrant sends reason when provided", async () => {
    const calls = stubFetch({ grant: { id: "g1" } });
    await OneLocationService.createGrant({
      vaultOwnerToken: "tok",
      recipientUserId: "r1",
      recipientKeyId: "k1",
      durationHours: 8,
      reason: "sos_panic",
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.reason).toBe("sos_panic");
    expect(body.durationHours).toBe(8);
  });

  it("createGrant omits reason when not provided", async () => {
    const calls = stubFetch({ grant: { id: "g1" } });
    await OneLocationService.createGrant({
      vaultOwnerToken: "tok",
      recipientUserId: "r1",
      recipientKeyId: "k1",
      durationHours: 2,
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect("reason" in body).toBe(false);
  });

  it("seedTrustedContacts POSTs to the seed endpoint and returns result", async () => {
    const calls = stubFetch({ result: { seeded: 3, existingCount: 0, skippedSelf: 0 } });
    const result = await OneLocationService.seedTrustedContacts({ vaultOwnerToken: "tok" });
    expect(calls[0].url).toContain("/api/one/location/seed-trusted");
    expect(calls[0].init.method).toBe("POST");
    expect(result.seeded).toBe(3);
  });
});
```

> If `apiJson` does not call the global `fetch` directly (verify with `grep -n "fetch(" lib/**/http*.*` / wherever `apiJson` is defined), instead `vi.mock` that module and assert on its mock. Keep the assertions identical (body has `reason`, URL is the seed endpoint).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/service-sos.test.ts`
Expected: FAIL — `reason` not in body; `seedTrustedContacts` is not a function.

- [ ] **Step 3: Add `reason` to `createGrant`**

In `service.ts`, replace the `createGrant` method (~318-337) with:

```ts
  static async createGrant(params: {
    vaultOwnerToken: string;
    recipientUserId: string;
    recipientKeyId: string;
    durationHours: number;
    reason?: string;
  }): Promise<OneLocationGrant> {
    const response = await apiJson<{ grant: OneLocationGrant }>(
      "/api/one/location/grants",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          recipientUserId: params.recipientUserId,
          recipientKeyId: params.recipientKeyId,
          durationHours: params.durationHours,
          ...(params.reason ? { reason: params.reason } : {}),
        }),
      },
    );
    return response.grant;
  }
```

- [ ] **Step 4: Add `seedTrustedContacts`**

Immediately after `createGrant`, add:

```ts
  static async seedTrustedContacts(params: {
    vaultOwnerToken: string;
  }): Promise<{ seeded: number; existingCount: number; skippedSelf: number }> {
    const response = await apiJson<{
      result: { seeded: number; existingCount: number; skippedSelf: number };
    }>("/api/one/location/seed-trusted", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
    });
    return response.result;
  }
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/service-sos.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/one-location/service.ts hushh-webapp/lib/one-location/__tests__/service-sos.test.ts
git commit -s -m "feat(one-location): createGrant reason + seedTrustedContacts client"
```

---

## Task 4: Frontend — SOS incident store (localStorage)

**Files:**
- Create: `hushh-webapp/lib/one-location/sos-incident.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/sos-incident.test.ts`

**Interfaces:**
- Produces:
  - `type SosIncident = { grantIds: string[]; startedAt: string }`
  - `loadSosIncident(): SosIncident | null`
  - `saveSosIncident(incident: SosIncident): void`
  - `clearSosIncident(): void`
  - `reconcileSosIncident(incident: SosIncident | null, activeGrantIds: string[]): SosIncident | null` — drops grant ids no longer active; returns `null` when none remain.

- [ ] **Step 1: Write the failing test**

```ts
// hushh-webapp/lib/one-location/__tests__/sos-incident.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSosIncident,
  loadSosIncident,
  reconcileSosIncident,
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";

beforeEach(() => {
  window.localStorage.clear();
});

describe("sos-incident store", () => {
  const incident: SosIncident = {
    grantIds: ["g1", "g2"],
    startedAt: "2026-07-03T10:57:00.000Z",
  };

  it("save then load round-trips", () => {
    saveSosIncident(incident);
    expect(loadSosIncident()).toEqual(incident);
  });

  it("clear removes it", () => {
    saveSosIncident(incident);
    clearSosIncident();
    expect(loadSosIncident()).toBeNull();
  });

  it("load returns null on absent/corrupt data", () => {
    expect(loadSosIncident()).toBeNull();
    window.localStorage.setItem("one_location_sos_incident_v1", "{not json");
    expect(loadSosIncident()).toBeNull();
  });

  it("reconcile keeps only still-active grant ids", () => {
    expect(reconcileSosIncident(incident, ["g1"])).toEqual({
      grantIds: ["g1"],
      startedAt: incident.startedAt,
    });
  });

  it("reconcile returns null when no grant ids remain active", () => {
    expect(reconcileSosIncident(incident, ["other"])).toBeNull();
    expect(reconcileSosIncident(null, ["g1"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/sos-incident.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

```ts
// hushh-webapp/lib/one-location/sos-incident.ts
"use client";

/**
 * Client-side record of an active SOS incident. The grant `metadata.reason`
 * ("sos_panic") is written server-side but NOT exposed via getState/OneLocationGrant,
 * so we persist the incident (its grant ids + start time) here to drive the
 * "LIVE LOCATION ACTIVE" banner and the "I'm safe" stop across reloads.
 *
 * Coordinate-free by construction: only grant ids and an ISO timestamp are stored.
 */
export type SosIncident = { grantIds: string[]; startedAt: string };

const STORAGE_KEY = "one_location_sos_incident_v1";

export function loadSosIncident(): SosIncident | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SosIncident> | null;
    if (
      !parsed ||
      !Array.isArray(parsed.grantIds) ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      grantIds: parsed.grantIds.map((id) => String(id)),
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function saveSosIncident(incident: SosIncident): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(incident));
  } catch {
    /* storage unavailable — banner degrades to session-only, sharing still works */
  }
}

export function clearSosIncident(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Keep only grant ids still present in `activeGrantIds`. Returns null when the
 * incident is over (no tracked grants remain active) so callers can drop it.
 */
export function reconcileSosIncident(
  incident: SosIncident | null,
  activeGrantIds: string[],
): SosIncident | null {
  if (!incident) return null;
  const active = new Set(activeGrantIds);
  const grantIds = incident.grantIds.filter((id) => active.has(id));
  return grantIds.length ? { ...incident, grantIds } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/sos-incident.test.ts`
Expected: PASS.

> If the vitest environment is not jsdom (no `window`), add `// @vitest-environment jsdom` as the first line of the test file (match how other `lib/one-location` DOM tests declare it).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/one-location/sos-incident.ts hushh-webapp/lib/one-location/__tests__/sos-incident.test.ts
git commit -s -m "feat(one-location): SOS incident localStorage store"
```

---

## Task 5: Frontend — `SosPanel` component

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/sos-panel.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/sos-panel.test.tsx`

**Interfaces:**
- Consumes: `OneLocationRecipient` from `@/lib/one-location/types`; `Button` from the same UI import path used by `cards.tsx` (`@/components/ui/button` — confirm by matching the import in `components/one-location/redesign/cards.tsx`); `lucide-react` icons.
- Produces: `SosPanel(props: SosPanelProps)` where

```ts
export type SosPanelProps = {
  recipients: OneLocationRecipient[];
  active: boolean;
  busy: boolean;
  startedAtLabel: string | null;
  onTrigger: () => void;
  onStop: () => void;
  recipientLabel: (r: OneLocationRecipient) => string;
  isRecipientShareReady: (r: OneLocationRecipient) => boolean;
  countdownSeconds?: number; // default 5
};
```

- [ ] **Step 1: Write the failing test**

```tsx
// hushh-webapp/components/one-location/redesign/__tests__/sos-panel.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import type { OneLocationRecipient } from "@/lib/one-location/types";

const recipient = (over: Partial<OneLocationRecipient>): OneLocationRecipient => ({
  userId: "u1",
  displayName: "Carol",
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256-AES256-GCM",
  canReceiveLocation: true,
  ...over,
});

const baseProps = {
  recipients: [recipient({ userId: "u1", displayName: "Carol" })],
  active: false,
  busy: false,
  startedAtLabel: null,
  onTrigger: vi.fn(),
  onStop: vi.fn(),
  recipientLabel: (r: OneLocationRecipient) => r.displayName,
  isRecipientShareReady: (r: OneLocationRecipient) => r.canReceiveLocation,
  countdownSeconds: 3,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SosPanel", () => {
  it("shows TAP TO PANIC and the alert list when idle", () => {
    render(<SosPanel {...baseProps} />);
    expect(screen.getByText(/tap to panic/i)).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("tapping starts a countdown that can be cancelled (no trigger)", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} />);
    fireEvent.click(screen.getByRole("button", { name: /tap to panic/i }));
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    act(() => vi.advanceTimersByTime(5000));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("fires onTrigger when the countdown elapses", () => {
    const onTrigger = vi.fn();
    render(<SosPanel {...baseProps} onTrigger={onTrigger} countdownSeconds={3} />);
    fireEvent.click(screen.getByRole("button", { name: /tap to panic/i }));
    act(() => vi.advanceTimersByTime(3000));
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("shows LIVE + I'm safe when active and calls onStop", () => {
    const onStop = vi.fn();
    render(<SosPanel {...baseProps} active startedAtLabel="10:57 AM" onStop={onStop} />);
    expect(screen.getByText(/live location active/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /i'm safe/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/sos-panel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
// hushh-webapp/components/one-location/redesign/sos-panel.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldAlert, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OneLocationRecipient } from "@/lib/one-location/types";

export type SosPanelProps = {
  recipients: OneLocationRecipient[];
  active: boolean;
  busy: boolean;
  startedAtLabel: string | null;
  onTrigger: () => void;
  onStop: () => void;
  recipientLabel: (r: OneLocationRecipient) => string;
  isRecipientShareReady: (r: OneLocationRecipient) => boolean;
  countdownSeconds?: number;
};

function initialOf(label: string): string {
  const trimmed = label.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}

/**
 * SOS panic panel for the Location Now tab. Idle: a red "TAP TO PANIC" button
 * that arms a short countdown (cancellable) before firing. Active: a
 * "LIVE LOCATION ACTIVE" banner with an "I'm safe" stop. Always shows the
 * read-only "WHO GETS ALERTED?" list. Reuses the destructive palette.
 */
export function SosPanel({
  recipients,
  active,
  busy,
  startedAtLabel,
  onTrigger,
  onStop,
  recipientLabel,
  isRecipientShareReady,
  countdownSeconds = 5,
}: SosPanelProps) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => stopTimer, []);

  const startCountdown = () => {
    if (busy || active) return;
    setRemaining(countdownSeconds);
    stopTimer();
    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          stopTimer();
          setRemaining(null);
          onTrigger();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const cancelCountdown = () => {
    stopTimer();
    setRemaining(null);
  };

  const readyCount = recipients.filter(isRecipientShareReady).length;

  return (
    <section className="app-critical-card space-y-4 rounded-2xl p-4">
      <header className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-foreground">SOS</h2>
          <p className="text-xs text-muted-foreground">
            Alert trusted contacts + share live location
          </p>
        </div>
      </header>

      {active ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
            </span>
            LIVE LOCATION ACTIVE
            {startedAtLabel ? (
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                since {startedAtLabel}
              </span>
            ) : null}
          </div>
          <Button
            variant="destructive"
            onClick={onStop}
            isLoading={busy}
            className="h-12 w-full rounded-2xl text-base font-semibold"
          >
            I&apos;m safe — Stop sharing
          </Button>
        </div>
      ) : remaining !== null ? (
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium text-destructive">
            Alerting all trusted contacts in
          </p>
          <p className="text-5xl font-bold text-destructive" aria-live="assertive">
            {remaining}
          </p>
          <Button
            variant="outline"
            onClick={cancelCountdown}
            className="h-12 w-full rounded-2xl text-base font-semibold"
          >
            <X className="mr-1.5 h-4 w-4" aria-hidden />
            Cancel
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-destructive">
            Emergency alert
          </p>
          <Button
            variant="destructive"
            onClick={startCountdown}
            disabled={busy || readyCount === 0}
            className="h-28 w-full rounded-2xl text-2xl font-bold"
          >
            TAP TO PANIC
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            One tap alerts all trusted contacts + shares your live location
          </p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Who gets alerted?
        </p>
        {recipients.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trusted contacts yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {recipients.map((r) => {
              const ready = isRecipientShareReady(r);
              return (
                <li
                  key={r.userId}
                  className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-sm font-semibold text-destructive">
                    {initialOf(recipientLabel(r))}
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {recipientLabel(r)}
                  </span>
                  {ready ? (
                    <span
                      className="ml-auto h-2 w-2 rounded-full bg-emerald-500"
                      aria-label="Ready"
                    />
                  ) : (
                    <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <TriangleAlert className="h-3 w-3" aria-hidden />
                      Not ready
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
```

> Confirm the `Button` import path and that it supports `isLoading` + `variant="destructive"` by matching `components/one-location/redesign/cards.tsx` (it uses exactly `<Button variant="destructive" isLoading={...}>`). If `variant="outline"` is not available, use the default variant for Cancel. If `.app-critical-card` isn't picked up in the test DOM, that's fine — it's a global CSS class, not required for assertions.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/sos-panel.test.tsx`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/sos-panel.tsx hushh-webapp/components/one-location/redesign/__tests__/sos-panel.test.tsx
git commit -s -m "feat(one-location): SosPanel component with countdown + live banner"
```

---

## Task 6: Frontend — page handlers + SOS incident state

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx` (imports; state near other `useState`; handlers near `handleShare` ~2806 / `handleRevoke` ~3217; VM build ~4182-4263)

**Interfaces:**
- Consumes: `OneLocationService.createGrant` (Task 3), `revokeGrant`, `seedTrustedContacts`; the incident store (Task 4); existing `ensureForegroundLocationReady`, `publishEnvelopeWithRetry`, `recipientForGrant`, `activeOwnerGrants`, `rankedRecipients`, `isShareReadyRecipient`, `vaultOwnerToken`, `refresh`, `setBusy`, `busy`, `formatDateTime`, `toast`.
- Produces (consumed by Task 7's VM): `handleTriggerSos`, `handleStopSos`, and derived `sosActive`, `sosStartedAtLabel`, and the list `sosRecipients`.

- [ ] **Step 1: Add imports**

Near the other `@/lib/one-location/*` imports in `page.tsx`:

```ts
import {
  clearSosIncident,
  loadSosIncident,
  reconcileSosIncident,
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";
```

- [ ] **Step 2: Add incident state + hydration/reconciliation**

Near the other `useState` declarations:

```ts
const [sosIncident, setSosIncident] = useState<SosIncident | null>(null);

// Hydrate the persisted SOS incident once on mount.
useEffect(() => {
  setSosIncident(loadSosIncident());
}, []);

// Reconcile the incident against live grants: drop grant ids that are no longer
// active (revoked/expired). Clears the banner automatically when the incident ends.
useEffect(() => {
  setSosIncident((current) => {
    const reconciled = reconcileSosIncident(
      current,
      activeOwnerGrants.map((grant) => grant.id),
    );
    if (!reconciled) {
      if (current) clearSosIncident();
      return null;
    }
    if (reconciled.grantIds.length !== current?.grantIds.length) {
      saveSosIncident(reconciled);
    }
    return reconciled;
  });
}, [activeOwnerGrants]);
```

- [ ] **Step 3: Add `handleTriggerSos`**

Near `handleShare` (~2806). It mirrors `handleShare`'s grant+publish loop but targets ALL share-ready recipients at 8h with `reason:"sos_panic"`:

```ts
const handleTriggerSos = useCallback(async () => {
  if (!vaultOwnerToken || locationPermissionBlocksSharing(permission)) return;
  const readyRecipients = rankedRecipients.filter(isShareReadyRecipient);
  const totalTrusted = rankedRecipients.length;
  if (!readyRecipients.length) {
    toast.error("No trusted contacts are ready to receive your location yet.");
    return;
  }
  setBusy("sos");
  const grantIds: string[] = [];
  try {
    const readiness = await ensureForegroundLocationReady({
      capturePoint: true,
      autoOpenSettings: true,
    });
    if (!readiness.ready || !readiness.point) return;
    const point = readiness.point;
    for (const recipient of readyRecipients) {
      const grant = await OneLocationService.createGrant({
        vaultOwnerToken,
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId as string,
        durationHours: 8,
        reason: "sos_panic",
      });
      await publishEnvelopeWithRetry(grant, recipient, "manual", point);
      grantIds.push(grant.id);
    }
    const incident: SosIncident = {
      grantIds,
      startedAt: new Date().toISOString(),
    };
    saveSosIncident(incident);
    setSosIncident(incident);
    const skipped = totalTrusted - readyRecipients.length;
    toast.success(
      skipped > 0
        ? `SOS sent. Alerted ${readyRecipients.length} of ${totalTrusted} contacts (${skipped} not ready).`
        : `SOS sent. Alerting ${readyRecipients.length} trusted contact(s).`,
    );
    await refresh();
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Could not send SOS alert.",
    );
  } finally {
    setBusy(null);
  }
}, [
  ensureForegroundLocationReady,
  isShareReadyRecipient,
  permission,
  publishEnvelopeWithRetry,
  rankedRecipients,
  refresh,
  vaultOwnerToken,
]);
```

> `isShareReadyRecipient` and `rankedRecipients` already exist in this file (used by the share composer). If `isShareReadyRecipient` is defined as a standalone import rather than a local, use it directly as shown. `recipient.keyId` is non-null for share-ready recipients (that's what "ready" means), hence the `as string`.

- [ ] **Step 4: Add `handleStopSos`**

Near `handleRevoke` (~3217):

```ts
const handleStopSos = useCallback(async () => {
  if (!vaultOwnerToken) return;
  const incident = sosIncident;
  if (!incident?.grantIds.length) return;
  setBusy("sos");
  try {
    for (const grantId of incident.grantIds) {
      await OneLocationService.revokeGrant({ vaultOwnerToken, grantId }).catch(
        (error) => {
          // A grant may already be expired/revoked — keep tearing the rest down.
          console.warn("[OneLocationAgent] SOS stop: grant revoke skipped:", error);
        },
      );
    }
    clearSosIncident();
    setSosIncident(null);
    toast.success("SOS ended. Live location sharing stopped.");
    await refresh();
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Could not stop SOS sharing.",
    );
  } finally {
    setBusy(null);
  }
}, [refresh, sosIncident, vaultOwnerToken]);
```

- [ ] **Step 5: Typecheck (VM wiring lands in Task 7)**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no NEW errors from the added handlers/state (they compile standalone; they're referenced by the VM in Task 7).

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/app/one/location/page.tsx
git commit -s -m "feat(one-location): SOS panic trigger/stop handlers + incident state"
```

---

## Task 7: Frontend — VM fields + render `SosPanel` in `NowHub`

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx` (`LocationHubViewModel` type ~81-176; `NowHub` render ~397-535; imports)
- Modify: `hushh-webapp/app/one/location/page.tsx` (VM object literal ~4182-4263)

**Interfaces:**
- Consumes: `SosPanel` (Task 5); handlers/state from Task 6.
- Produces: `LocationHubViewModel` gains `sosRecipients`, `sosActive`, `sosBusy`, `sosStartedAtLabel`, `onTriggerSos`, `onStopSos`.

- [ ] **Step 1: Add SOS fields to `LocationHubViewModel`**

In `location-redesign-hub.tsx`, inside the `LocationHubViewModel` type (add near the actions block, before the label helpers):

```ts
  /* SOS panic */
  sosRecipients: OneLocationRecipient[];
  sosActive: boolean;
  sosBusy: boolean;
  sosStartedAtLabel: string | null;
  onTriggerSos: () => void;
  onStopSos: () => void;
```

- [ ] **Step 2: Import and render `SosPanel` in `NowHub`**

Add the import at the top of `location-redesign-hub.tsx`:

```ts
import { SosPanel } from "@/components/one-location/redesign/sos-panel";
```

In `NowHub` (~397-535), render the panel immediately after the 2-col "Share my location / Ask someone" grid (~line 477), before the "Active shares" `SectionCard`:

```tsx
<SosPanel
  recipients={vm.sosRecipients}
  active={vm.sosActive}
  busy={vm.sosBusy}
  startedAtLabel={vm.sosStartedAtLabel}
  onTrigger={vm.onTriggerSos}
  onStop={vm.onStopSos}
  recipientLabel={vm.recipientLabel}
  isRecipientShareReady={vm.isRecipientShareReady}
/>
```

- [ ] **Step 3: Wire the VM fields in page.tsx**

In the `locationHubVm` object literal (~4182-4263), add:

```ts
  sosRecipients: rankedRecipients,
  sosActive: Boolean(sosIncident?.grantIds.length),
  sosBusy: busy === "sos",
  sosStartedAtLabel: sosIncident ? formatDateTime(sosIncident.startedAt) : null,
  onTriggerSos: () => void handleTriggerSos(),
  onStopSos: () => void handleStopSos(),
```

> `rankedRecipients`, `busy`, and `formatDateTime` already exist in this scope (used elsewhere in the VM build). `formatDateTime` is the same helper wired to `vm.formatDateTime`.

- [ ] **Step 4: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no type errors (VM type, page build, and `NowHub` render all agree).

- [ ] **Step 5: Run the affected component tests**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign`
Expected: PASS (existing hub tests + the new SosPanel test).

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx hushh-webapp/app/one/location/page.tsx
git commit -s -m "feat(one-location): render SosPanel in Now tab and wire view model"
```

---

## Task 8: Frontend — seed step in `PostUnlockSyncService.run`

**Files:**
- Modify: `hushh-webapp/lib/services/post-unlock-sync-service.ts`
- Test: `hushh-webapp/lib/services/__tests__/post-unlock-sync-service.sos.test.ts` (create)

**Interfaces:**
- Consumes: `OneLocationService.seedTrustedContacts` (Task 3), existing `KaiProfileSyncService.syncPendingToVault`.
- Produces: `run(...)` return shape gains `sosSeeded: boolean`; the seed runs once per post-unlock, isolated by its own `.catch` so it can't abort onboarding sync.

- [ ] **Step 1: Write the failing test**

```ts
// hushh-webapp/lib/services/__tests__/post-unlock-sync-service.sos.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: vi.fn(async () => ({ synced: true })),
  },
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    seedTrustedContacts: vi.fn(async () => ({
      seeded: 3,
      existingCount: 0,
      skippedSelf: 0,
    })),
  },
}));

import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { OneLocationService } from "@/lib/one-location/service";

const params = { userId: "u1", vaultKey: "vk", vaultOwnerToken: "tok" };

beforeEach(() => vi.clearAllMocks());

describe("PostUnlockSyncService SOS seed", () => {
  it("calls seedTrustedContacts and reports sosSeeded", async () => {
    const result = await PostUnlockSyncService.run(params);
    expect(OneLocationService.seedTrustedContacts).toHaveBeenCalledWith({
      vaultOwnerToken: "tok",
    });
    expect(result.sosSeeded).toBe(true);
    expect(result.onboardingSynced).toBe(true);
  });

  it("does not throw when seeding fails", async () => {
    (OneLocationService.seedTrustedContacts as unknown as vi.Mock).mockRejectedValueOnce(
      new Error("boom"),
    );
    const result = await PostUnlockSyncService.run(params);
    expect(result.sosSeeded).toBe(false);
    expect(result.onboardingSynced).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/services/__tests__/post-unlock-sync-service.sos.test.ts`
Expected: FAIL — `seedTrustedContacts` not called; `sosSeeded` undefined.

- [ ] **Step 3: Add the seed step**

Replace the body of `PostUnlockSyncService.run` in `lib/services/post-unlock-sync-service.ts`:

```ts
import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { OneLocationService } from "@/lib/one-location/service";

export class PostUnlockSyncService {
  static async run(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<{ onboardingSynced: boolean; sosSeeded: boolean }> {
    const syncResult = await KaiProfileSyncService.syncPendingToVault({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch((error) => {
      console.warn("[PostUnlockSyncService] Pending onboarding sync failed:", error);
      return { synced: false };
    });

    // Seed trusted contacts (idempotent, gated server-side on zero connections)
    // so a fresh user has SOS recipients. Isolated: a failure here must not
    // abort onboarding sync.
    const seedResult = await OneLocationService.seedTrustedContacts({
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch((error) => {
      console.warn("[PostUnlockSyncService] SOS trusted-contact seed failed:", error);
      return { seeded: 0, existingCount: 0, skippedSelf: 0 };
    });

    return {
      onboardingSynced: Boolean(syncResult.synced),
      sosSeeded: Boolean(seedResult.seeded),
    };
  }
}
```

> Keep the existing file header comment; only the imports, signature return type, and body change. The `PostAuthOnboardingSyncBridge` needs no change (it only awaits `run`).

- [ ] **Step 4: Run test + typecheck**

Run: `cd hushh-webapp && npx vitest run lib/services/__tests__/post-unlock-sync-service.sos.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/services/post-unlock-sync-service.ts hushh-webapp/lib/services/__tests__/post-unlock-sync-service.sos.test.ts
git commit -s -m "feat(one-location): seed trusted SOS contacts on post-unlock"
```

---

## Task 9: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `cd consent-protocol && python -m pytest tests/test_one_location_sos_seed.py tests/test_one_location_seed_route.py -v`
Then the existing One Location suite: `python -m pytest tests/ -k "one_location" -v`
Expected: all PASS.

- [ ] **Step 2: Frontend tests + typecheck**

Run: `cd hushh-webapp && npx vitest run lib/one-location components/one-location/redesign lib/services && npx tsc --noEmit`
Expected: all PASS; no type errors.

- [ ] **Step 3: Tri-flow governance bundle**

Run:
```bash
cd hushh-webapp && npm run verify:service-boundary && npm run verify:routes && npm run verify:design-system
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research && ./bin/hushh protocol test-ci
```
Expected: all pass. (`verify:routes` should recognize the new `/api/one/location/seed-trusted` route; if it requires a route-contract doc entry, add it per the failure message.)

- [ ] **Step 4: Configure dev accounts + manual smoke**

Set the env for the backend: `SOS_SEED_DEV_USER_IDS="<dev1>,<dev2>,<dev3>"` (phone-verified accounts that have opened One Location once). Then:
1. Log in as a fresh user → open One → the post-unlock bridge seeds trusted contacts.
2. Open Location `Now` tab → SOS panel lists the dev contacts (ready ones show a green dot).
3. Tap **TAP TO PANIC** → countdown appears → tap **Cancel** → no grants created (verify no new active shares).
4. Tap again → let it elapse → toast confirms; dev recipients receive an FCM/in-app notification; **LIVE LOCATION ACTIVE** banner shows; "Active shares" lists the SOS grants.
5. Confirm recipients can view live position updates as you move.
6. Tap **I'm safe — Stop sharing** → banner clears; grants flip to revoked; watch stops.
7. Reload mid-incident (before stopping) → banner persists (localStorage) and reconciles to still-active grants; verify 8h expiry is the backstop.
8. Confirm no coordinates leak: inspect `one_location_events` rows and the FCM payloads contain no lat/long.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A && git commit -s -m "test(one-location): verify SOS panic end to end"
```

---

## Self-Review

**Spec coverage:**
- Full real delivery (grants + envelopes + notify + audit) → Task 6 (`handleTriggerSos` reuses `createGrant` + `publishEnvelopeWithRetry`; notifications/audit fire inside `create_grant`; live updates via the existing watch effect).
- Alert ALL trusted contacts (toggles display-only) → Task 5 (read-only list) + Task 6 (loops all share-ready).
- Tap + countdown to cancel → Task 5 (`SosPanel` countdown, default 5s, tested at 3s).
- "I'm safe" + 8h cap → Task 6 (`handleStopSos` revokes incident grants) + `durationHours: 8` (Task 6) as backstop.
- Login seed to configured dev IDs, gated on zero connections → Tasks 1, 2, 8.
- SOS grant tag `reason:'sos_panic'` → Task 3 (frontend sends it) + backend already persists it.
- Active-incident tracking without backend serializer change → Task 4 (localStorage) + Task 6 (hydrate/reconcile).
- Destructive/critical palette → Task 5.
- No new tables/migration; reuse `one_location_*` pipeline; never touch `kai_location_*` → Tasks 1–8 add only one method, one route, one env var, UI, and a client seed call.
- No silent skip of not-ready contacts → Task 6 toast ("Alerted N of M") + Task 5 "Not ready" marker.

**Placeholder scan:** No unresolved-marker tokens. Every code step has concrete code. Line numbers are approximate (marked `~`) because files drift; each step names the anchoring symbol. Three bounded "confirm the exact import/mock path" notes exist (Task 3 `apiJson`, Task 5 `Button`, Task 4 test env) — each names how to confirm and what to assert.

**Type consistency:** `SosIncident = { grantIds: string[]; startedAt: string }` identical across Tasks 4, 6. `seedTrustedContacts` returns `{ seeded, existingCount, skippedSelf }` in Tasks 2 (backend), 3 (client), 8 (consumer). `createGrant` gains optional `reason?: string` (Task 3), passed as `"sos_panic"` (Task 6). VM SOS fields (`sosRecipients`, `sosActive`, `sosBusy`, `sosStartedAtLabel`, `onTriggerSos`, `onStopSos`) match between the type (Task 7 hub), the build (Task 7 page), and `SosPanel` props (Task 5). `reason` value is `"sos_panic"` everywhere (Tasks 3, 6, spec).

**Known limitation (documented, not silent):** if localStorage is unavailable, the LIVE banner degrades to session-only; grants still auto-expire at 8h and remain individually stoppable in "Active shares".
