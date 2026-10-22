"""Owned connector/network catalogs joined by the one canonical hub classifier."""

from enum import StrEnum
from typing import TypeVar

_Classification = TypeVar("_Classification", bound=StrEnum)

CONNECTOR_INVENTORY = """
[CONTENT]
GET /api/connectors/google_drive/groups
GET /api/connectors/google_drive/groups/{shelf}/files
POST /api/connectors/google_drive/groups/processing
POST /api/connectors/google_drive/groups/erase
GET /api/connectors/google_drive/picker/native/pending
GET /api/connectors/google_drive/documents
GET /api/connectors/google_drive/searches
GET /api/connectors/google_drive/searches/{job_id}
GET /api/connectors/google_drive/searches/{job_id}/results
GET /api/connectors/google_drive/searches/{job_id}/stream
GET /api/connectors/google_drive/sharing/bulk
GET /api/connectors/google_drive/sharing/bulk/{share_id}
GET /api/connectors/google_drive/sharing/bulk/{share_id}/files
GET /api/connectors/google_drive/sharing/requests/{request_id}/review
GET /api/connectors/google_drive/sharing/requests/{request_id}/search
GET /api/connectors/google_drive/sharing/requests/{request_id}/search/files
POST /api/connectors/google_drive/documents/select
POST /api/connectors/google_drive/documents/{document_id}/sync
POST /api/connectors/google_drive/live/verify
POST /api/connectors/google_drive/picker/native/confirm
POST /api/connectors/google_drive/picker/native/start
POST /api/connectors/google_drive/picker/session
POST /api/connectors/google_drive/searches
POST /api/connectors/google_drive/sharing/bulk
POST /api/connectors/google_drive/sharing/bulk/{share_id}/approve
POST /api/connectors/google_drive/sharing/bulk/{share_id}/retry
POST /api/connectors/google_drive/sharing/owner-shares
POST /api/connectors/google_drive/sharing/owner-shares/{request_id}/share
POST /api/connectors/google_drive/sharing/owner/compile/stream
POST /api/connectors/google_drive/sharing/queries/{request_id}/allow
POST /api/connectors/google_drive/sharing/queries/{request_id}/share
POST /api/connectors/google_drive/sharing/requests/{request_id}/approve
POST /api/connectors/google_drive/sharing/requests/{request_id}/bulk
POST /api/connectors/google_drive/sharing/requests/{request_id}/prepare
POST /api/connectors/google_drive/sharing/requests/{request_id}/prepare/stream
POST /api/connectors/google_drive/sharing/requests/{request_id}/review/refresh
POST /api/connectors/google_drive/sharing/requests/{request_id}/search
POST /api/connectors/oauth/complete
POST /api/connectors/oauth/complete/web
POST /api/connectors/oauth/native/finalize
POST /api/connectors/{connector_id}/connect/api-key
POST /api/connectors/{connector_id}/connect/oauth/start
POST /api/connectors/{connector_id}/mcp/catalog
POST /api/connectors/{connector_id}/mcp/oauth/begin
POST /api/connectors/{connector_id}/mcp/oauth/complete
POST /api/connectors/{connector_id}/mcp/review
POST /api/connectors/{connector_id}/mcp/verify
[AUTHORITY]
POST /api/connectors/google_drive/documents/{document_id}/processing
POST /api/connectors/google_drive/live/background
POST /api/connectors/google_drive/searches/{job_id}/stop
POST /api/connectors/{connector_id}/mcp/confirm
[NETWORK]
GET /api/connectors/google_drive/sharing/packets
POST /api/connectors/google_drive/sharing/packets/{packet_id}/requests
GET,PUT /api/connectors/google_drive/sharing/pricing
GET /api/connectors/google_drive/sharing/quote
POST /api/connectors/google_drive/sharing/requests/{request_id}/allow
POST /api/connectors/google_drive/sharing/requests/{request_id}/price
GET /api/connectors/google_drive/sharing/bulk/received
GET /api/connectors/google_drive/sharing/bulk/received/{share_id}/files
GET /api/connectors/google_drive/sharing/queries
GET /api/connectors/google_drive/sharing/queries/{request_id}
GET /api/connectors/google_drive/sharing/requests
GET /api/connectors/google_drive/sharing/requests/by-client/{client_request_id}
GET /api/connectors/google_drive/sharing/requests/{request_id}
GET /api/connectors/google_drive/sharing/requests/{request_id}/context
GET /api/connectors/google_drive/sharing/recipient-identity
POST /api/connectors/google_drive/sharing/requests/{request_id}/review-request
GET /api/connectors/google_drive/sharing/requests/{request_id}/delivery
GET /api/connectors/google_drive/sharing/requests/{request_id}/delivery/files
GET /api/connectors/google_drive/sharing/requests/{request_id}/payment
GET /api/connectors/google_drive/sharing/rules
POST /api/connectors/google_drive/sharing/bulk/{share_id}/stop
POST /api/connectors/google_drive/sharing/queries
POST /api/connectors/google_drive/sharing/queries/{request_id}/cancel
POST /api/connectors/google_drive/sharing/queries/{request_id}/deny
POST /api/connectors/google_drive/sharing/requests
POST /api/connectors/google_drive/sharing/requests/{request_id}/cancel
POST /api/connectors/google_drive/sharing/requests/{request_id}/decline
POST /api/connectors/google_drive/sharing/requests/{request_id}/payment/checkout
POST /api/connectors/google_drive/sharing/requests/{request_id}/revocation/confirm
POST /api/connectors/google_drive/sharing/requests/{request_id}/revocation/prepare
POST /api/connectors/google_drive/sharing/rules/{rule_id}/revoke
[CONNECTOR_ADMIN]
GET /api/connectors/features
DELETE /api/connectors/google_drive/documents/{document_id}
GET /api/connectors/google_drive/live/background
GET /api/connectors/google_drive/picker/native/callback
GET /api/connectors/oauth/native/callback
GET /api/connectors/oauth/native/pending
POST /api/connectors/google_drive/picker/native/cancel
POST /api/connectors/{connector_id}/disconnect
POST /api/connectors/{connector_id}/mcp/oauth/cancel
[SUPPORT]
GET /api/connectors
POST /api/connectors/registrations
"""


NETWORK_INVENTORY = """
[NETWORK]
DELETE /api/one/location/circle-types
DELETE /api/one/messages/conversations/{conversation_id}
GET /api/one/people/{person_ref}/relationship
DELETE /api/one/wallet/card-access/grants/{grant_id}
GET /api/one/answer-requests/answerable
GET /api/one/answer-requests/availability
GET /api/one/answer-requests/inbox
GET /api/one/answer-requests/payout-account
GET /api/one/answer-requests/{request_id}/payment
GET /api/one/answer-requests/{request_id}/state
GET /api/one/payouts/hashcoins
GET /api/one/wallet/card-access/cards/{card_id}
GET /api/one/wallet/card-access/connections
GET /api/one/wallet/card-access/grants/{grant_id}
GET /api/one/wallet/card-access/history
GET /api/one/wallet/card-access/history/{grant_id}
GET /api/one/wallet/card-access/profile
GET /api/one/wallet/card-access/requests/{request_id}
POST /api/one/answer-requests
POST /api/one/answer-requests/payout-account/{action}
POST /api/one/answer-requests/{request_id}/approve
POST /api/one/answer-requests/{request_id}/cancel
POST /api/one/answer-requests/{request_id}/decline
POST /api/one/answer-requests/{request_id}/payment/checkout
POST /api/one/answer-requests/{request_id}/resolve
POST /api/one/payouts/connect/sandbox-webhook
POST /api/one/payouts/hashcoins/redeem
POST /api/one/wallet/card-access/cards/{card_id}/grants
POST /api/one/wallet/card-access/grants/{grant_id}/verify
POST /api/one/wallet/card-access/registrations
POST /api/one/wallet/card-access/requests
POST /api/one/wallet/card-access/requests/{request_id}/cancel
POST /api/one/wallet/card-access/requests/{request_id}/decline
DELETE /api/one/messages/conversations/{conversation_id}/messages/{message_id}/reaction
GET /api/one/messages/conversations/{conversation_id}/messages/{message_id}/attachment
GET /api/one/payouts/account
GET /api/one/payouts/account/bank-payouts
GET /api/one/payouts/account/balance
GET /api/one/payouts/activity
GET /api/one/payouts/activity/{item_id}
GET /api/one/payouts/account/earnings
POST /api/one/payouts/account/manage
POST /api/one/payouts/account/onboard
POST /api/one/payouts/connect/webhook
GET /api/one/referrals/challenge
GET /api/one/referrals/points
GET /api/one/referrals/transactions
POST /api/one/referrals/activity
POST /api/one/referrals/app-open
POST /api/one/referrals/rewards/claim
GET /api/one/referrals/policy
GET /api/one/business/suggestion
GET /api/one/credits
POST /api/one/credits/subscribe
POST /api/one/credits/cancel
GET /api/one/directory-claims/me
POST /api/one/directory-claims
DELETE /api/one/directory-claims/me
PATCH,DELETE /api/one/messages/conversations/{conversation_id}/messages/{message_id}
PUT /api/one/messages/conversations/{conversation_id}/messages/{message_id}/reaction
POST /api/one/packet-orders
POST /api/one/packet-orders/credits
GET /api/one/packet-orders/{order_id}
GET /api/one/payouts
POST /api/one/payouts/onboard
GET,POST /api/one/packets
PATCH,DELETE /api/one/packets/{packet_id}
GET,POST /api/one/referrals/circle
GET,POST /api/one/referrals/handle
GET /api/one/referrals/leaderboard
GET /api/one/referrals/circles/leaderboard
GET /api/one/referrals/circle-wars
GET /api/one/referrals/circle-wars/circles/{circle_id}
GET /api/one/referrals/circle-wars/leaderboard
POST /api/one/referrals/circle-wars/participation
GET /api/one/referrals/milestones
GET /api/one/referrals/engagement
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
GET /api/one/feed/events
POST /api/one/feed/read
POST /api/one/feed/sos-cards/clear
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
POST /api/one/messages/route-token
DELETE,POST /api/one/messages/blocks
GET /api/one/messages/conversations
GET /api/one/messages/conversations/{conversation_id}/messages
POST /api/one/messages/conversations/{conversation_id}/delivered
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
POST /api/one/referrals/rotate
GET /api/one/referrals/summary
DELETE,GET,POST /api/one/wallet-card
POST /api/one/wallet-card/ensure
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
"""


def parse_inventory(
    text: str, route_class: type[_Classification]
) -> tuple[dict[tuple[str, str], _Classification], dict[tuple[str, str], str]]:
    classes: dict[tuple[str, str], _Classification] = {}
    pending: dict[tuple[str, str], str] = {}
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            current = route_class(line[1:-1])
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
                if current.value != "CONTENT" or not marker[0].startswith("@pending:"):
                    raise ValueError(f"only a CONTENT route may be pending: {line}")
                pending[key] = marker[0].removeprefix("@pending:")
    return classes, pending
