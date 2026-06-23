# One Location → Consent Center Integration Plan (Phase C backend)

Status: implementation-ready plan (frontend half already shipped)
Owner surface: `consent-protocol` (ConsentCenterService) + `hushh-webapp` (already wired)

## Why this doc exists

The `/consents` "Access manager" page (Requests / Active Access / History /
Relationships) renders only what `ConsentCenterService.get_center`,
`list_center`, and `get_center_summary` return. Today those methods read the
**shared consent DB + RIA IAM only**. The One Location agent persists to its own
tables (`one_location_share_grants`, `one_location_access_requests`,
`one_location_events`, `one_location_public_invites`,
`one_location_circle_invites`, `one_location_network_connections`,
`one_location_referrals`) and sends its own metadata-only FCM pushes. It only
*reads* `consent_audit` as a recommendation signal.

So location data does NOT appear in `/consents` yet. The frontend is ready
(`hushh-webapp/lib/consent/location-consent.ts` + `consent-center-page.tsx`
wiring), but it needs the backend to emit location rows in the shared
`ConsentCenterResponse` shape.

This is a trust-boundary-sensitive change. Follow the roadmap rules:
coordinate-free metadata only, data-plane classification, twice-verified.

## Contract: location → ConsentCenterEntry mapping

The frontend recognizes a location row by either:
- `metadata.request_source` starting with `one_location`, or
- `scope` starting with `cap.location.` or `attr.location.`

So every location-derived `ConsentCenterEntry` MUST set:
- `metadata.request_source = "one_location_<kind>"` (e.g. `one_location_access_request`)
- `scope = "cap.location.live.view"` (or the appropriate cap scope)
- `counterpart_type = "investor"` (One-user peer) — NOT "developer"
- `metadata.section` = focus target for deep link (`approvals` | `shared` | `my_requests` | `people`)
- optional `metadata.grant_id`, `metadata.request_id`, `metadata.requester_label`, `metadata.duration_label`

NEVER include latitude, longitude, address, map URL, or any coordinate-derived
field in metadata. The redaction guards already in
`one_location_agent_service.py` (`COORDINATE_METADATA_KEYS`,
`_contains_plaintext_location_key`) MUST be reused to assert this before
returning rows.

## Category mapping (which tab each row lands in)

| One Location source | status → tab | ConsentCenterEntry.kind |
| --- | --- | --- |
| `one_location_access_requests` where owner == user, status pending | Requests | `incoming_request` |
| `one_location_access_requests` where requester == user | Requests (outgoing) / History | `outgoing_request` |
| `one_location_share_grants` status active (owner side: "people who can see me") | Active Access | `active_grant` |
| `one_location_share_grants` received + active (recipient side) | Active Access | `active_grant` |
| `one_location_share_grants` revoked/expired | History | `history` |
| `one_location_public_invites` active | Active Access | `active_grant` |
| `one_location_public_invites` revoked/expired | History | `history` |
| `one_location_circle_invites` (Invite to One) | History/Active | `invite` |
| `one_location_events` (revoke/expire audit) | History | `history` |

## Reuse point (IMPORTANT — do not re-query raw tables)

`OneLocationAgentService.list_state(user_id=...)` ALREADY returns a clean,
coordinate-free DTO assembled from all the `one_location_*` tables. Confirmed
return keys:

- `recipients` (One Network peers, masked labels)
- `ownerGrants` (people who can see me) — each via `_grant_payload`
- `receivedGrants` (shared with me) — each via `_grant_payload`
- `requests` — each via `_request_payload`
- `referrals` — each via `_referral_payload`
- `publicInvites` — each via `_public_invite_payload`
- `circleInvites` — each via `_circle_invite_payload`
- `publicInviteSubmissions` — each via `_public_submission_payload`

The `_grant_payload` / `_request_payload` / `_public_invite_payload` helpers are
already coordinate-free (coordinates live only inside encrypted envelopes,
returned by `view_latest_envelope`, never by `list_state`). The contributor
therefore consumes `list_state` and maps DTOs → ConsentCenterEntry; it does NOT
issue its own SQL. This avoids a second data path and inherits the existing
redaction posture.

## Implementation steps

### 1. New contributor module
Create `consent-protocol/hushh_mcp/services/one_location_center_contributor.py`:

```python
class OneLocationCenterContributor:
    """Maps OneLocationAgentService.list_state DTO into coordinate-free
    ConsentCenterEntry dicts. Does NOT query one_location_* tables directly."""

    def __init__(self, location_service: OneLocationAgentService | None = None):
        self._location = location_service or OneLocationAgentService()

    def collect(self, user_id: str) -> dict[str, list[dict]]:
        state = self._location.list_state(user_id=user_id)
        return {
            "incoming_requests": self._incoming(state, user_id),
            "outgoing_requests": self._outgoing(state, user_id),
            "active_grants": self._active(state, user_id),
            "history": self._history(state, user_id),
            "invites": self._invites(state, user_id),
        }

    # each mapper builds a ConsentCenterEntry dict with:
    #   metadata.request_source = "one_location_<kind>"
    #   scope = "cap.location.live.view"
    #   counterpart_type = "investor"
    #   metadata.section / grant_id / request_id / requester_label / duration_label
    # then passes metadata through _assert_coordinate_free(...)

    @staticmethod
    def _assert_coordinate_free(metadata: dict) -> dict:
        # import COORDINATE_METADATA_KEYS + _contains_plaintext_location_key
        # from one_location_agent_service; raise if any coordinate key present.
        ...
```

Mappers read DTO fields only (`grant["id"]`, `grant["status"]`,
`grant["expiresAt"]`, `grant["recipientDisplayName"]`, etc.). No raw SQL.


### 2. Plumb into ConsentCenterService
In `consent_center_service.py`:
- `__init__`: instantiate `self._location = OneLocationCenterContributor()`.
- `get_center`: after building `incoming`, `active_entries`, `history_entries`,
  `invite_entries`, concatenate the location contributor lists and re-sort using
  the existing sort helpers. Update the `summary` counts accordingly.
- `get_center_summary`: add location pending/active/previous counts to the
  surface counts (mirror how the existing surfaces are counted).
- `list_center`: include location entries in the surface being paged
  (`pending` | `active` | `previous`) and respect the existing `_match_text`
  query filter + pagination.

Keep location reads behind a feature flag env (e.g.
`ONE_LOCATION_CONSENT_CENTER_ENABLED`) defaulting off until verified, so the
shared consent surface is never destabilized.

### 3. Notifications
The location agent already records metadata-only FCM pushes. To make them appear
in the consent notification bell, ensure the bell's pending-summary source
(`/api/consent/center/summary`) now counts location pending requests (step 2).
No coordinate data flows through notifications — keep `_send_metadata_notification`.

### 4. Revoke cascade
The frontend already clears the "Shared with me" map on revoke/expiry. Confirm
`OneLocationService.revokeGrant` flips `one_location_share_grants.status` to
`revoked` so the contributor moves the row to History on next center fetch.

## Tests to add (consent-protocol/tests)

- `test_one_location_center_contributor.py`:
  - active grant → `active_grant` in Active Access
  - pending access request (owner) → `incoming_request` in Requests
  - revoked/expired grant → `history`
  - public invite active → `active_grant`; revoked → `history`
  - `_assert_coordinate_free` raises when a coordinate key is present
- Extend `test_consent_center_*` to assert location rows union into
  `get_center` / `list_center` / `get_center_summary` counts when the flag is on,
  and are absent when off.

## Verification bundle (run before declaring done)

```bash
./bin/hushh codex data-model-audit
cd consent-protocol && python3 -m pytest tests/test_one_location_center_contributor.py tests/test_consent_center_pure_helpers.py -q
cd hushh-webapp && npm run typecheck
```

## Acceptance criteria

- Location requests/active/history render in the existing `/consents` tabs with
  the same look as finance/gmail.
- Notification bell counts include pending location requests.
- No latitude/longitude/address/map field ever appears in any consent row,
  metadata, or notification (asserted by tests).
- New tables/columns (if any) are classified by `data-model-audit`.
- Feature flag allows safe rollout.

## Status of backend implementation

- SHIPPED (flag-gated, tested): full union is now wired end to end.
  - `one_location_center_contributor.py` built (7 unit tests pass).
  - `consent_center_service.py` unions location buckets in `get_center`,
    `get_center_summary` counts, and `list_center` (the paged tab lists), all
    behind `ONE_LOCATION_CONSENT_CENTER_ENABLED` (default off).
  - Verified: `pytest tests/test_one_location_center_contributor.py` (7 passed)
    and `tests/test_consent_center_pure_helpers.py` +
    `tests/test_ria_iam_service_architecture.py` (124 passed, no regression with
    flag off).
  - To activate in an environment: set
    `ONE_LOCATION_CONSENT_CENTER_ENABLED=true`. Still TODO before prod:
    `./bin/hushh codex data-model-audit` and a flag-ON integration test.

- DONE: `consent-protocol/hushh_mcp/services/one_location_center_contributor.py`

  — `OneLocationCenterContributor` is implemented. It consumes
  `OneLocationAgentService.list_state(user_id=...)` and returns
  `{incoming_requests, outgoing_requests, active_grants, history, invites}` as
  `ConsentCenterEntry` dicts, each tagged `metadata.request_source =
  one_location_*`, `scope = cap.location.live.view`, coordinate-free-asserted via
  the location agent's own `COORDINATE_METADATA_KEYS` /
  `_contains_plaintext_location_key` guards (imports verified to exist). It also
  exposes `counts(user_id)` for the summary endpoint and never raises into the
  consent surface (falls back to empty on any error).

- REMAINING (small, do next): plumb the contributor into
  `consent_center_service.py` behind `ONE_LOCATION_CONSENT_CENTER_ENABLED`:
  1. `__init__`: `self._location_center = OneLocationCenterContributor()`.
  2. `get_center`: when flag on, `loc = self._location_center.collect(user_id)`
     then extend `incoming`, `outgoing_entries`, `active_entries`,
     `history_entries`, `invite_entries` with the matching `loc[...]` lists and
     bump the `summary` counts.
  3. `get_center_summary`: add `self._location_center.counts(user_id)` to the
     surface counts.
  4. `list_center`: include the matching `loc` bucket for the requested surface,
     then apply the existing `_match_text` filter + pagination.
  Add `test_one_location_center_contributor.py` per the Tests section.

## Already shipped (frontend, this PR)


- `hushh-webapp/lib/consent/location-consent.ts` — `isLocationConsent`,
  `locationConsentSummary`, `locationConsentWorkflowHref`.
- `hushh-webapp/components/consent/consent-center-page.tsx` — summary + detail
  "Open Location" row wired exactly like the email-helper pattern.
- `hushh-webapp/app/one/location/page.tsx` — mobile-first tabs, self-location
  nav hidden, reason char limit, revoke/expiry clears the shared map.
