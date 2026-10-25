# Financial packet summary publication

## Visual Context

Visual owner: [One Index](README.md#visual-map), Drive connection and sharing.
Preparation → explicit summary publication → connection → owner approval → purchase
→ delivery are separate authorities in the existing packet workflow.

## Publication and private access

Financial packet summaries are hidden by default. The owner must explicitly accept
`drive-packet-public-summary-v1` using the vault-owner route:
`PUT /api/connectors/google_drive/sharing/packets/{packet_id}/public-summary`.
The strict body contains `enabled`, `version` (zero for an unfrozen preview),
`expectedRevision`, and `disclosure`. Consent is bound to the packet head's exact
version and Drive connection generation. Freezing version zero does not publish
version one; the owner must acknowledge the new version. Withdrawal remains
available when background preparation, feature admission or payments are off.
No historical connection-only listing is converted to public consent.

`GET /api/one/people/{person_ref}/financial-packets` requires current Firebase
identity and returns private, no-store responses. Only an active public profile
and explicitly published financial heads are considered. Hidden profiles,
withdrawn publication and changed generations expose no cards. Pausing background
preparation preserves an explicitly published saved summary, marks it unavailable
for purchase and does not start work or change the background preference. Public reads query scalar metadata only and never open encrypted packet
builds, manifests or source records. Open previews project count, completeness and
update time atomically with the saved owner preview; an unknown count stays null.
Frozen versions expose the exact sale-file count. These are provider query matches,
not claims of verified financial contents or complete reporting coverage.

The response allowlist contains packet reference/version, category, controlled title,
period/timezone, count and basis, completeness/update time, price 500 USD cents,
availability and a viewer action. It contains no owner UID, request ID, filename,
Drive identifier/link, query, source evidence or diagnostic code. Pagination uses
packet UUIDs with a maximum of 25 summaries per response.

Public summaries confer no private access. Existing connection-only packet listing,
request consent, exact manifest/version, source changes, payment and Google grant
checks continue to govern purchase and delivery. The new publication revision and
acceptance timestamp are independent from connection-only listing revisions.

Migration 417 adds scalar projection and explicit publication fields to the existing
`drive_packet_heads` owner. Growth remains one row per owner/category/calendar period
and connection generation; it adds no queue or index of file contents. Existing
account deletion cascades remove the head and its consent. Rollback disables
publication while retaining accepted disclosure history and encrypted packet state.

The vault-owner control `GET /api/connectors/google_drive/sharing/packet-publications`
returns up to 25 scalar publication receipts and a packet-reference cursor. It is
available after background preparation is paused or OAuth is revoked, so the owner
can still withdraw after reopening the app. Its `publicSummary.enabled` records the
stored publication choice, including receipts invalidated by version or generation
changes; it does not assert current public visibility. This management read returns
no files, opens no encrypted records and starts no preparation. It uses the existing
owner revision-CAS withdrawal PUT. Enabling still requires valid current OAuth and
version/generation authority.
