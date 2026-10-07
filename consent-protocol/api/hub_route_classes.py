"""Every hub route under /api/one, /api/kai and /api/pkm, classified exactly once.

The hub is the control plane. A route classified ``CONTENT`` carries an owner's own
words, records, prompts or provider content in plaintext, so it must admit its caller
through the one hub content guard (``hushh_mcp.services.owner_placement_guard``):
only a Shared owner (or an anonymous intro visitor) reaches the hub runtime.
``tests/test_hub_content_routes_guarded.py`` walks ``server.app.routes`` and fails on
an unclassified route, on a ``CONTENT`` route without the guard, and on a ``CONTENT``
route that answers a private owner with anything but a refusal.

Classes:

* ``CONTENT``: owner plaintext the hub would read or produce (chat, mail, calendar,
  finance analysis, PKM plaintext, voice). Guarded.
* ``AUTHORITY``: consent, grants, approvals, passkeys, scope catalogues; metadata that
  says who may do what, never the information itself. Also an owner's controls over
  their own hub records that read and return no content (erase a conversation;
  withdraw, check or stop queued input), so an owner whose agent moved keeps them.
* ``NETWORK``: person-to-person and directory features the hub brokers between
  accounts (connections, messages, Location sharing, marketplace, referrals).
* ``CIPHERTEXT``: sealed records the hub stores and indexes but does not open.
* ``CONNECTOR_ADMIN``: connect, disconnect and status of a provider link.
* ``SUPPORT``: public reference information, settings and retired responders.
* ``OPS``: placement, provisioning, setup, heartbeat and lifecycle.

``@pending:<lane>`` marks a ``CONTENT`` route whose module is owned by another lane of
the private-agent plan; it is listed in ``CONTENT_GUARD_PENDING`` and the inventory
test fails as soon as it is guarded, so the ledger only shrinks.
"""

from __future__ import annotations

from enum import StrEnum

HUB_ROUTE_PREFIXES = ("/api/one", "/api/kai", "/api/pkm")
WEBSOCKET = "WS"


class RouteClass(StrEnum):
    CONTENT = "CONTENT"
    AUTHORITY = "AUTHORITY"
    NETWORK = "NETWORK"
    CIPHERTEXT = "CIPHERTEXT"
    CONNECTOR_ADMIN = "CONNECTOR_ADMIN"
    SUPPORT = "SUPPORT"
    OPS = "OPS"


RouteKey = tuple[str, str]

# One line per path: "<METHODS> <path> [@pending:<lane>]", grouped under its class.
_INVENTORY = """
[CONTENT]
POST /api/kai/analyze
GET /api/kai/analyze/run/active
POST /api/kai/analyze/run/start
POST /api/kai/analyze/run/{run_id}/cancel
GET /api/kai/analyze/run/{run_id}/stream
GET,POST /api/kai/analyze/stream
POST /api/kai/chat
POST /api/kai/chat/analyze-loser
GET /api/kai/chat/conversations/{user_id}
GET /api/kai/chat/history/{conversation_id}
GET /api/kai/chat/initial-state/{user_id}
GET /api/kai/dashboard/profile-picks/{user_id}
GET /api/kai/decisions/{user_id}
GET /api/kai/gmail/nudges/{user_id}
GET /api/kai/gmail/receipts-memory/artifacts/{artifact_id}
POST /api/kai/gmail/receipts-memory/preview
GET /api/kai/gmail/receipts/{user_id}
POST /api/kai/gmail/reconcile
POST /api/kai/gmail/sync
GET /api/kai/gmail/sync/{run_id}
GET /api/kai/market/insights/{user_id}
GET /api/kai/market/news/{user_id}
POST /api/kai/plaid/vault/snapshot
POST /api/kai/portfolio/analyze-losers
POST /api/kai/portfolio/analyze-losers/stream
POST /api/kai/portfolio/import
GET /api/kai/portfolio/import/run/active
POST /api/kai/portfolio/import/run/start
POST /api/kai/portfolio/import/run/{run_id}/cancel
GET /api/kai/portfolio/import/run/{run_id}/stream
POST /api/kai/portfolio/import/stream
GET /api/kai/portfolio/summary/{user_id}
GET /api/kai/stock-preview/{user_id}
POST /api/one/a2a/message
GET /api/one/action-proposals
DELETE,GET /api/one/action-proposals/{proposal_id}
POST /api/one/action-proposals/{proposal_id}/admit
PUT /api/one/action-proposals/{proposal_id}/checkpoint
POST /api/one/action-proposals/{proposal_id}/claim
POST /api/one/action-proposals/{proposal_id}/confirm
POST /api/one/action-proposals/{proposal_id}/execute
POST /api/one/action-proposals/{proposal_id}/resolve
POST /api/one/action-proposals/{proposal_id}/resume
POST /api/one/action-proposals/{proposal_id}/settle
POST /api/one/actions/search
POST /api/one/agent-chat
PATCH /api/one/agent-chat/conversations/{conversation_id}
GET /api/one/agent-chat/conversations/{user_id}
GET,PUT /api/one/agent-chat/feedback
GET /api/one/agent-chat/history/{conversation_id}
POST /api/one/agent-chat/history/{conversation_id}/information-requests
GET /api/one/agent-chat/information-requests/{bundle_id}/conversation
POST /api/one/agent-chat/proposals
POST /api/one/agent-chat/proposals/typed
POST /api/one/agent-chat/runs/{conversation_id}/queue
POST /api/one/calendar/availability
POST /api/one/calendar/events
POST /api/one/calendar/proposals
POST /api/one/calendar/proposals/execute
POST /api/one/drive/reviewed-actions/execute
POST /api/one/email/chat
POST /api/one/email/draft
POST /api/one/email/draft/save
GET /api/one/email/information-requests
POST /api/one/email/information-requests/scan
POST /api/one/email/information-requests/scan-enabled
POST /api/one/email/information-requests/scan/stream
POST /api/one/email/information-requests/{workflow_id}/ignore
POST /api/one/email/information-requests/{workflow_id}/pkm-reply-authorization
POST /api/one/email/information-requests/{workflow_id}/prepare-reply
POST /api/one/email/information-requests/{workflow_id}/refresh-candidates
POST /api/one/email/information-requests/{workflow_id}/send-reply
GET /api/one/email/information-requests/{workflow_id}/source-preview
POST /api/one/email/mailbox/execute
POST /api/one/email/prepare
POST /api/one/email/send
POST /api/one/first-connect-insights
POST /api/one/information/chat
POST /api/one/location/chat
POST /api/one/pod/specialist/{name}/read
WS /api/one/puppy/relay
POST /api/one/transcriptions
POST /api/one/u/{hushh_id}/conversation/{conversation_id}/close
POST /api/one/u/{hushh_id}/turn
WS /api/one/voice/live
POST /api/one/voice/mail/open
GET /api/one/voice/pending-actions
POST /api/one/voice/pending-actions/{pending_action_id}/cancel
POST /api/one/voice/pending-actions/{pending_action_id}/confirm
POST /api/one/voice/sessions
POST /api/pkm/agent-lab/structure
POST /api/pkm/get-context
POST /api/pkm/memory/proposals
[AUTHORITY]
GET /api/one/pod/owner-feed/{kind}
POST /api/one/pod/owner-feed/command
POST /api/kai/consent/grant
DELETE /api/one/agent-chat/conversations/{conversation_id}
GET /api/one/agent-chat/runs/{conversation_id}/queue
DELETE /api/one/agent-chat/runs/{conversation_id}/queue/{client_message_id}
POST /api/one/agent-chat/runs/{conversation_id}/stop
POST /api/one/agent-chat/proposals/prepare
GET /api/one/personal-agent/verification-keys
POST /api/one/pod/consent/verify
POST /api/one/pod/mcp-approval/consume
POST /api/one/pod/mcp-approval/issue
POST /api/one/u/{hushh_id}/chat-grants
POST /api/one/u/{hushh_id}/memory/provider-consent
POST /api/one/u/{hushh_id}/memory/revoke
POST /api/one/webauthn/authenticate/options
POST /api/one/webauthn/authenticate/verify
POST /api/one/webauthn/register/options
POST /api/one/webauthn/register/verify
POST /api/pkm/domains/{domain}/scope-exposure
GET /api/pkm/memory/mutation-impact/{user_id}/{domain}
GET /api/pkm/scopes/{user_id}
[NETWORK]
POST /api/one/capabilities/execute
GET /api/one/commands/location/circle-name/active
POST /api/one/commands/location/circle-name/{run_id}/submit
GET /api/one/connections
POST /api/one/connections/contact-sync
GET /api/one/connections/directory
POST /api/one/connections/link-circle-invite
GET,POST /api/one/connections/requests
POST /api/one/connections/requests/{request_id}/accept
POST /api/one/connections/requests/{request_id}/cancel
POST /api/one/connections/requests/{request_id}/reject
GET /api/one/connections/requests/{request_id}/scopes
DELETE /api/one/connections/{connection_id}
GET /api/one/connections/{counterpart_user_id}/context
GET /api/one/connections/{counterpart_user_id}/information-scopes
GET /api/one/connections/{counterpart_user_id}/scope-catalog
GET /api/one/feed
POST /api/one/feed/read
GET /api/one/feed/unread-count
POST /api/one/information-requests
GET /api/one/information-requests/shared-with-me
GET /api/one/information-requests/{bundle_id}
POST /api/one/information-requests/{bundle_id}/cancel
GET /api/one/location/activity
PATCH /api/one/location/auto-approve-preference
POST /api/one/location/circle-codes/join
POST /api/one/location/circle-codes/preview
POST /api/one/location/circle-codes/public-preview
POST /api/one/location/circle-codes/resolve
POST /api/one/location/circle-invites
DELETE /api/one/location/circle-invites/{invite_id}
GET /api/one/location/circle-invites/{public_token}
POST /api/one/location/circle-invites/{public_token}/claim
GET,POST /api/one/location/circle-member-invites
DELETE /api/one/location/circle-member-invites/{invite_id}
POST /api/one/location/circle-member-invites/{invite_id}/accept
POST /api/one/location/circle-member-invites/{invite_id}/decline
GET,POST /api/one/location/circles
POST /api/one/location/circles/bootstrap
POST /api/one/location/circles/sms-system
POST /api/one/location/circles/trusted
DELETE,GET,PATCH /api/one/location/circles/{circle_id}
GET /api/one/location/circles/{circle_id}/eligible-connections
DELETE,POST /api/one/location/circles/{circle_id}/invite-code
GET /api/one/location/circles/{circle_id}/members
DELETE /api/one/location/circles/{circle_id}/members/me
DELETE /api/one/location/circles/{circle_id}/members/{member_user_id}
GET /api/one/location/circles/{circle_id}/overview
POST /api/one/location/grants
DELETE /api/one/location/grants/{grant_id}
PATCH /api/one/location/grants/{grant_id}/duration
POST /api/one/location/grants/{grant_id}/refer
PATCH /api/one/location/grants/{grant_id}/shorten
GET,PATCH /api/one/location/map-preferences
GET /api/one/location/map-state
POST /api/one/location/maps/autocomplete
POST /api/one/location/maps/nearby-places
POST /api/one/location/maps/place-details
POST /api/one/location/maps/reverse-geocode
POST /api/one/location/maps/route-eta
GET,PATCH /api/one/location/nearby-check-in-preferences
DELETE,GET,PATCH /api/one/location/nearby-presence
POST /api/one/location/nearby-presence/check-in
POST /api/one/location/nearby-presence/connection-request
DELETE,GET,POST /api/one/location/place-ratings
GET /api/one/location/place-ratings/pending
POST /api/one/location/place-ratings/summaries
POST /api/one/location/public-invites
DELETE /api/one/location/public-invites/{invite_id}
POST /api/one/location/public-invites/{invite_id}/location
GET /api/one/location/public-invites/{public_token}
POST /api/one/location/public-invites/{public_token}/submit
POST /api/one/location/recipient-keys
GET /api/one/location/recipients
POST /api/one/location/requests
POST /api/one/location/requests/{request_id}/approve
POST /api/one/location/requests/{request_id}/deny
POST /api/one/location/requests/{request_id}/withdraw
POST /api/one/location/retention/purge
GET,POST /api/one/location/sms-contacts
DELETE /api/one/location/sms-contacts/{recipient_user_id}
POST /api/one/location/sos-email-recipients
GET,PATCH /api/one/location/sos-voice-preference
GET /api/one/location/state
GET /api/one/marketplace/available
POST /api/one/marketplace/available/{listing_id}/request
GET,POST /api/one/marketplace/opportunities
POST /api/one/marketplace/opportunities/{signal_id}/dismiss
POST /api/one/marketplace/opportunities/{signal_id}/publish
POST /api/one/marketplace/opportunities/{signal_id}/snooze
POST /api/one/marketplace/recipient-keys
GET,POST /api/one/marketplace/requests
POST /api/one/marketplace/requests/{request_id}/approve
POST /api/one/marketplace/requests/{request_id}/deny
GET /api/one/marketplace/requests/{request_id}/recipient-key
POST /api/one/marketplace/requests/{request_id}/revoke
POST /api/one/messages
DELETE,POST /api/one/messages/blocks
GET /api/one/messages/conversations
GET /api/one/messages/conversations/{conversation_id}/messages
POST /api/one/messages/conversations/{conversation_id}/read
GET /api/one/messages/events
GET /api/one/messages/stream
GET /api/one/messages/with/person/{person_ref}
GET /api/one/messages/with/{recipient_user_id}
GET /api/one/people/{person_ref}
DELETE,POST /api/one/people/{person_ref}/connection
POST /api/one/people/{person_ref}/connection/cancel
GET /api/one/people/{person_ref}/request-history
GET /api/one/people/{person_ref}/scope-catalog
POST /api/one/places/details
POST /api/one/places/search
POST /api/one/places/stream
GET /api/one/profile-discovery
POST /api/one/profile-discovery/anchors
POST /api/one/profile-discovery/cancel
POST /api/one/profile-discovery/claim
POST /api/one/profile-discovery/claim/prepare
GET /api/one/profile-discovery/review
POST /api/one/profile-discovery/start
POST /api/one/referrals/bind
GET /api/one/referrals/events
POST /api/one/referrals/resolve
GET /api/one/referrals/summary
DELETE,GET,POST /api/one/wallet-card
GET /api/one/wallet-card/pass/{share_token}.pkpass
POST /api/one/wallet-card/pause
GET /api/one/wallet-card/preview
GET /api/one/wallet-card/public/{share_token}
POST /api/one/wallet-card/resume
POST /api/one/wallet-card/rotate
POST /api/one/workflows/location/onboarding/runs
GET /api/one/workflows/location/onboarding/runs/active
GET /api/one/workflows/location/onboarding/runs/{run_id}
POST /api/one/workflows/location/onboarding/runs/{run_id}/cancel
POST /api/one/workflows/location/onboarding/runs/{run_id}/interactions/{directive_id}
DELETE,POST /api/pkm/domains/{domain}/public-profile-projection
GET /api/pkm/domains/{domain}/public-profile-projections
[CIPHERTEXT]
GET /api/one/circles/{circle}/chat
GET /api/one/circles/{circle}/chat/keys/{key}
GET,POST /api/one/circles/{circle}/chat/messages
GET /api/one/circles/{circle}/chat/messages/{message}/image
PUT /api/one/circles/{circle}/chat/preferences
POST /api/one/circles/{circle}/chat/read
GET /api/one/circles/{circle}/chat/wait
PUT /api/one/circles/{circle}/photo
GET /api/one/information-requests/{bundle_id}/exports
POST /api/one/location/grants/with-envelope
GET /api/one/location/grants/{grant_id}/envelope
POST /api/one/location/grants/{grant_id}/envelopes
POST /api/one/marketplace/requests/{request_id}/deliver
GET /api/one/marketplace/requests/{request_id}/delivery
POST /api/one/profile-discovery/draft
DELETE /api/pkm/attributes/{user_id}/{domain}/{attribute_key}
POST /api/pkm/commits/lookup
GET /api/pkm/data/{user_id}
POST /api/pkm/delete-domain
GET /api/pkm/device-sync/{user_id}
DELETE,GET /api/pkm/domain-data/{user_id}/{domain}
GET /api/pkm/domain-snapshot/{user_id}/{domain}
GET /api/pkm/manifest/{user_id}/{domain}
GET /api/pkm/metadata/{user_id}
POST /api/pkm/store-domain
POST /api/pkm/store-domain/validate
[CONNECTOR_ADMIN]
POST /api/kai/gmail/connect/complete
POST /api/kai/gmail/connect/native/complete
POST /api/kai/gmail/connect/native/start
POST /api/kai/gmail/connect/start
POST /api/kai/gmail/disconnect
GET /api/kai/gmail/status/{user_id}
POST /api/kai/plaid/vault/exchange
POST /api/kai/plaid/vault/link-token
POST /api/kai/plaid/vault/remove
POST /api/one/calendar/connect/complete
POST /api/one/calendar/connect/native/complete
POST /api/one/calendar/connect/native/start
POST /api/one/calendar/connect/start
POST /api/one/calendar/disconnect
GET /api/one/calendar/status/{user_id}
POST /api/one/google/connect/complete
POST /api/one/google/connect/transition/prepare
POST /api/one/google/connect/transition/complete
GET,POST /api/one/kyc/client-connector
POST /api/one/runtime/gemini/validate
[SUPPORT]
POST /api/kai/decision/store
DELETE,GET /api/kai/decision/{decision_id}
GET /api/kai/health
GET /api/kai/local-runtime/capability
GET /api/kai/market/insights/baseline/{user_id}
GET /api/kai/market/news/baseline/{user_id}
POST /api/kai/support/message
GET /api/one/a2a/card
WS /api/one/adk/live
WS /api/one/adk/location-command/live
POST /api/one/adk/relay-session
POST /api/one/advisors/search
GET /api/one/advisors/{crd}
GET /api/one/agent-chat/capabilities
GET,PATCH /api/one/connect/voice-preferences
GET,PATCH /api/one/email/information-requests/preference
POST /api/one/insurance-agents/search
GET,PATCH /api/one/location/account-settings
GET,PATCH /api/one/location/setup-progress
GET,PUT /api/one/models/preference
GET /api/one/runtime/providers
GET /api/one/voice/readiness
GET /api/pkm/domain-registry
POST /api/pkm/slice-price
[OPS]
POST /api/one/runtime/byoc/attach/retry
POST /api/kai/gmail/webhook
GET /api/one/agent-prompt
POST /api/one/personal-agent/adopt
POST /api/one/personal-agent/deprovision
GET /api/one/personal-agent/endpoint
POST /api/one/personal-agent/direct-ingress/retry
POST /api/one/personal-agent/provision
GET,PUT /api/one/personal-agent/space-name
GET /api/one/personal-agent/status
POST /api/one/personal-agent/update/approve
POST /api/one/personal-agent/update/defer
POST /api/one/personal-agent/update/failure-report
POST /api/one/personal-agent/update/files-plan
POST /api/one/pod/heartbeat
GET /api/one/pod/lifecycle
GET /api/one/pod/lifecycle/stream
POST /api/one/pod/wake
GET /api/one/puppy/status/{device_id}
POST /api/one/runtime/byoc/authorize/begin
POST /api/one/runtime/byoc/authorize/complete
GET /api/one/runtime/byoc/authorize/instructions
POST /api/one/runtime/byoc/azure/authorize/begin
POST /api/one/runtime/byoc/azure/authorize/complete
GET /api/one/runtime/byoc/azure/hosting
POST /api/one/runtime/byoc/azure/rebuild/begin
POST /api/one/runtime/byoc/azure/upgrade/begin
POST /api/one/runtime/byoc/hosted/select
POST /api/one/runtime/byoc/project/check
POST /api/one/runtime/byoc/project/plan
POST /api/one/runtime/byoc/project/save
GET /api/one/runtime/byoc/project/suggest
GET /api/one/runtime/byoc/setup/status
GET /api/one/runtime/managed/readiness
POST /api/one/runtime/managed/select
POST /api/one/runtime/shared/select
POST /api/one/runtime/standby/sync
GET /api/one/u/{hushh_id}/diagnostics/model
GET /api/one/u/{hushh_id}/info
GET /api/one/u/{hushh_id}/memory/status
POST /api/pkm/domains/{domain}/repair-manifest-paths
POST /api/pkm/reconcile/{user_id}
POST /api/pkm/upgrade/runs/{run_id}/complete
POST /api/pkm/upgrade/runs/{run_id}/domains/{domain}/rollback
POST /api/pkm/upgrade/runs/{run_id}/fail
POST /api/pkm/upgrade/runs/{run_id}/status
POST /api/pkm/upgrade/runs/{run_id}/steps/{domain}
POST /api/pkm/upgrade/runs/{run_id}/steps/{domain}/claim
POST /api/pkm/upgrade/start-or-resume
GET /api/pkm/upgrade/status/{user_id}
"""


def _parse(text: str) -> tuple[dict[RouteKey, RouteClass], dict[RouteKey, str]]:
    classes: dict[RouteKey, RouteClass] = {}
    pending: dict[RouteKey, str] = {}
    current: RouteClass | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            current = RouteClass(line[1:-1])
            continue
        if current is None:
            raise ValueError(f"route listed before any class: {line}")
        methods, path, *marker = line.split()
        for method in methods.split(","):
            key = (method, path)
            if key in classes:
                raise ValueError(f"route classified twice: {method} {path}")
            classes[key] = current
            if marker:
                if current is not RouteClass.CONTENT or not marker[0].startswith("@pending:"):
                    raise ValueError(f"only a CONTENT route may be pending: {line}")
                pending[key] = marker[0].removeprefix("@pending:")
    return classes, pending


ROUTE_CLASSES, CONTENT_GUARD_PENDING = _parse(_INVENTORY)


def is_hub_route(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in HUB_ROUTE_PREFIXES)


def classify(method: str, path: str) -> RouteClass | None:
    """The class of one route, or ``None`` when it was never classified."""
    return ROUTE_CLASSES.get((method.upper(), path))


__all__ = [
    "CONTENT_GUARD_PENDING",
    "HUB_ROUTE_PREFIXES",
    "ROUTE_CLASSES",
    "WEBSOCKET",
    "RouteClass",
    "classify",
    "is_hub_route",
]
