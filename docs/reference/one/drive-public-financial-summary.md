# Financial packet summary visibility

## Visual Context

Visual owner: [One Index](README.md#visual-map), Drive connection and sharing.
Preparation → owner-controlled scalar summary → connection → owner approval → purchase
→ delivery are separate authorities in the existing packet workflow.

## Publication and private access

Financial packet scalar summaries default ON for existing and new owners. This is
an explicit product visibility policy, `drive-financial-summary-default-v1`; no
personal acceptance is fabricated from OAuth or background preparation. The
owner's single **Show on profile** switch controls every financial period,
including periods still preparing and periods that cannot be sold. A saved OFF
choice persists across new periods, freezing, OAuth reconnect and preparation.

The vault-owner authority route
`GET /api/connectors/google_drive/sharing/financial-summary-preference` returns
`{enabled, revision, disclosure}`. `PUT` on the same route accepts the strict body
`{enabled, expectedRevision, disclosure}` and returns the updated preference.
Conflicting revisions return `listing_changed` (409). Writes and public reads
serialize through the existing owner graph lock; an OFF committed before a read
hides every period in that read. OFF and management reads remain available after
background preparation pauses or OAuth is revoked. Enabling requires a current
verified live Drive connection. No visibility mutation starts preparation or
changes its separate background preference. Clients discard their active owner
and profile summary projections after a successful visibility write and refetch
the authoritative response; no persistent public-summary cache is authorized.

`GET /api/one/people/{person_ref}/financial-packets` requires current Firebase
identity and returns private, no-store responses. Only an active public profile
and financial heads in the active Drive generation are considered. Hidden profiles,
owner OFF and inactive or changed source generations expose no cards. Pausing background
preparation preserves saved scalar summaries, marks them unavailable
for purchase and does not start work or change the background preference. Public reads query scalar metadata only and never open encrypted packet
builds, manifests or source records. Open previews project count, completeness and
update time atomically with the saved owner preview; an unknown count stays null.
Saved discovery scalars take precedence even when an immutable sale version
exists. `documentCount`, `countBasis`, `complete` and `updatedAt` describe that
discovery together; incomplete zero remains unknown, while completed zero is a
confirmed empty discovery. Without saved discovery scalars, an existing frozen
version provides its exact sale-file count as a fallback. `saleDocumentCount`
separately reports nullable exact frozen membership. These are provider query matches,
not claims of verified financial contents or complete reporting coverage.

The response allowlist contains packet reference/version, category, controlled title,
period/timezone, discovery count and basis, nullable sale count, completeness/update time, price 500 USD cents,
availability and a viewer action. It contains no owner UID, request ID, filename,
Drive identifier/link, query, source evidence or diagnostic code. Pagination uses
packet UUIDs with a maximum of 25 summaries per response.

Public summaries confer no private access. Existing connection-only packet listing,
request consent, exact manifest/version, source changes, payment and Google grant
checks continue to govern purchase and delivery. The owner visibility revision
and legacy acceptance timestamp remain independent from connection-only listing revisions.

Migration 417 introduced scalar projection and legacy per-period publication
receipts on `drive_packet_heads`. Migration 428 makes
`drive_live_preferences.financial_summary_enabled` and
`financial_summary_revision` the single current owner visibility policy. Defaults
are ON/revision zero. A legacy head with revision greater than zero and a stored
FALSE is an explicit hide and migrates to owner OFF/revision one; old untouched
FALSE/revision zero does not. An owner's later choice is never overwritten by a
migration replay. Background OFF is retained independently. Legacy publication
history, encrypted packet state and immutable sale manifests remain intact.
During a rolling deployment, a revisioned explicit hide written by an older API
also transfers to owner OFF atomically. An old period-level ON cannot override a
saved owner OFF or authorize enabling every period. OFF also clears legacy
enabled flags in that same transaction without changing legacy receipt revisions,
acceptance history or private packet state. A database bridge returns persisted
FALSE if an older writer tries to republish while owner OFF is saved.
Growth remains one preference per owner and one head per owner/category/calendar
period and generation, with no new queue or contents index. Account deletion
removes these owner records. PostgreSQL owns the preference; a future cache may
project it but cannot become publication authority. Rollback retains the owner
preference and ensures legacy publication cannot expose an owner who chose OFF.
The compatible columns and bridge remain through rollback so an old writer
cannot defeat that retained choice.

The vault-owner control `GET /api/connectors/google_drive/sharing/packet-publications`
is a compatibility read returning up to 25 scalar period receipts and a packet-reference cursor. It is
available after background preparation is paused or OAuth is revoked, so the owner
can still withdraw after reopening the app. Its `publicSummary.enabled` records the
canonical owner choice; the response is empty when OFF, and does not assert
current source or public profile availability. This management read returns
no files, opens no encrypted records and starts no preparation. It uses the existing
owner preference revision. The legacy
`PUT /api/connectors/google_drive/sharing/packets/{packet_id}/public-summary`
is a compatibility facade into that same owner choice, retaining its strict
legacy disclosure and a packet version/generation check when enabling. It does
not create a second period-level visibility policy. Enabling through that old
disclosure is rejected with `review_changed` when the owner has saved OFF; the
current owner policy route must authorize that broader ON choice. New clients use the single
owner preference route.

## Large owner previews

Financial owner discovery retains every saved original across the generic search's
former 10,000-result boundary. Custom searches and bulk sharing retain their
existing limits; the frozen sale contract still admits at most 120 sources.
An owner preview count is therefore not a promise that those matches are
verified financial documents or available for purchase.

Migration 422 expands only financial provider-discovery storage, with database
guards preserving ordinary search limits. A legacy capped financial preview is
replayed once against its identical frozen queries, in the same job, with stable
positions and file-digest deduplication. This recovers a potentially unsaved page
tail without deleting earlier results. Current authorization and processing
authority are revalidated before recovery. The encrypted checkpoint records the
recovery; existing per-slice and checkpoint bounds remain in force.

Application rollback can leave these compatible storage guards installed. The
SQL rollback refuses to shrink capacity while larger retained previews exist;
never delete originals or alter owner preferences to force a rollback.
