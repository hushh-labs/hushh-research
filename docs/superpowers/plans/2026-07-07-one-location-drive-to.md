# Drive To — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a One Location user search a destination and share their live location + a live-updating ETA with selected trusted connections, reusing the existing E2E-encrypted share pipeline.

**Architecture:** A new full-screen `DriveToFlow` (cloned from `CheckInFlow`) collects a destination (Google Places, via a backend proxy), trusted-connection recipients, and a duration. On start, the app computes an ETA (Google Routes API, via the same backend proxy), creates one grant per recipient marked `drive_to`, and publishes an encrypted envelope whose payload carries `{ ...point, drive: { destination, etaSeconds, distanceMeters, etaComputedAt } }`. The existing movement loop re-publishes as the user moves, recomputing ETA on a throttle. Recipients see destination + live ETA on the existing keyless map viewers. Destination and ETA live only inside the encrypted envelope — the backend never sees them.

**Tech Stack:** Next.js (React 18, TypeScript, Tailwind), FastAPI (Python), httpx, Google Places API (New) + Google Routes API, Web Crypto (ECDH-P256 + AES-GCM), IndexedDB.

## Global Constraints

- Maps key is **server-side only**: `GOOGLE_MAPS_API_KEY` in `consent-protocol` env. NEVER expose it to the browser; NEVER use the `NEXT_PUBLIC_` prefix. All Places/Routes calls go through the backend proxy.
- Destination, ETA, distance, and route data are **sensitive** and must travel ONLY inside the encrypted envelope payload (extend `PlainLocationPoint.drive`). Never store them in a plaintext DB column, grant `metadata`, or a notification body.
- **No new DB tables and no schema migration.** Grant kind uses the existing `reason` marker → `_classify_share_kind` path.
- Grant duration is bounded `0 < hours <= 24` (backend `CreateGrantRequest.duration_hours` = `Field(gt=0, le=24)`). Do not exceed 24h.
- ETA recompute throttle: recompute at most once per **60s** or **250m** moved. Constants: `DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS = 60_000`, `DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS = 250`.
- Reuse existing helpers; do not duplicate the crypto, grant, envelope, movement-loop, or trusted-circle logic.
- Frontend commit messages use `feat(location): …` / `test(location): …`; backend the same. Every commit ends with `Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>` and NO Claude co-author trailer.
- Google Routes ETA endpoint: `POST https://routes.googleapis.com/directions/v2:computeRoutes`, header `X-Goog-FieldMask: routes.duration,routes.distanceMeters`, `travelMode: "DRIVE"`. Duration comes back as a string like `"2398s"` — parse the trailing `s`.
- Google Places autocomplete: `POST https://places.googleapis.com/v1/places:autocomplete`, header `X-Goog-Api-Key`. Place details: `GET https://places.googleapis.com/v1/places/{placeId}` with header `X-Goog-FieldMask: id,location,displayName,formattedAddress`.

---

## File Structure

**Backend (consent-protocol):**
- Modify `hushh_mcp/runtime_settings.py` — add `google_maps_api_key` to `CoreSecuritySettings`.
- Modify `hushh_mcp/config.py` — export `GOOGLE_MAPS_API_KEY`.
- Create `hushh_mcp/services/google_maps_service.py` — httpx proxy for Places + Routes.
- Create `tests/services/test_google_maps_service.py`.
- Modify `api/routes/one/location.py` — add 3 maps proxy routes + request models.
- Create `tests/test_one_location_maps_routes.py`.
- Modify `hushh_mcp/services/one_location_agent_service.py` — `drive_to` share-kind marker, classification, notification copy.
- Modify `tests/` — extend the share-kind test (see Task 4).
- `consent-protocol/.env.example` — `GOOGLE_MAPS_API_KEY` doc line (ALREADY ADDED; verify in Task 1).

**Frontend (hushh-webapp):**
- Modify `lib/one-location/types.ts` — `DriveDestination`, `DriveSharePayload`, extend `PlainLocationPoint`, add `drive_to` to `shareKind`.
- Modify `lib/one-location/service.ts` — `placesAutocomplete`, `placeDetails`, `routeEta` static methods.
- Create `lib/one-location/drive-recents.ts` — IndexedDB recents store.
- Create `lib/one-location/__tests__/drive-recents.test.ts`.
- Create `components/one-location/redesign/drive-to-flow.tsx`.
- Create `components/one-location/redesign/__tests__/drive-to-flow.test.tsx`.
- Modify `components/one-location/redesign/location-redesign-hub.tsx` — `FlowKind`, `LocationHubViewModel.onDriveTo`, `NowHub` prop + card wiring, flow switch.
- Modify `app/one/location/page.tsx` — `handleDriveTo`, drive-session ref, drive-aware movement loop, `driveEtaText` helper, extend `LocalMapPreview`, vm `onDriveTo`, `"driveTo"` busy state.
- Modify `app/one/location/request/[token]/page-client.tsx` — render destination + ETA when `drive` payload present.
- Create `lib/agent/__tests__` not needed here.

---

## Task 1: Backend — surface `GOOGLE_MAPS_API_KEY`

**Files:**
- Modify: `consent-protocol/hushh_mcp/runtime_settings.py:142-151` (add field) and `:262-275` (populate)
- Modify: `consent-protocol/hushh_mcp/config.py:1-25`
- Verify: `consent-protocol/.env.example` has `GOOGLE_MAPS_API_KEY` (added during design)
- Test: `consent-protocol/tests/test_runtime_settings_maps.py` (create)

**Interfaces:**
- Produces: `hushh_mcp.config.GOOGLE_MAPS_API_KEY: str | None` and `CoreSecuritySettings.google_maps_api_key: str`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_runtime_settings_maps.py`:

```python
import importlib

from hushh_mcp import runtime_settings


def test_google_maps_api_key_is_read_from_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "x" * 64)
    monkeypatch.setenv("VAULT_DATA_KEY", "a" * 64)
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "test-maps-key")
    runtime_settings.get_core_security_settings.cache_clear()
    settings = runtime_settings.get_core_security_settings()
    assert settings.google_maps_api_key == "test-maps-key"
    runtime_settings.get_core_security_settings.cache_clear()


def test_google_maps_api_key_defaults_empty(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "x" * 64)
    monkeypatch.setenv("VAULT_DATA_KEY", "a" * 64)
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    runtime_settings.get_core_security_settings.cache_clear()
    settings = runtime_settings.get_core_security_settings()
    assert settings.google_maps_api_key == ""
    runtime_settings.get_core_security_settings.cache_clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/pytest tests/test_runtime_settings_maps.py -q`
Expected: FAIL — `AttributeError: 'CoreSecuritySettings' object has no attribute 'google_maps_api_key'`.

- [ ] **Step 3: Add the field to the dataclass**

In `hushh_mcp/runtime_settings.py`, in `class CoreSecuritySettings` (line 142), add the field right after `google_api_key: str` (line 145):

```python
class CoreSecuritySettings:
    app_signing_key: str
    vault_data_key: str
    google_api_key: str
    google_maps_api_key: str
    environment: str
    agent_id: str
    hushh_hackathon: bool
    default_consent_token_expiry_ms: int
    default_trust_link_expiry_ms: int
```

- [ ] **Step 4: Populate the field**

In `get_core_security_settings()` (line 262), add after `google_api_key=_clean_env("GOOGLE_API_KEY"),` (line 265):

```python
        google_api_key=_clean_env("GOOGLE_API_KEY"),
        google_maps_api_key=_clean_env("GOOGLE_MAPS_API_KEY"),
```

- [ ] **Step 5: Export from config**

In `hushh_mcp/config.py`, add after line 14 (`GOOGLE_API_KEY = ...`) and add to `__all__`:

```python
GOOGLE_API_KEY = _SETTINGS.google_api_key or None
GOOGLE_MAPS_API_KEY = _SETTINGS.google_maps_api_key or None

__all__ = [
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
    "DEFAULT_CONSENT_TOKEN_EXPIRY_MS",
    "DEFAULT_TRUST_LINK_EXPIRY_MS",
    "ENVIRONMENT",
    "AGENT_ID",
    "HUSHH_HACKATHON",
    "GOOGLE_API_KEY",
    "GOOGLE_MAPS_API_KEY",
]
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/pytest tests/test_runtime_settings_maps.py -q`
Expected: PASS (2 passed).

- [ ] **Step 7: Verify `.env.example` documents the key**

Run: `grep -n GOOGLE_MAPS_API_KEY consent-protocol/.env.example`
Expected: shows the `GOOGLE_MAPS_API_KEY=replace_with_google_maps_api_key` line with the Places/Routes comment. If missing, add it under the `GOOGLE_GENAI_USE_VERTEXAI=True` line.

- [ ] **Step 8: Commit**

```bash
git add consent-protocol/hushh_mcp/runtime_settings.py consent-protocol/hushh_mcp/config.py consent-protocol/tests/test_runtime_settings_maps.py consent-protocol/.env.example
git commit -m "feat(location): surface GOOGLE_MAPS_API_KEY runtime setting

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 2: Backend — Google Maps proxy service

**Files:**
- Create: `consent-protocol/hushh_mcp/services/google_maps_service.py`
- Test: `consent-protocol/tests/services/test_google_maps_service.py`

**Interfaces:**
- Consumes: `hushh_mcp.config.GOOGLE_MAPS_API_KEY`.
- Produces:
  - `class GoogleMapsError(RuntimeError)` with `.status_code: int`.
  - `class GoogleMapsService` with async methods:
    - `autocomplete(input_text: str, *, session_token: str | None = None) -> list[dict]` → each `{"placeId": str, "text": str}`.
    - `place_details(place_id: str) -> dict` → `{"placeId": str, "label": str, "latitude": float, "longitude": float}`.
    - `route_eta(*, origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float) -> dict` → `{"etaSeconds": int, "distanceMeters": int}`.
  - `is_configured() -> bool` (module-level) → `bool(GOOGLE_MAPS_API_KEY)`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_google_maps_service.py`:

```python
import json

import httpx
import pytest

from hushh_mcp.services import google_maps_service as gms


def _client_with(handler):
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport)


@pytest.mark.asyncio
async def test_autocomplete_parses_suggestions(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Goog-Api-Key"] == "k"
        assert json.loads(request.content.decode())["input"] == "Starbucks"
        return httpx.Response(
            200,
            json={
                "suggestions": [
                    {
                        "placePrediction": {
                            "placeId": "p1",
                            "text": {"text": "Starbucks, Market St"},
                        }
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.autocomplete("Starbucks")
    assert out == [{"placeId": "p1", "text": "Starbucks, Market St"}]


@pytest.mark.asyncio
async def test_place_details_parses_location(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/places/p1")
        return httpx.Response(
            200,
            json={
                "id": "p1",
                "displayName": {"text": "Starbucks"},
                "formattedAddress": "Market St, SF",
                "location": {"latitude": 37.79, "longitude": -122.4},
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.place_details("p1")
    assert out == {
        "placeId": "p1",
        "label": "Starbucks, Market St, SF",
        "latitude": 37.79,
        "longitude": -122.4,
    }


@pytest.mark.asyncio
async def test_route_eta_parses_duration_seconds(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert "routes.duration" in request.headers["X-Goog-FieldMask"]
        return httpx.Response(
            200,
            json={"routes": [{"duration": "2398s", "distanceMeters": 56902}]},
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.route_eta(
        origin_lat=37.77, origin_lng=-122.41, dest_lat=37.42, dest_lng=-122.08
    )
    assert out == {"etaSeconds": 2398, "distanceMeters": 56902}


@pytest.mark.asyncio
async def test_missing_key_raises(monkeypatch):
    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", None)
    svc = gms.GoogleMapsService()
    with pytest.raises(gms.GoogleMapsError) as excinfo:
        await svc.autocomplete("x")
    assert excinfo.value.status_code == 503


@pytest.mark.asyncio
async def test_upstream_error_maps_to_502(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"message": "denied"}})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    with pytest.raises(gms.GoogleMapsError) as excinfo:
        await svc.route_eta(
            origin_lat=1, origin_lng=1, dest_lat=2, dest_lng=2
        )
    assert excinfo.value.status_code == 502
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/pytest tests/services/test_google_maps_service.py -q`
Expected: FAIL — `ModuleNotFoundError: hushh_mcp.services.google_maps_service`.

- [ ] **Step 3: Implement the service**

Create `consent-protocol/hushh_mcp/services/google_maps_service.py`:

```python
"""Server-side proxy for Google Maps Platform (Places New + Routes).

Keeps the Maps key on the backend. The frontend never sees it; browser code
calls our own /api/one/location/maps/* endpoints, which call this service.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from hushh_mcp.config import GOOGLE_MAPS_API_KEY

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_PLACES_BASE = "https://places.googleapis.com"
_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"


class GoogleMapsError(RuntimeError):
    """Raised for a missing key (503) or an upstream Maps failure (502)."""

    def __init__(self, message: str, *, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(message)


def is_configured() -> bool:
    return bool(GOOGLE_MAPS_API_KEY)


def _async_client() -> httpx.AsyncClient:
    # Wrapped so tests can inject a MockTransport client.
    return httpx.AsyncClient(timeout=_TIMEOUT)


def _require_key() -> str:
    if not GOOGLE_MAPS_API_KEY:
        raise GoogleMapsError("Maps is not configured on this backend.", status_code=503)
    return GOOGLE_MAPS_API_KEY


def _parse_duration_seconds(value: Any) -> int:
    text = str(value or "").strip()
    if text.endswith("s"):
        text = text[:-1]
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return 0


class GoogleMapsService:
    async def autocomplete(
        self, input_text: str, *, session_token: str | None = None
    ) -> list[dict[str, Any]]:
        key = _require_key()
        body: dict[str, Any] = {"input": input_text}
        if session_token:
            body["sessionToken"] = session_token
        async with _async_client() as client:
            try:
                response = await client.post(
                    f"{_PLACES_BASE}/v1/places:autocomplete",
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": key,
                    },
                    json=body,
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Places autocomplete failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.autocomplete upstream %s", response.status_code)
            raise GoogleMapsError("Places autocomplete failed.", status_code=502)
        data = response.json()
        results: list[dict[str, Any]] = []
        for suggestion in data.get("suggestions", []):
            prediction = suggestion.get("placePrediction") or {}
            place_id = prediction.get("placeId")
            text = (prediction.get("text") or {}).get("text")
            if place_id and text:
                results.append({"placeId": str(place_id), "text": str(text)})
        return results

    async def place_details(self, place_id: str) -> dict[str, Any]:
        key = _require_key()
        async with _async_client() as client:
            try:
                response = await client.get(
                    f"{_PLACES_BASE}/v1/places/{place_id}",
                    headers={
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": "id,location,displayName,formattedAddress",
                    },
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Place details failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.place_details upstream %s", response.status_code)
            raise GoogleMapsError("Place details failed.", status_code=502)
        data = response.json()
        location = data.get("location") or {}
        display = (data.get("displayName") or {}).get("text") or ""
        address = data.get("formattedAddress") or ""
        label = ", ".join(part for part in (display, address) if part) or display or address
        return {
            "placeId": str(data.get("id") or place_id),
            "label": label,
            "latitude": float(location.get("latitude", 0.0)),
            "longitude": float(location.get("longitude", 0.0)),
        }

    async def route_eta(
        self,
        *,
        origin_lat: float,
        origin_lng: float,
        dest_lat: float,
        dest_lng: float,
    ) -> dict[str, Any]:
        key = _require_key()
        body = {
            "origin": {"location": {"latLng": {"latitude": origin_lat, "longitude": origin_lng}}},
            "destination": {"location": {"latLng": {"latitude": dest_lat, "longitude": dest_lng}}},
            "travelMode": "DRIVE",
        }
        async with _async_client() as client:
            try:
                response = await client.post(
                    _ROUTES_URL,
                    headers={
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
                    },
                    json=body,
                )
            except httpx.HTTPError as exc:
                raise GoogleMapsError(f"Route ETA failed: {exc}", status_code=502) from exc
        if response.status_code >= 400:
            logger.warning("maps.route_eta upstream %s", response.status_code)
            raise GoogleMapsError("Route ETA failed.", status_code=502)
        routes = response.json().get("routes") or []
        if not routes:
            raise GoogleMapsError("No route found.", status_code=502)
        route = routes[0]
        return {
            "etaSeconds": _parse_duration_seconds(route.get("duration")),
            "distanceMeters": int(route.get("distanceMeters", 0) or 0),
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/pytest tests/services/test_google_maps_service.py -q`
Expected: PASS (5 passed). If `pytest.mark.asyncio` is unrecognized, confirm `pytest-asyncio` is configured (other async tests in `tests/` use it); if needed add `import pytest_asyncio` is NOT required — the repo already runs async tests.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/google_maps_service.py consent-protocol/tests/services/test_google_maps_service.py
git commit -m "feat(location): add Google Maps proxy service (Places + Routes)

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 3: Backend — maps proxy routes

**Files:**
- Modify: `consent-protocol/api/routes/one/location.py` (add models after line 84; add routes after the recipient-keys route, near line 327)
- Test: `consent-protocol/tests/test_one_location_maps_routes.py`

**Interfaces:**
- Consumes: `GoogleMapsService`, `GoogleMapsError` from Task 2; `require_vault_owner_token` (already imported at `location.py:17`).
- Produces three authenticated endpoints:
  - `POST /api/one/location/maps/autocomplete` body `{ "input": str, "sessionToken"?: str }` → `{ "suggestions": [{placeId, text}] }`.
  - `POST /api/one/location/maps/place-details` body `{ "placeId": str }` → `{ "place": {placeId,label,latitude,longitude} }`.
  - `POST /api/one/location/maps/route-eta` body `{ "originLat","originLng","destLat","destLng" }` → `{ "eta": {etaSeconds, distanceMeters} }`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_one_location_maps_routes.py`:

```python
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one.location import router
from hushh_mcp.services import google_maps_service as gms


@pytest.fixture()
def client(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1"}
    return TestClient(app)


def test_autocomplete_route(client, monkeypatch):
    async def fake(self, input_text, *, session_token=None):
        assert input_text == "Starbucks"
        return [{"placeId": "p1", "text": "Starbucks"}]

    monkeypatch.setattr(gms.GoogleMapsService, "autocomplete", fake)
    res = client.post("/api/one/location/maps/autocomplete", json={"input": "Starbucks"})
    assert res.status_code == 200
    assert res.json()["suggestions"] == [{"placeId": "p1", "text": "Starbucks"}]


def test_place_details_route(client, monkeypatch):
    async def fake(self, place_id):
        return {"placeId": place_id, "label": "SB", "latitude": 1.0, "longitude": 2.0}

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", fake)
    res = client.post("/api/one/location/maps/place-details", json={"placeId": "p1"})
    assert res.status_code == 200
    assert res.json()["place"]["latitude"] == 1.0


def test_route_eta_route(client, monkeypatch):
    async def fake(self, *, origin_lat, origin_lng, dest_lat, dest_lng):
        return {"etaSeconds": 600, "distanceMeters": 5000}

    monkeypatch.setattr(gms.GoogleMapsService, "route_eta", fake)
    res = client.post(
        "/api/one/location/maps/route-eta",
        json={"originLat": 1, "originLng": 1, "destLat": 2, "destLng": 2},
    )
    assert res.status_code == 200
    assert res.json()["eta"] == {"etaSeconds": 600, "distanceMeters": 5000}


def test_maps_unconfigured_returns_503(client, monkeypatch):
    async def fake(self, input_text, *, session_token=None):
        raise gms.GoogleMapsError("no key", status_code=503)

    monkeypatch.setattr(gms.GoogleMapsService, "autocomplete", fake)
    res = client.post("/api/one/location/maps/autocomplete", json={"input": "x"})
    assert res.status_code == 503
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/pytest tests/test_one_location_maps_routes.py -q`
Expected: FAIL — 404 on the new routes (they don't exist yet).

- [ ] **Step 3: Add request models**

In `api/routes/one/location.py`, after `SubmitPublicInviteRequest` (ends line 84), add:

```python
class MapsAutocompleteRequest(_CamelModel):
    input: str = Field(min_length=1, max_length=200)
    session_token: str | None = Field(default=None, alias="sessionToken", max_length=120)


class MapsPlaceDetailsRequest(_CamelModel):
    place_id: str = Field(alias="placeId", min_length=1, max_length=300)


class MapsRouteEtaRequest(_CamelModel):
    origin_lat: float = Field(alias="originLat", ge=-90, le=90)
    origin_lng: float = Field(alias="originLng", ge=-180, le=180)
    dest_lat: float = Field(alias="destLat", ge=-90, le=90)
    dest_lng: float = Field(alias="destLng", ge=-180, le=180)
```

- [ ] **Step 4: Add the import and a maps error handler**

At the top of `api/routes/one/location.py`, extend the service import (currently lines 18-23) to add the maps service import right below it:

```python
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    database_error_detail,
    location_error_detail,
)
from hushh_mcp.services.google_maps_service import GoogleMapsError, GoogleMapsService
```

- [ ] **Step 5: Add the three routes**

In `api/routes/one/location.py`, after the recipient-keys route block (before `@router.post("/location/grants")` at line 329), insert:

```python
def _maps_service() -> GoogleMapsService:
    return GoogleMapsService()


@router.post("/location/maps/autocomplete")
async def maps_autocomplete(
    payload: MapsAutocompleteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)  # auth-gate only; result is not user-scoped
    try:
        suggestions = await _maps_service().autocomplete(
            payload.input, session_token=payload.session_token
        )
        return {"suggestions": suggestions}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/maps/place-details")
async def maps_place_details(
    payload: MapsPlaceDetailsRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)
    try:
        place = await _maps_service().place_details(payload.place_id)
        return {"place": place}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc


@router.post("/location/maps/route-eta")
async def maps_route_eta(
    payload: MapsRouteEtaRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _user_id(token_data)
    try:
        eta = await _maps_service().route_eta(
            origin_lat=payload.origin_lat,
            origin_lng=payload.origin_lng,
            dest_lat=payload.dest_lat,
            dest_lng=payload.dest_lng,
        )
        return {"eta": eta}
    except GoogleMapsError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": "ONE_LOCATION_MAPS_FAILED", "message": str(exc)},
        ) from exc
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/pytest tests/test_one_location_maps_routes.py -q`
Expected: PASS (4 passed).

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/api/routes/one/location.py consent-protocol/tests/test_one_location_maps_routes.py
git commit -m "feat(location): add authenticated maps proxy routes

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 4: Backend — `drive_to` share kind

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_location_agent_service.py:287-311` (marker + classify) and `:2608-2624` (notification copy)
- Test: `consent-protocol/tests/services/test_share_kind_classification.py` (create — a focused unit test on `_classify_share_kind`)

**Interfaces:**
- Consumes: frontend sends grant `reason: "drive_to"` (Task 8/9).
- Produces: `_classify_share_kind("drive_to") == "drive_to"`; grant payload `shareKind == "drive_to"`; drive-to notification copy that does NOT include the destination.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_share_kind_classification.py`:

```python
from hushh_mcp.services.one_location_agent_service import (
    _classify_share_kind,
    _visible_share_message,
)


def test_drive_to_marker_classifies_as_drive_to():
    assert _classify_share_kind("drive_to") == "drive_to"


def test_drive_to_marker_is_not_shown_as_message():
    # The "drive_to" marker is plumbing, never a human message.
    assert _visible_share_message("drive_to") is None


def test_existing_kinds_unchanged():
    assert _classify_share_kind("sos_panic") == "sos"
    assert _classify_share_kind(None) == "share"
    assert _classify_share_kind("owner_approved") == "share"
    assert _classify_share_kind("On my way!") == "check_in"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/pytest tests/services/test_share_kind_classification.py -q`
Expected: FAIL — `_classify_share_kind("drive_to")` returns `"check_in"`, and `_visible_share_message("drive_to")` returns `"drive_to"`.

- [ ] **Step 3: Add the drive-to marker and classification**

In `one_location_agent_service.py`, after `_SOS_SHARE_REASON = "sos_panic"` (line 289) add:

```python
_SOS_SHARE_REASON = "sos_panic"

# Grant "reason" marker for a Drive-To share. The destination and ETA never live
# here (they are inside the encrypted envelope); this marker only tags the kind.
_DRIVE_TO_SHARE_REASON = "drive_to"
```

Update `_INTERNAL_SHARE_REASONS` (line 295) to include it:

```python
_INTERNAL_SHARE_REASONS = {
    "owner_approved",
    "request_approved",
    _SOS_SHARE_REASON,
    _DRIVE_TO_SHARE_REASON,
}
```

Update `_classify_share_kind` (line 306-311) so the drive marker is recognized BEFORE the generic "treat as check-in" fallback:

```python
    text = " ".join(str(reason or "").split()).lower()
    if text == _SOS_SHARE_REASON:
        return "sos"
    if text == _DRIVE_TO_SHARE_REASON:
        return "drive_to"
    if not text or text in {"owner_approved", "request_approved"}:
        return "share"
    return "check_in"
```

- [ ] **Step 4: Add drive-to notification copy**

In `create_grant`, in the notification-copy block (lines 2610-2624), add a `drive_to` branch. The body must NOT include the destination (it is encrypted):

```python
        share_kind = _classify_share_kind(reason)
        share_message = _visible_share_message(reason)
        if share_kind == "sos":
            notification_title = "SOS alert"
            notification_body = (
                f"{owner_label} triggered an SOS and is sharing live location with you."
            )
        elif share_kind == "drive_to":
            notification_title = "Drive shared"
            notification_body = (
                f"{owner_label} started sharing their drive and live ETA with you."
            )
        elif share_kind == "check_in":
            notification_title = "Check-in shared"
            notification_body = (
                f"{owner_label}: {share_message}"
                if share_message
                else f"{owner_label} checked in and shared their location with you."
            )
        else:
            notification_title = "Location shared"
            notification_body = f"{owner_label} shared location access with you."
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/pytest tests/services/test_share_kind_classification.py -q`
Expected: PASS (3 passed).

- [ ] **Step 6: Run the existing location service tests to confirm no regressions**

Run: `cd consent-protocol && .venv/bin/pytest tests/services/test_one_location_agent_service.py -q`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_location_agent_service.py consent-protocol/tests/services/test_share_kind_classification.py
git commit -m "feat(location): classify drive_to share kind with dedicated copy

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 5: Frontend — types for the drive payload

**Files:**
- Modify: `hushh-webapp/lib/one-location/types.ts:159` (shareKind union) and `:318-324` (`PlainLocationPoint`)
- Test: none (type-only; validated by `tsc` in later tasks)

**Interfaces:**
- Produces:
  - `DriveDestination = { label: string; latitude: number; longitude: number; placeId?: string | null }`
  - `DriveSharePayload = { destination: DriveDestination; etaSeconds: number | null; distanceMeters: number | null; etaComputedAt: string }`
  - `PlainLocationPoint.drive?: DriveSharePayload | null`
  - `OneLocationGrant.shareKind` includes `"drive_to"`.

- [ ] **Step 1: Add the drive types and extend `PlainLocationPoint`**

In `types.ts`, replace the `PlainLocationPoint` definition (lines 318-324) with:

```typescript
export type DriveDestination = {
  label: string;
  latitude: number;
  longitude: number;
  placeId?: string | null;
};

/**
 * Drive-To payload carried INSIDE the encrypted envelope (never sent to the
 * backend in plaintext). Recipients decrypt the point and read destination +
 * latest ETA from here.
 */
export type DriveSharePayload = {
  destination: DriveDestination;
  etaSeconds: number | null;
  distanceMeters: number | null;
  etaComputedAt: string;
};

export type PlainLocationPoint = {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  capturedAt: string;
  sourcePlatform: LocationSourcePlatform;
  /**
   * Present only for Drive-To shares. Encrypted together with the point, so the
   * backend never sees the destination or ETA.
   */
  drive?: DriveSharePayload | null;
};
```

- [ ] **Step 2: Add `drive_to` to the shareKind union**

In `types.ts`, update `OneLocationGrant.shareKind` (line 159):

```typescript
  shareKind?: "sos" | "check_in" | "share" | "drive_to" | string | null;
```

- [ ] **Step 3: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: PASS (no new errors — `drive` is optional, so existing code compiles).

- [ ] **Step 4: Commit**

```bash
git add hushh-webapp/lib/one-location/types.ts
git commit -m "feat(location): add Drive-To payload types

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 6: Frontend — maps service methods

**Files:**
- Modify: `hushh-webapp/lib/one-location/service.ts` (add methods inside `OneLocationService`, after `viewEnvelope` near line 370)
- Test: `hushh-webapp/lib/one-location/__tests__/service-maps.test.ts` (create)

**Interfaces:**
- Consumes: backend routes from Task 3; `apiJson`, `jsonAuthHeaders` (already in `service.ts`).
- Produces static methods on `OneLocationService`:
  - `placesAutocomplete({ vaultOwnerToken, input, sessionToken? }) : Promise<{ placeId: string; text: string }[]>`
  - `placeDetails({ vaultOwnerToken, placeId }) : Promise<DriveDestination>`
  - `routeEta({ vaultOwnerToken, originLat, originLng, destLat, destLng }) : Promise<{ etaSeconds: number; distanceMeters: number }>`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/service-maps.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

import { OneLocationService } from "@/lib/one-location/service";
import * as apiClient from "@/lib/services/api-client";

describe("OneLocationService maps methods", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("placesAutocomplete posts input and returns suggestions", async () => {
    const spy = vi
      .spyOn(apiClient, "apiJson")
      .mockResolvedValue({ suggestions: [{ placeId: "p1", text: "SB" }] } as never);
    const out = await OneLocationService.placesAutocomplete({
      vaultOwnerToken: "t",
      input: "SB",
    });
    expect(out).toEqual([{ placeId: "p1", text: "SB" }]);
    expect(spy).toHaveBeenCalledWith(
      "/api/one/location/maps/autocomplete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("placeDetails returns a DriveDestination", async () => {
    vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      place: { placeId: "p1", label: "SB", latitude: 1, longitude: 2 },
    } as never);
    const out = await OneLocationService.placeDetails({
      vaultOwnerToken: "t",
      placeId: "p1",
    });
    expect(out).toEqual({ placeId: "p1", label: "SB", latitude: 1, longitude: 2 });
  });

  it("routeEta returns eta seconds + distance", async () => {
    vi.spyOn(apiClient, "apiJson").mockResolvedValue({
      eta: { etaSeconds: 600, distanceMeters: 5000 },
    } as never);
    const out = await OneLocationService.routeEta({
      vaultOwnerToken: "t",
      originLat: 1,
      originLng: 1,
      destLat: 2,
      destLng: 2,
    });
    expect(out).toEqual({ etaSeconds: 600, distanceMeters: 5000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/service-maps.test.ts`
Expected: FAIL — `OneLocationService.placesAutocomplete is not a function`.

- [ ] **Step 3: Add the methods**

In `service.ts`, add the `DriveDestination` import to the type import block (lines 3-20) and add three methods after `viewEnvelope` (after line 370). First extend the import:

```typescript
  OneLocationReferral,
  OneLocationState,
  PlainLocationPoint,
  DriveDestination,
} from "@/lib/one-location/types";
```

Then add the methods inside the class:

```typescript
  static async placesAutocomplete(params: {
    vaultOwnerToken: string;
    input: string;
    sessionToken?: string;
  }): Promise<{ placeId: string; text: string }[]> {
    const response = await apiJson<{
      suggestions: { placeId: string; text: string }[];
    }>("/api/one/location/maps/autocomplete", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        input: params.input,
        ...(params.sessionToken ? { sessionToken: params.sessionToken } : {}),
      }),
    });
    return response.suggestions ?? [];
  }

  static async placeDetails(params: {
    vaultOwnerToken: string;
    placeId: string;
  }): Promise<DriveDestination> {
    const response = await apiJson<{ place: DriveDestination }>(
      "/api/one/location/maps/place-details",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ placeId: params.placeId }),
      },
    );
    return response.place;
  }

  static async routeEta(params: {
    vaultOwnerToken: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
  }): Promise<{ etaSeconds: number; distanceMeters: number }> {
    const response = await apiJson<{
      eta: { etaSeconds: number; distanceMeters: number };
    }>("/api/one/location/maps/route-eta", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        originLat: params.originLat,
        originLng: params.originLng,
        destLat: params.destLat,
        destLng: params.destLng,
      }),
    });
    return response.eta;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/service-maps.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/one-location/service.ts hushh-webapp/lib/one-location/__tests__/service-maps.test.ts
git commit -m "feat(location): add maps proxy client methods

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 7: Frontend — recent destinations store (IndexedDB)

**Files:**
- Create: `hushh-webapp/lib/one-location/drive-recents.ts`
- Test: `hushh-webapp/lib/one-location/__tests__/drive-recents.test.ts`

**Interfaces:**
- Consumes: `DriveDestination` type.
- Produces:
  - `loadRecentDestinations(userId: string): Promise<DriveDestination[]>` (most-recent first, max 5)
  - `addRecentDestination(userId: string, destination: DriveDestination): Promise<void>` (dedupes by `placeId` else `label`, caps at 5)

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/lib/one-location/__tests__/drive-recents.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";

import {
  addRecentDestination,
  loadRecentDestinations,
} from "@/lib/one-location/drive-recents";

const dest = (label: string, placeId?: string) => ({
  label,
  latitude: 1,
  longitude: 2,
  placeId: placeId ?? null,
});

describe("drive-recents", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty when none stored", async () => {
    expect(await loadRecentDestinations("u1")).toEqual([]);
  });

  it("adds most-recent first", async () => {
    await addRecentDestination("u1", dest("A", "a"));
    await addRecentDestination("u1", dest("B", "b"));
    const out = await loadRecentDestinations("u1");
    expect(out.map((d) => d.label)).toEqual(["B", "A"]);
  });

  it("dedupes by placeId and caps at 5", async () => {
    for (const l of ["A", "B", "C", "D", "E", "F"]) {
      await addRecentDestination("u1", dest(l, l.toLowerCase()));
    }
    await addRecentDestination("u1", dest("A2", "a")); // same placeId as A
    const out = await loadRecentDestinations("u1");
    expect(out).toHaveLength(5);
    expect(out[0]!.label).toBe("A2");
    expect(out.filter((d) => d.placeId === "a")).toHaveLength(1);
  });

  it("scopes by userId", async () => {
    await addRecentDestination("u1", dest("A", "a"));
    expect(await loadRecentDestinations("u2")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/drive-recents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `hushh-webapp/lib/one-location/drive-recents.ts`. Uses `localStorage` (available in jsdom + browser; simpler and sufficient for ≤5 non-sensitive recents; stays client-only per the spec):

```typescript
import type { DriveDestination } from "@/lib/one-location/types";

const MAX_RECENTS = 5;

function storageKey(userId: string): string {
  return `hushh.one-location.drive-recents.${userId}`;
}

function keyOf(destination: DriveDestination): string {
  return (destination.placeId || destination.label || "").trim().toLowerCase();
}

function readStore(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function loadRecentDestinations(
  userId: string,
): Promise<DriveDestination[]> {
  const store = readStore();
  if (!store || !userId) return [];
  try {
    const raw = store.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DriveDestination[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export async function addRecentDestination(
  userId: string,
  destination: DriveDestination,
): Promise<void> {
  const store = readStore();
  if (!store || !userId) return;
  const existing = await loadRecentDestinations(userId);
  const deduped = existing.filter((item) => keyOf(item) !== keyOf(destination));
  const next = [destination, ...deduped].slice(0, MAX_RECENTS);
  try {
    store.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // best-effort; recents are non-critical
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run lib/one-location/__tests__/drive-recents.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/one-location/drive-recents.ts hushh-webapp/lib/one-location/__tests__/drive-recents.test.ts
git commit -m "feat(location): add recent destinations store

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 8: Frontend — `DriveToFlow` component

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/drive-to-flow.tsx`
- Test: `hushh-webapp/components/one-location/redesign/__tests__/drive-to-flow.test.tsx`

**Interfaces:**
- Consumes: `LocationHubViewModel` (extended in Task 9 with `onDriveTo`, `driveBusy`, `vaultOwnerToken`, `placesAutocomplete`/`placeDetails` are called through the service directly using `vm.vaultOwnerToken`). To avoid a circular dependency on Task 9, this component reads the following NEW vm fields (added in Task 9): `vm.vaultOwnerToken: string | null`, `vm.onDriveTo: (destination: DriveDestination, recipientIds: string[], durationHours: string) => void`, `vm.driveBusy: boolean`, `vm.recentDestinations: DriveDestination[]`. It reuses existing vm fields: `sosRecipients`, `isRecipientShareReady`, `recipientLabel`, `recipientSubtitle`, `myLocationPoint`, `myLocationError`, `onShowMyLocation`, `renderMapPreview`, `formatDateTime`, `busy`.
- Produces: `export function DriveToFlow({ vm, onClose }: { vm: LocationHubViewModel; onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/components/one-location/redesign/__tests__/drive-to-flow.test.tsx`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { DriveToFlow } from "@/components/one-location/redesign/drive-to-flow";
import { OneLocationService } from "@/lib/one-location/service";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { DriveDestination, PlainLocationPoint } from "@/lib/one-location/types";

const point: PlainLocationPoint = {
  latitude: 37.7,
  longitude: -122.4,
  capturedAt: new Date("2026-07-07T00:00:00Z").toISOString(),
  sourcePlatform: "web",
};

function makeVm(overrides: Partial<LocationHubViewModel> = {}): LocationHubViewModel {
  return {
    vaultOwnerToken: "token",
    onDriveTo: vi.fn(),
    driveBusy: false,
    recentDestinations: [],
    sosRecipients: [
      {
        userId: "r1",
        displayName: "Carol",
        keyId: "k1",
        publicKeyJwk: {} as JsonWebKey,
        canReceiveLocation: true,
      },
    ],
    isRecipientShareReady: () => true,
    recipientLabel: (r) => r.displayName ?? r.userId,
    recipientSubtitle: () => "Trusted",
    myLocationPoint: point,
    myLocationError: null,
    onShowMyLocation: vi.fn(),
    renderMapPreview: () => <div data-testid="map" />,
    formatDateTime: () => "now",
    busy: null,
  } as unknown as LocationHubViewModel;
}

describe("DriveToFlow", () => {
  it("searches destinations and starts a drive share", async () => {
    vi.spyOn(OneLocationService, "placesAutocomplete").mockResolvedValue([
      { placeId: "p1", text: "Starbucks, Market St" },
    ]);
    vi.spyOn(OneLocationService, "placeDetails").mockResolvedValue({
      placeId: "p1",
      label: "Starbucks, Market St",
      latitude: 37.79,
      longitude: -122.4,
    } as DriveDestination);

    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/where are you headed/i), {
      target: { value: "Starbucks" },
    });

    const suggestion = await screen.findByText("Starbucks, Market St");
    fireEvent.click(suggestion);

    // Recipient is pre-selected; start the share.
    const startBtn = await screen.findByRole("button", { name: /start sharing route/i });
    await waitFor(() => expect(startBtn).not.toBeDisabled());
    fireEvent.click(startBtn);

    await waitFor(() =>
      expect(vm.onDriveTo).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: "p1", latitude: 37.79 }),
        ["r1"],
        expect.any(String),
      ),
    );
  });

  it("disables start until a destination is chosen", () => {
    const vm = makeVm();
    render(<DriveToFlow vm={vm} onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /choose a destination/i }),
    ).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/drive-to-flow.test.tsx`
Expected: FAIL — module not found (and `LocationHubViewModel` won't yet have the new fields; that's fine, the test casts).

- [ ] **Step 3: Implement `DriveToFlow`**

Create `hushh-webapp/components/one-location/redesign/drive-to-flow.tsx`. Mirrors `check-in-flow.tsx` structure (header, destination search, recipient picker, duration, action bar):

```typescript
"use client";

/**
 * One Location redesign — Drive To flow (Quick Action).
 *
 * "Share your route and ETA." Search a destination (Google Places via the
 * backend proxy), pick trusted connections, and share live location + a
 * live-updating ETA. Destination + ETA travel inside the encrypted envelope;
 * this component only collects intent and calls `vm.onDriveTo`.
 */

import { useEffect, useMemo, useState } from "react";
import { Car, Check, Clock, MapPin, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OneLocationService } from "@/lib/one-location/service";
import type { DriveDestination } from "@/lib/one-location/types";

import { TaskFlowHeader } from "./primitives";
import { CARD_SURFACE, MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import type { LocationHubViewModel } from "./location-redesign-hub";

const DRIVE_DURATIONS: { value: string; label: string }[] = [
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
  { value: "4", label: "4 hours" },
];

function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 1) || "?").toUpperCase();
}

function avatarTone(index: number): string {
  const tones = [
    "bg-red-500 text-white",
    "bg-sky-500 text-white",
    "bg-violet-500 text-white",
    "bg-emerald-500 text-white",
    "bg-amber-500 text-white",
  ];
  return tones[index % tones.length]!;
}

export function DriveToFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const contacts = vm.sosRecipients;
  const busy = vm.driveBusy || vm.busy === "selfLocation";

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ placeId: string; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [destination, setDestination] = useState<DriveDestination | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [durationValue, setDurationValue] = useState("2");
  const [seeded, setSeeded] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Pre-select the whole ready trusted circle (narrowable), per the spec.
  useEffect(() => {
    if (seeded) return;
    const ready = contacts.filter((r) => vm.isRecipientShareReady(r));
    if (contacts.length > 0) {
      setCheckedIds(ready.map((r) => r.userId));
      setSeeded(true);
    }
  }, [contacts, seeded, vm]);

  // Debounced Places autocomplete via the backend proxy.
  useEffect(() => {
    const token = vm.vaultOwnerToken;
    const q = query.trim();
    if (!token || q.length < 2 || destination?.label === q) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const handle = setTimeout(async () => {
      try {
        const results = await OneLocationService.placesAutocomplete({
          vaultOwnerToken: token,
          input: q,
        });
        if (!cancelled) setSuggestions(results);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setSearchError("Couldn't search places. Check your connection.");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, vm.vaultOwnerToken, destination?.label]);

  const selectSuggestion = async (placeId: string, text: string) => {
    const token = vm.vaultOwnerToken;
    if (!token) return;
    setQuery(text);
    setSuggestions([]);
    try {
      const details = await OneLocationService.placeDetails({
        vaultOwnerToken: token,
        placeId,
      });
      setDestination(details);
    } catch {
      setSearchError("Couldn't load that place. Try another.");
    }
  };

  const selectRecent = (recent: DriveDestination) => {
    setDestination(recent);
    setQuery(recent.label);
    setSuggestions([]);
  };

  const toggle = (id: string) =>
    setCheckedIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );

  const selectedReadyCount = useMemo(
    () =>
      contacts.filter(
        (r) => checkedIds.includes(r.userId) && vm.isRecipientShareReady(r),
      ).length,
    [contacts, checkedIds, vm],
  );

  const point = vm.myLocationPoint;
  const canStart = Boolean(destination) && Boolean(point) && selectedReadyCount > 0;

  const startLabel = !destination
    ? "Choose a destination"
    : !point
      ? "Capture your location first"
      : selectedReadyCount === 0
        ? "Select who to share with"
        : "Start Sharing Route";

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Drive To"
        title="Share your route and ETA"
        onBack={onClose}
      />

      {/* WHERE ARE YOU HEADED? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Where are you headed?
        </p>
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setDestination(null);
            }}
            placeholder="Where are you headed?"
            className="h-11 w-full rounded-[14px] border border-border/70 bg-background pl-10 pr-4 text-base text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-[#d4a574]/25"
          />
        </div>

        {searchError ? (
          <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
            {searchError}
          </p>
        ) : null}

        {/* Recents (shown when not actively searching) */}
        {!query.trim() && vm.recentDestinations.length > 0 ? (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Recent
            </p>
            {vm.recentDestinations.map((recent) => (
              <button
                key={recent.placeId ?? recent.label}
                type="button"
                onClick={() => selectRecent(recent)}
                className={cn(SUBCARD_SURFACE, "flex w-full items-center gap-3 p-3 text-left hover:border-[#d4a574]/40")}
              >
                <MapPin className="h-4 w-4 shrink-0 text-[#d4a574]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {recent.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Autocomplete suggestions */}
        {suggestions.length > 0 ? (
          <div className="mt-3 space-y-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.placeId}
                type="button"
                onClick={() => void selectSuggestion(suggestion.placeId, suggestion.text)}
                className={cn(SUBCARD_SURFACE, "flex w-full items-center gap-3 p-3 text-left hover:border-[#d4a574]/40")}
              >
                <MapPin className="h-4 w-4 shrink-0 text-[#d4a574]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {suggestion.text}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {searching ? <p className={cn(MUTED_TEXT, "mt-2")}>Searching…</p> : null}

        {destination ? (
          <div className={cn(SUBCARD_SURFACE, "mt-3 flex items-center gap-2 p-3")}>
            <Car className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {destination.label}
            </span>
            <Check className="h-4 w-4 shrink-0 text-emerald-600" />
          </div>
        ) : null}
      </section>

      {/* YOUR LOCATION */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#d4a574]/12 text-[#d4a574]">
            <MapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Starting from
            </p>
            <p className="mt-0.5 text-[15px] font-semibold text-foreground">
              {point ? "Live location ready" : "Location not captured yet"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={vm.onShowMyLocation}
            isLoading={vm.busy === "selfLocation"}
            className="h-9 shrink-0 rounded-full px-3 text-xs"
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {point ? "Refresh" : "Capture"}
          </Button>
        </div>
        {vm.myLocationError ? (
          <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
            {vm.myLocationError}
          </p>
        ) : null}
      </section>

      {/* WHO SHOULD SEE IT? */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Who should see your drive?
        </p>
        <div className="space-y-2.5">
          {contacts.length ? (
            contacts.map((recipient, index) => {
              const ready = vm.isRecipientShareReady(recipient);
              const checked = checkedIds.includes(recipient.userId);
              return (
                <button
                  key={recipient.userId}
                  type="button"
                  onClick={ready ? () => toggle(recipient.userId) : undefined}
                  disabled={!ready}
                  aria-pressed={checked}
                  className={cn(
                    SUBCARD_SURFACE,
                    "flex w-full items-center gap-3 p-3 text-left transition-all duration-150",
                    ready ? "hover:border-[#d4a574]/40 active:scale-[0.99]" : "cursor-not-allowed opacity-60",
                    checked && "border-[#d4a574]/60 ring-1 ring-[#d4a574]/30",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      avatarTone(index),
                    )}
                    aria-hidden
                  >
                    {initialsOf(vm.recipientLabel(recipient))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {vm.recipientLabel(recipient)}
                    </span>
                    <span className={cn(MUTED_TEXT, "block truncate")}>
                      {ready ? vm.recipientSubtitle(recipient) : "Not ready to receive location"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors",
                      checked ? "border-[#d4a574] bg-[#d4a574] text-white" : "border-border bg-background",
                    )}
                  >
                    {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className={cn(SUBCARD_SURFACE, "p-5 text-center text-sm text-muted-foreground")}>
              No trusted contacts yet. Add people to your Circle first.
            </div>
          )}
        </div>
      </section>

      {/* DURATION */}
      <section className={cn(CARD_SURFACE, "p-4")}>
        <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          Share for
        </p>
        <div className="flex flex-wrap gap-2">
          {DRIVE_DURATIONS.map((option) => {
            const active = option.value === durationValue;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setDurationValue(option.value)}
                className={cn(
                  "h-9 rounded-full border px-4 text-sm font-medium transition-colors",
                  active
                    ? "border-[#d4a574] bg-[#d4a574] text-white"
                    : "border-border/70 bg-background text-foreground hover:border-[#d4a574]/40",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* ACTION BAR */}
      <div className="space-y-2 pt-1">
        <Button
          onClick={() =>
            destination && vm.onDriveTo(destination, checkedIds, durationValue)
          }
          disabled={!canStart}
          isLoading={busy}
          className="h-12 w-full rounded-2xl bg-sky-600 text-base font-semibold text-white hover:bg-sky-600/90 disabled:opacity-50"
        >
          <Car className="mr-1.5 h-5 w-5" />
          {startLabel}
        </Button>
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-10 w-full rounded-2xl text-sm text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/drive-to-flow.test.tsx`
Expected: PASS (2 passed). Note: this compiles against the `LocationHubViewModel` fields added in Task 9; if running this task before Task 9, the test casts `vm` so it passes, but a full `tsc` will flag the missing vm fields until Task 9 lands. Run `tsc` at the end of Task 9.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/drive-to-flow.tsx hushh-webapp/components/one-location/redesign/__tests__/drive-to-flow.test.tsx
git commit -m "feat(location): add Drive To flow component

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 9: Frontend — wire Drive To into the hub + page orchestration

This task connects the flow: hub scaffolding, the `handleDriveTo` handler, the drive-session ref, drive-aware ETA in the movement loop, and the vm wiring. It ends with a full typecheck + the Task 8 test still green.

**Files:**
- Modify: `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx` (FlowKind 207-214; import; `LocationHubViewModel` 93-205; flow switch 349-352; NowHub props 439-457 + card 555-561; NowHub render 404-416)
- Modify: `hushh-webapp/app/one/location/page.tsx` (BusyState 227; imports; drive refs; `handleDriveTo`; movement-loop ETA; recents state; vm fields 4425-4514)
- Test: reuse Task 8 test; add `hushh-webapp/app/one/location/__tests__/handle-drive-to.test.tsx` is optional — instead verify via typecheck + Task 8 + a focused handler test below.

**Interfaces:**
- Consumes: `DriveToFlow` (Task 8), `OneLocationService.routeEta`/`placeDetails` (Task 6), `addRecentDestination`/`loadRecentDestinations` (Task 7), drive types (Task 5).
- Produces on `LocationHubViewModel`: `vaultOwnerToken: string | null`, `driveBusy: boolean`, `recentDestinations: DriveDestination[]`, `onDriveTo: (destination: DriveDestination, recipientIds: string[], durationHours: string) => void`.

- [ ] **Step 1: Extend `FlowKind` and imports (hub)**

In `location-redesign-hub.tsx`, update `FlowKind` (lines 207-214):

```tsx
type FlowKind =
  | "none"
  | "share"
  | "ask"
  | "invite"
  | "temp-link"
  | "check-in"
  | "drive-to"
  | "sos";
```

Add the import near the other flow imports (the file already imports `CheckInFlow`; add alongside it):

```tsx
import { DriveToFlow } from "./drive-to-flow";
```

Add the `DriveDestination` import to the type imports from `@/lib/one-location/types` in this file.

- [ ] **Step 2: Extend `LocationHubViewModel` (hub)**

In `location-redesign-hub.tsx`, in the `LocationHubViewModel` type, add these fields inside the type (e.g. right after `onCheckIn` at line 185):

```tsx
  /* Drive To (quick action) — live location + live ETA to trusted people. */
  vaultOwnerToken: string | null;
  driveBusy: boolean;
  recentDestinations: DriveDestination[];
  onDriveTo: (
    destination: DriveDestination,
    recipientIds: string[],
    durationHours: string,
  ) => void;
```

- [ ] **Step 3: Add the flow-switch branch (hub)**

In the flow switch (lines 349-352), add a `drive-to` branch after the `check-in` branch:

```tsx
        ) : flow === "check-in" ? (
          <CheckInFlow vm={vm} onClose={closeFlow} />
        ) : flow === "drive-to" ? (
          <DriveToFlow vm={vm} onClose={closeFlow} />
        ) : flow === "sos" ? (
```

- [ ] **Step 4: Thread `onDriveTo` into `NowHub` (hub)**

In `NowHub` props (lines 439-457) add `onDriveTo: () => void;` to the destructure and the type. Then replace the Drive To card (lines 555-561):

```tsx
        <QuickActionCard
          tone="blue"
          icon={<Car className="h-6 w-6" />}
          title="Drive To"
          subtitle="Share route + ETA"
          onClick={onDriveTo}
        />
```

And in the `NowHub` render call (lines 404-416) add:

```tsx
          onCheckIn={() => setFlow("check-in")}
          onDriveTo={() => setFlow("drive-to")}
          onSos={() => setFlow("sos")}
```

- [ ] **Step 5: Typecheck the hub (expect vm errors until page wired)**

Run: `cd hushh-webapp && npx tsc --noEmit 2>&1 | grep -i drive || echo "no drive errors"`
Expected: errors that `locationHubVm` is missing `vaultOwnerToken`, `driveBusy`, `recentDestinations`, `onDriveTo` — fixed in the next steps.

- [ ] **Step 6: Add `"driveTo"` to `BusyState` (page.tsx)**

In `page.tsx`, add `"driveTo"` to the `BusyState` union (lines 227-246), e.g. after `"selfLocation"`:

```tsx
  | "selfLocation"
  | "driveTo"
```

- [ ] **Step 7: Add imports + drive refs + recents state (page.tsx)**

Add imports near the other one-location imports:

```tsx
import {
  addRecentDestination,
  loadRecentDestinations,
} from "@/lib/one-location/drive-recents";
import type { DriveDestination, DriveSharePayload } from "@/lib/one-location/types";
```

Add these constants near the other live-location constants (search `LIVE_LOCATION_MIN_MOVE_METERS`):

```tsx
const DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS = 60_000;
const DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS = 250;
```

Inside the component (near the other `useRef`/`useState` declarations, e.g. by `liveWatchIdRef`), add:

```tsx
  const driveSessionRef = useRef<{
    grantIds: Set<string>;
    destination: DriveDestination;
    etaSeconds: number | null;
    distanceMeters: number | null;
    etaComputedAt: string;
    lastEtaPoint: PlainLocationPoint | null;
    lastEtaAt: number;
  } | null>(null);
  const [recentDestinations, setRecentDestinations] = useState<DriveDestination[]>([]);
```

Load recents once when userId is known (near other effects):

```tsx
  useEffect(() => {
    if (!auth.userId) return;
    void loadRecentDestinations(auth.userId).then(setRecentDestinations);
  }, [auth.userId]);
```

- [ ] **Step 8: Add a drive-payload helper (page.tsx)**

Add this helper inside the component (it reads the current drive session and, throttled, recomputes ETA). Place it near `publishEnvelope`:

```tsx
  const drivePointForGrant = useCallback(
    async (
      grant: OneLocationGrant,
      point: PlainLocationPoint,
    ): Promise<PlainLocationPoint> => {
      const session = driveSessionRef.current;
      if (!session || !session.grantIds.has(grant.id)) return point;

      const now = Date.now();
      const movedMeters = session.lastEtaPoint
        ? locationDistanceMeters(session.lastEtaPoint, point)
        : Number.POSITIVE_INFINITY;
      const sinceMs = now - session.lastEtaAt;
      const shouldRecompute =
        !session.lastEtaPoint ||
        movedMeters >= DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS ||
        sinceMs >= DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS;

      if (shouldRecompute && vaultOwnerToken) {
        try {
          const eta = await OneLocationService.routeEta({
            vaultOwnerToken,
            originLat: point.latitude,
            originLng: point.longitude,
            destLat: session.destination.latitude,
            destLng: session.destination.longitude,
          });
          session.etaSeconds = eta.etaSeconds;
          session.distanceMeters = eta.distanceMeters;
          session.etaComputedAt = new Date().toISOString();
          session.lastEtaPoint = point;
          session.lastEtaAt = now;
        } catch {
          // Keep the last known ETA; the share still carries the moving point.
        }
      }

      const drive: DriveSharePayload = {
        destination: session.destination,
        etaSeconds: session.etaSeconds,
        distanceMeters: session.distanceMeters,
        etaComputedAt: session.etaComputedAt,
      };
      return { ...point, drive };
    },
    [vaultOwnerToken],
  );
```

- [ ] **Step 9: Make the movement loop drive-aware (page.tsx)**

In the movement-loop effect (lines 3247-3256), replace the per-grant publish so drive grants get the drive payload:

```tsx
        for (const grant of activeOwnerGrants) {
          const recipient = recipientForGrant(grant);
          if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
          const pointForGrant = await drivePointForGrant(grant, point);
          await publishEnvelopeWithRetry(
            grant,
            recipient,
            "foreground_interval",
            pointForGrant,
          );
        }
```

Add `drivePointForGrant` to that effect's dependency array (lines 3295-3301):

```tsx
  }, [
    activeOwnerGrants,
    permission?.state,
    publishEnvelopeWithRetry,
    recipientForGrant,
    drivePointForGrant,
    vaultOwnerToken,
  ]);
```

- [ ] **Step 10: Add `handleDriveTo` (page.tsx)**

Add near `handleCheckIn` (line 4033):

```tsx
  const handleDriveTo = useCallback(
    async (
      destination: DriveDestination,
      recipientIds: string[],
      durationHoursValue: string,
    ) => {
      if (!vaultOwnerToken || locationPermissionBlocksSharing(permission)) {
        toast.error("Location permission is required to share your drive.");
        return;
      }
      const selected = sosActionRecipients
        .filter((recipient) => recipientIds.includes(recipient.userId))
        .filter(isShareReadyRecipient);
      if (!selected.length) {
        toast.error("Select at least one trusted contact who is ready to receive your location.");
        return;
      }
      setBusy("driveTo");
      let successCount = 0;
      try {
        const readiness = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: true,
        });
        if (!readiness.ready || !readiness.point) {
          toast.error("Couldn't get your location — drive not shared.");
          return;
        }
        const point = readiness.point;
        const durationHoursNum = Number(durationHoursValue) || 1;

        // Initial ETA (best-effort; the share still works without it).
        let etaSeconds: number | null = null;
        let distanceMeters: number | null = null;
        try {
          const eta = await OneLocationService.routeEta({
            vaultOwnerToken,
            originLat: point.latitude,
            originLng: point.longitude,
            destLat: destination.latitude,
            destLng: destination.longitude,
          });
          etaSeconds = eta.etaSeconds;
          distanceMeters = eta.distanceMeters;
        } catch {
          // ETA unavailable — proceed with destination only.
        }

        const etaComputedAt = new Date().toISOString();
        const drive: DriveSharePayload = {
          destination,
          etaSeconds,
          distanceMeters,
          etaComputedAt,
        };
        const drivePoint: PlainLocationPoint = { ...point, drive };
        const grantIds = new Set<string>();

        for (const recipient of selected) {
          const grant = await OneLocationService.createGrant({
            vaultOwnerToken,
            recipientUserId: recipient.userId,
            recipientKeyId: recipient.keyId,
            durationHours: durationHoursNum,
            reason: "drive_to",
          });
          await publishEnvelopeWithRetry(grant, recipient, "manual", drivePoint);
          grantIds.add(grant.id);
          successCount += 1;
        }

        driveSessionRef.current = {
          grantIds,
          destination,
          etaSeconds,
          distanceMeters,
          etaComputedAt,
          lastEtaPoint: point,
          lastEtaAt: Date.now(),
        };

        if (auth.userId) {
          await addRecentDestination(auth.userId, destination);
          setRecentDestinations(await loadRecentDestinations(auth.userId));
        }

        toast.success(`Sharing your drive with ${peopleCountLabel(selected.length)}.`);
        setShareCompletedTick((value) => value + 1);
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not share your drive.");
      } finally {
        setBusy(null);
      }
    },
    [
      vaultOwnerToken,
      permission,
      sosActionRecipients,
      ensureForegroundLocationReady,
      publishEnvelopeWithRetry,
      refresh,
      auth.userId,
    ],
  );
```

- [ ] **Step 11: Add the vm fields (page.tsx)**

In the `locationHubVm` object (lines 4425-4514), add after `onCheckIn` (line 4512):

```tsx
    onCheckIn: (recipientIds, durationHoursValue, messageValue) =>
      void handleCheckIn(recipientIds, durationHoursValue, messageValue),
    vaultOwnerToken: vaultOwnerToken ?? null,
    driveBusy: busy === "driveTo",
    recentDestinations,
    onDriveTo: (destination, recipientIds, durationHoursValue) =>
      void handleDriveTo(destination, recipientIds, durationHoursValue),
  };
```

- [ ] **Step 12: Typecheck + run the flow test**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: PASS (no errors).

Run: `cd hushh-webapp && npx vitest run components/one-location/redesign/__tests__/drive-to-flow.test.tsx`
Expected: PASS (2 passed).

- [ ] **Step 13: Lint the changed files**

Run: `cd hushh-webapp && npx eslint app/one/location/page.tsx components/one-location/redesign/location-redesign-hub.tsx components/one-location/redesign/drive-to-flow.tsx --max-warnings=0`
Expected: no output (clean).

- [ ] **Step 14: Commit**

```bash
git add hushh-webapp/app/one/location/page.tsx hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx
git commit -m "feat(location): wire Drive To flow with live ETA sharing

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 10: Frontend — recipient viewers render destination + ETA

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx` — extend `LocalMapPreview` (lines 805-902) with a drive banner + add a `driveEtaText` helper near `formatDateTime` (line 297).
- Modify: `hushh-webapp/app/one/location/request/[token]/page-client.tsx` — extend `PublicLocationMap` (lines 56-103) to show destination + ETA when `point.drive` present.
- Test: `hushh-webapp/app/one/location/__tests__/drive-eta-text.test.ts` (create — unit test the ETA formatter)

**Interfaces:**
- Consumes: `PlainLocationPoint.drive` (Task 5).
- Produces: `driveEtaText(etaSeconds: number | null): string` (e.g. `600 → "~10 min away"`, `null → "ETA unavailable"`).

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/app/one/location/__tests__/drive-eta-text.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { driveEtaText } from "@/app/one/location/drive-eta";

describe("driveEtaText", () => {
  it("formats minutes", () => {
    expect(driveEtaText(600)).toBe("~10 min away");
  });
  it("formats hours + minutes", () => {
    expect(driveEtaText(3900)).toBe("~1 hr 5 min away");
  });
  it("handles arrival", () => {
    expect(driveEtaText(30)).toBe("Arriving now");
  });
  it("handles missing eta", () => {
    expect(driveEtaText(null)).toBe("ETA unavailable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run app/one/location/__tests__/drive-eta-text.test.ts`
Expected: FAIL — module `@/app/one/location/drive-eta` not found.

- [ ] **Step 3: Create the shared ETA formatter**

Create `hushh-webapp/app/one/location/drive-eta.ts` (shared by both viewers so the logic is DRY):

```typescript
/** Human ETA label from seconds. Shared by the in-app and public viewers. */
export function driveEtaText(etaSeconds: number | null): string {
  if (etaSeconds == null || !Number.isFinite(etaSeconds)) return "ETA unavailable";
  if (etaSeconds < 60) return "Arriving now";
  const totalMinutes = Math.round(etaSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `~${hours} hr ${minutes} min away`;
  return `~${minutes} min away`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run app/one/location/__tests__/drive-eta-text.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Render the drive banner in `LocalMapPreview` (page.tsx)**

Import the helper at the top of `page.tsx`:

```tsx
import { driveEtaText } from "@/app/one/location/drive-eta";
```

In `LocalMapPreview` (lines 853-863), after the "Updated {captured}…" paragraph block, add a destination + ETA banner when `point.drive` is present:

```tsx
        {point.drive ? (
          <div className="rounded-[12px] border border-sky-500/30 bg-sky-500/[0.08] p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-sky-700 dark:text-sky-300">
              <Route className="h-3.5 w-3.5" aria-hidden="true" />
              Driving to {point.drive.destination.label}
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-foreground">
              {driveEtaText(point.drive.etaSeconds)}
            </p>
          </div>
        ) : null}
```

(The existing "Directions" button below still deep-links to the current position; that's acceptable for v1. Optionally, when `point.drive` exists, the Directions link can target the destination — leave as-is for v1 to keep the change minimal.)

- [ ] **Step 6: Render destination + ETA in the public viewer (page-client.tsx)**

In `app/one/location/request/[token]/page-client.tsx`, import the helper:

```tsx
import { driveEtaText } from "@/app/one/location/drive-eta";
```

In `PublicLocationMap` (lines 79-98), after the "Updated {capturedAt}…" block, add:

```tsx
        {point.drive ? (
          <div className="rounded-[12px] border border-sky-500/30 bg-sky-500/[0.08] p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
              <Route className="h-3.5 w-3.5" aria-hidden="true" />
              Driving to {point.drive.destination.label}
            </p>
            <p className="mt-0.5 text-sm font-semibold">
              {driveEtaText(point.drive.etaSeconds)}
            </p>
          </div>
        ) : null}
```

`Route` is already imported in this file (line 9) and `PlainLocationPoint` already includes the optional `drive` field from Task 5.

- [ ] **Step 7: Typecheck + lint**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: PASS.

Run: `cd hushh-webapp && npx eslint app/one/location/page.tsx app/one/location/drive-eta.ts "app/one/location/request/[token]/page-client.tsx" --max-warnings=0`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add hushh-webapp/app/one/location/drive-eta.ts hushh-webapp/app/one/location/__tests__/drive-eta-text.test.ts hushh-webapp/app/one/location/page.tsx "hushh-webapp/app/one/location/request/[token]/page-client.tsx"
git commit -m "feat(location): show drive destination + live ETA to recipients

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

## Task 11: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Backend test suite (location-related)**

Run: `cd consent-protocol && .venv/bin/pytest tests/test_runtime_settings_maps.py tests/services/test_google_maps_service.py tests/test_one_location_maps_routes.py tests/services/test_share_kind_classification.py tests/services/test_one_location_agent_service.py -q`
Expected: all PASS.

- [ ] **Step 2: Frontend targeted tests**

Run: `cd hushh-webapp && npx vitest run lib/one-location components/one-location/redesign/__tests__ app/one/location/__tests__`
Expected: all PASS.

- [ ] **Step 3: Typecheck + lint (frontend)**

Run: `cd hushh-webapp && npx tsc --noEmit && npx eslint . --max-warnings=0`
Expected: clean.

- [ ] **Step 4: Manual smoke (use the `verify` skill or run the app)**

With `GOOGLE_MAPS_API_KEY` set in `consent-protocol/.env` and the backend + frontend running:
1. Open One Location → tap **Drive To**.
2. Type a destination → confirm autocomplete suggestions appear; select one.
3. Confirm the trusted circle is pre-selected; tap **Start Sharing Route**.
4. Confirm a success toast, and (as the recipient / via a received grant) the viewer shows "Driving to <place>" + an ETA.

Expected: end-to-end drive share works; ETA renders. If Maps is misconfigured, the share still completes and shows "ETA unavailable".

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feat/one-location-drive-to
gh pr create --base main --head feat/one-location-drive-to --title "feat(location): Drive To — live route + ETA sharing to trusted connections" --body-file docs/superpowers/plans/2026-07-07-one-location-drive-to.md
```

---

## Self-Review notes (author)

- **Spec coverage:** Places autocomplete (Task 2/3/6/8) ✓; recent destinations (Task 7/8/9) ✓; pick-from-trusted-connections pre-selected + narrowable (Task 8) ✓; manual stop (existing `onStopGrant`/revoke) + duration expiry (grant TTL) ✓; live location + live ETA (Task 9 movement-loop + throttled recompute) ✓; reuse existing viewers (Task 10) ✓; backend proxy, no NEXT_PUBLIC key (Task 1/2/3) ✓; destination/ETA in encrypted payload, no new tables (Task 5/9) ✓; `drive_to` shareKind (Task 4) ✓.
- **Manual stop UI:** Drive grants appear in `activeOwnerGrants` and are stoppable via the existing "Stop sharing" grant controls (`vm.onStopGrant`) — no new stop UI needed. When all drive grants are stopped, the movement loop naturally stops publishing to them.
- **Out of scope (per spec):** Pick Me Up, saved places, calendar meetings, arrival geofence, route polyline / Maps JS SDK on viewer.
