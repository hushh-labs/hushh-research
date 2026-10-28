"""Every hub route under /api/one, /api/kai, /api/pkm and /api/connectors, classified exactly once.

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
  withdraw, check or stop queued input; read bounded source-reset cursors with
  no record values or record identifiers), so an owner whose agent moved keeps them.
* ``NETWORK``: person-to-person and directory features the hub brokers between
  accounts (connections, messages, Location sharing, marketplace, referrals).
* ``CIPHERTEXT``: sealed records the hub stores and indexes but does not open.
* ``CONNECTOR_ADMIN``: connect, disconnect and status of a provider link.
* ``SUPPORT``: public reference information, settings and retired responders.
* ``OPS``: placement, provisioning, setup, heartbeat and lifecycle.

PLG OPS routes carry bounded product-operation metadata and signed first-party
identity-directory projections, never private pod observations or arguments.
Public company facts use explicit public symbols rather than vault holdings.

``@pending:<lane>`` marks a ``CONTENT`` route whose module is owned by another lane of
the private-agent plan; it is listed in ``CONTENT_GUARD_PENDING`` and the inventory
test fails as soon as it is guarded, so the ledger only shrinks.
"""

from __future__ import annotations

from enum import StrEnum

from api.hub_route_inventory import CONNECTOR_INVENTORY, NETWORK_INVENTORY, parse_inventory

HUB_ROUTE_PREFIXES = ("/api/one", "/api/kai", "/api/pkm", "/api/connectors")
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
GET,POST /api/connectors/google_drive/sharing/packets/{packet_id}/preview
POST /api/one/todos/suggestions
POST /api/one/calendar/board/day
POST /api/one/calendar/conflicts/review
POST /api/one/calendar/conflicts/confirm
POST /api/one/calendar/conflicts/workspace/review
POST /api/one/calendar/conflicts/workspace/confirm
GET /api/connectors/google_drive/sharing/requests/{request_id}/shared-files
POST /api/connectors/google_drive/sharing/requests/{request_id}/shared-files/remove
POST /api/connectors/google_drive/sharing/requests/{request_id}/shared-files/restore
GET /api/one/world-model/jobs/stream
POST /api/one/world-model/ensure
DELETE,GET,POST /api/one/world-model/source-reviews
POST /api/one/world-model/source-reviews/complete
POST /api/one/calendar/invitations
POST /api/one/calendar/schedule/today
POST /api/one/calendar/schedule/availability
POST /api/one/calendar/attendance/review
POST /api/one/calendar/attendance/confirm
POST /api/one/calendar/attendance/rsvp/review
POST /api/one/calendar/attendance/rsvp/confirm
POST /api/one/calendar/attendance/workspace/review
POST /api/one/calendar/attendance/workspace/confirm
POST /api/one/files/analyze
DELETE,GET,POST /api/one/world-model/jobs
POST /api/one/world-model/complete
POST /api/one/world-model/research
POST /api/one/profile-research
GET,POST /api/one/profile-research/jobs
POST /api/one/answer-requests/{request_id}/compose
POST /api/one/career/resume/parse
POST /api/one/email/scheduled/drain
POST /api/one/voice/draft/open
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
POST /api/kai/gmail/receipts/scan
POST /api/kai/gmail/receipts/detail
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
POST /api/one/calendar/guest-photo-token
POST /api/one/calendar/insights
POST /api/one/calendar/meetings
POST /api/one/calendar/meetings/detail
POST /api/one/calendar/meetings/context
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
GET,PUT /api/one/plg/preferences
POST /api/one/plg/subscriptions/check
POST /api/one/plg/subscriptions/revoke
POST /api/one/pod/browser-approval/issue
POST /api/one/pod/browser-approval/consume
POST /api/one/pod/browser-approval/validate
POST /api/one/pod/browser-approval/confirm
GET,PUT /api/one/models/private-text-approval
GET,PUT /api/one/world-model/preferences
POST /api/one/world-model/invitations/reject
DELETE,GET,POST /api/one/hosted-memory/pilot
GET /api/one/source-journal/events
POST /api/one/files/storage
GET,POST /api/one/world-model/invitations
DELETE /api/one/world-model/invitations/{invitation_id}
POST /api/one/world-model/claims
POST /api/connectors/google_drive/collection/processing
POST /api/connectors/google_drive/sharing/packets/{packet_id}/listing
POST /api/one/feed/clear
POST /api/one/feed/{item_id}/dismiss
POST /api/one/feed/{item_id}/restore
POST /api/one/business/suggestion/complete
POST /api/one/profile-research/complete
POST /api/one/email/send/status/{action_id}
GET /api/one/email/send/status/{action_id}
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
POST /api/one/pod/mcp-approval/rebind
POST /api/one/u/{hushh_id}/chat-grants
POST /api/one/u/{hushh_id}/memory/provider-consent
POST /api/one/u/{hushh_id}/memory/provider-grant
POST /api/one/u/{hushh_id}/memory/revoke
POST /api/one/webauthn/authenticate/options
POST /api/one/webauthn/authenticate/verify
POST /api/one/webauthn/register/options
POST /api/one/webauthn/register/verify
POST /api/pkm/domains/{domain}/scope-exposure
GET /api/pkm/memory/mutation-impact/{user_id}/{domain}
GET /api/pkm/scopes/{user_id}
[NETWORK]
GET /api/one/messages/unread-count
POST /api/one/world-model/invitation-preview
POST /api/one/calendar/rescheduling/options
GET /api/one/source-snapshots/document-request-payments
[CIPHERTEXT]
POST /api/one/pod/browser-approval/export
GET,PUT /api/one/hosted-memory/pilot/envelope
GET /api/one/files/storage
GET /api/one/files/objects/{namespace}
GET,PUT /api/one/files/objects/{namespace}/{object_id}
POST /api/one/answer-requests/{request_id}/deliver
GET /api/one/answer-requests/{request_id}/answer
DELETE,PUT /api/one/circles/{circle}/chat/messages/{message}/reactions/{emoji}
GET /api/one/circles/{circle}/chat
GET /api/one/circles/{circle}/chat/keys/{key}
GET,POST /api/one/circles/{circle}/chat/messages
DELETE,PATCH /api/one/circles/{circle}/chat/messages/{message}
POST /api/one/circles/{circle}/chat/messages/resolve
POST /api/one/circles/{circle}/chat/messages/updates
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
GET /api/one/source-journal/connectors
GET /api/connectors/google_drive/collection/status
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
GET /api/one/todos/suggestions/status
GET /api/kai/market/company-facts/{user_id}
GET /api/kai/market/history/{user_id}
GET /api/one/wallet/card-access/artwork/assets/{digest}
POST /api/one/wallet/card-access/artwork/resolve
POST /api/one/wallet/card-access/artwork/banks
POST /api/one/wallet/card-access/artwork/validate
GET /api/one/wallet/card-access/networks
POST /api/one/wallet/card-access/networks/resolve
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
POST /api/one/plg/subscriptions/pull
POST /api/one/plg/subscriptions/ack
GET,POST /api/one/plg/activity
POST /api/one/plg/snapshot
POST /api/one/plg/audience
POST /api/one/plg/customer-cohort
POST /api/one/runtime/byoc/attach/retry
POST /api/kai/gmail/webhook
GET /api/one/agent-prompt
POST /api/one/personal-agent/adopt
POST /api/one/personal-agent/deprovision
GET,POST /api/one/personal-agent/removal
GET /api/one/personal-agent/hosting/inspection
GET /api/one/personal-agent/endpoint
POST /api/one/personal-agent/direct-ingress/retry
POST /api/one/personal-agent/provision
GET,PUT /api/one/personal-agent/space-name
GET /api/one/personal-agent/status
POST /api/one/personal-agent/update/approve
POST /api/one/personal-agent/update/defer
POST /api/one/personal-agent/update/failure-report
POST /api/one/personal-agent/update/browser-plan
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
    return parse_inventory(text, RouteClass)


ROUTE_CLASSES, CONTENT_GUARD_PENDING = _parse(
    _INVENTORY + "\n" + CONNECTOR_INVENTORY + "\n" + NETWORK_INVENTORY
)


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
