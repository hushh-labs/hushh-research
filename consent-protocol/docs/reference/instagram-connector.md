# Instagram connector

## Visual Context

The [backend docs index](../README.md) owns the package map. This page covers
the first-party Instagram Graph REST adapter behind the existing Connectors
interface. It is not an MCP server or a general Instagram automation client.

## Current boundary

The adapter uses **Business Login for Instagram** to connect one owner's
Instagram **Business or Creator** account. Its backend routes cover owned
media, publishing, comment moderation, account and media insights, tagged
media, and existing direct-message conversations. Each route is bounded to
that connected account and the permission Meta granted. Write routes require
an explicit owner confirmation in the request. The Graph operations still need
an end-to-end test with a real Meta app and grant before production activation.

| Meta configuration | Account and login | Meta capability boundary |
| --- | --- | --- |
| Instagram API with Instagram Login (current) | Professional account; Instagram login; no Facebook Page required | Own media, publishing, comments, mentions, messaging, and insights, subject to endpoint permissions |
| Instagram API with Facebook Login (not implemented here) | Professional account linked to a Facebook Page; Facebook login by a user with the required Page tasks | Adds hashtag search, product tagging, and partnership ads; messaging uses the Messenger Platform |

The owner Graph API does not provide unrestricted access to personal accounts
or arbitrary public Instagram post data. This adapter reads the connected owner's
`/media` edge and tagged media on that account, and it checks account/media
ownership before comment or media-insight operations. A public post link
cannot be passed to those routes to fetch someone else's content. A separate
oEmbed route can show a public post or Reel as a front-end embed only. There is no
hashtag search, business discovery, public-link scraping, or product tagging.
Instagram Login itself does not support hashtag search, product tagging, or
partnership ads. The existing linked Facebook Page does not change that: those
capabilities need a separate Facebook Login integration and Meta permissions.
Meta App Review says one app chooses either Instagram Login or Facebook Login.
Returned `permalink` values are Instagram post URLs; `mediaUrl` and
`thumbnailUrl` are provider CDN URLs and should not be treated as durable files.
The read-only `/tags` route lists media that tagged the connected account; it
does not create user, collaborator, or product tags. Meta's Instagram Login
[Mentions guide](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions)
explicitly lists `GET /<IG_ID>/tags` on `graph.instagram.com`, while its
[Tags reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/tags)
still shows Facebook Login requirements. Confirm this route with a valid
Instagram Login grant before production use.

## Operator setup

1. Register a Meta developer account and create a Meta app. Add **Instagram →
   API setup with Instagram login** and add the intended professional Instagram
   account as an app user/tester where needed. Verify that the account is
   Business or Creator. A linked Facebook Page is optional for this login path.
2. In that Instagram product's Business Login settings, configure the exact
   HTTPS redirect URI
   `APP_FRONTEND_ORIGIN + /one/profile/connectors/oauth/return`. The current
   registry reconciler accepts `https://uat.one.hushh.ai` for UAT and
   `https://one.hushh.ai` for production. Local HTTP, native callback, query,
   fragment, and alternate origins are not supported by this adapter.
3. Store the product's **Instagram App ID** as `INSTAGRAM_APP_ID` and its
   **Instagram App Secret** as `INSTAGRAM_APP_SECRET` in the backend's secret
   store. These are the Instagram product credentials, not the app's Facebook
   Login client credentials. Never place them in source, browser configuration,
   a browser URL, an operator command, or a support ticket. Meta's token
   exchange requires the secret in a backend HTTPS request parameter; ensure
   request URLs are redacted from transport and access logs. The backend also needs its
   existing `EXTERNAL_CONNECTOR_CREDENTIAL_KEY` for encrypted grants.
4. Apply migrations `283_instagram_graph_transport.sql`,
   `284_instagram_publication_claims.sql`, and
   `285_instagram_oembed_request_budgets.sql` through the normal
   release migration path. With environment and database identity already
   attested, run from `consent-protocol`:

   ```sh
   python3 scripts/ops/reconcile_instagram_connector.py --env uat --activate
   python3 scripts/ops/reconcile_instagram_connector.py --env uat
   ```

   Use `--env production` only against the attested production project and
   database. The default invocation is read-only verification. `--deactivate`
   disables the registry row without deleting owner grants; connected owners
   retain a recovery/disconnect state in the catalog. Do not use the generic MCP
   descriptor CLI for this Graph REST transport.
5. Confirm the Connectors catalog reports Instagram as available, complete one
   owner OAuth flow, exercise each enabled capability with test content and
   explicit write confirmation, then disconnect during acceptance. Check Meta's
   live publishing quota before publishing. Do not log or copy authorization
   codes, tokens, App Secrets, or provider responses.

The registry row is pinned by the adapter: connector ID `instagram`, transport
`instagram_graph_rest`, Graph base `https://graph.instagram.com/v25.0`, Meta's
Instagram authorization and token endpoints, exact ordered scopes, credential
variable names, capability policy, and one registered redirect URI. A missing or
drifted row or missing app credentials makes Connect unavailable. The reconciler
checks the expected row and refuses to overwrite a different policy.

### Release readiness gate

The UAT deploy workflow has an opt-in `assert_instagram_ready` dispatch input.
It requires a backend candidate, verifies the active pinned registry row against
the attested UAT database after migrations, checks enabled latest Secret Manager
versions for the two Instagram app credentials and the connector encryption key,
and verifies the candidate Cloud Run revision binds those secrets before traffic
promotion. UAT also requires a shared Redis limiter secret for public embeds.
With the input left off, unrelated releases retain their existing deployment
path. Provision and activate the row before selecting this gate; it is a
read-only assertion, not a registry mutation. The production release gate uses
the same registry and candidate checks against its production project.

This gate proves deployment wiring only. For arbitrary Instagram accounts,
Meta must separately grant the required Advanced Access permissions, approve
Business Verification and App Review, and make the app available in Live mode.
Until those states are confirmed with a non-role Instagram account, a successful
developer/tester OAuth flow is not evidence that all UAT users can connect.

### Meta access level

The OAuth flow requests `instagram_business_basic`,
`instagram_business_content_publish`, `instagram_business_manage_comments`,
`instagram_business_manage_messages`, and
`instagram_business_manage_insights`. The connector requires all five grants
at completion. Meta's [insights guide](https://developers.facebook.com/documentation/instagram-platform/insights)
lists the insights scope for Instagram Login; Meta's overview and App Review
tables currently omit or spell some scope names differently, so use the live
app dashboard and authorization result to confirm the exact permissions.
Meta's Instagram Login landing page has a four-scope list, while the
insights guide explicitly names the fifth scope. Confirm insight reads
with a valid token before production use.

**Standard Access** is generally enough when the app serves only an Instagram
account its app-role users own or manage. **Advanced Access** is needed to serve
outside accounts and requires Meta App Review and Business Verification. Meta
currently prompts this app to become a **Tech Provider** before it can add an
Instagram permission to App Review. Meta says that designation cannot be
reversed and adds a separate **Access Verification** for access to another
business portfolio's data, along with stricter data-handling review. Complete
that verification before claiming external-account availability. Meta
also gates some individual features separately: hashtag search requires review
for Instagram Public Content Access on the Facebook Login path, and its webhook
guide lists additional Live-app, Advanced Access, and Business Verification
requirements. This adapter has no webhook subscription. Do not infer approval
for other features from a successful media read. App Review requires a
testable app, visible login, privacy policy and app settings, use-case details,
and an end-to-end screencast for each requested permission. Request only
permissions the app actually uses.

## API and token lifecycle

All routes are under `/api/connectors`; the response and errors are `no-store`.

| Route | Authority | Current result |
| --- | --- | --- |
| `GET /api/connectors` | Vault Owner | Instagram catalog/status, `managedOAuth`, availability, and redacted account label; no credentials or provider subject |
| `POST /api/connectors/instagram/connect/oauth/start` | Vault Owner | Requires exact `redirectUri`, `flow: "web"`, and `profile: "selected"`; returns `authorizeUrl`, opaque `attemptId`, connector ID, and expiry |
| `POST /api/connectors/oauth/complete/web` | Same Firebase owner as the unexpired, Vault-authorized attempt | Accepts `attemptId`, signed `state`, and one-time `code`; atomically claims the attempt, verifies account type and granted scopes, and stores an encrypted long-lived token |
| `GET /api/connectors/instagram/oembed?url=…&max_width=540` | Vault Owner, with no Instagram connection required | Returns `{html}` for a public Instagram post or Reel front-end embed; no Instagram User token or app credential is sent |
| `GET /api/connectors/instagram/media?limit=25&after=…` | Vault Owner | Returns `posts` and opaque `nextCursor`; `limit` is 1–50, and each post may include ID, type, permalink, timestamp, media URL, and thumbnail URL |
| `POST /api/connectors/instagram/disconnect` | Vault Owner | Scrubs the local grant and fences in-flight work; `revocationOutcome: "unavailable"` means Meta token revocation was not performed |

### Public URL oEmbed preview

Meta's [June 15, 2026 announcement](https://developers.facebook.com/blog/post/2026/06/15/tokenless-access-to-meta-oembed-apis/)
made public Instagram oEmbed available without an access token or App Review
submission. This route calls `graph.facebook.com/v25.0/instagram_oembed` without
the owner's Instagram grant or Meta app credentials. It accepts only HTTPS
`instagram.com/p/{shortcode}/` or `/reel/{shortcode}/` URLs, strips sharing
parameters, and bounds `max_width` to 320–658 (default 540). Meta also
documents profile embeds, but this service intentionally does not accept
profile URLs. It returns only Meta's validated, script-free embed `html` and
safe error codes. It does not return author, thumbnail, caption, or media-file
metadata.

Use the returned HTML only to render an isolated front-end view of that public
post. Meta's [oEmbed guide](https://developers.facebook.com/documentation/instagram-platform/oembed)
prohibits extracting, manipulating, persisting, or deriving metadata/content
for ingestion, search, chat context, or analytics. Do not store the response or
make it a connector data source. The request uses `omitscript=true`; a client
that renders the blockquote must load Instagram's `embed.js` in its isolated
rendering context and call `instgrm.Embeds.process()` after insertion. Meta
does not support private, inactive, age-restricted, or embed-disabled accounts,
Stories, or Shadow DOM embeds. A public URL or valid syntax does not guarantee
an available embed.

Meta publishes a tokenless limit of 1,000 oEmbed requests per hour. UAT and
production share this Meta integration, so UAT reserves at most 4 requests per
minute in its shared Redis limiter and production reserves at most 12 per
minute in an atomic Cloud SQL bucket. Both fail closed if their shared budget
cannot be enforced. Production has no Redis service or VPC path. The
production table stores only aggregate minute counts and opportunistically
removes rows older than two hours. A rolling hour can span at most 61 minute
buckets, so combined requests are capped at 976 even across a boundary.
Meta's older
[oEmbed Read feature page](https://developers.facebook.com/docs/features-reference/oembed-read/)
still describes App Review and Business Verification for the approved
token-based feature; those gates do not apply to basic tokenless public embeds.
This implementation does not use the reviewed higher-quota token path. Verify
one real public embed and the isolated rendering flow before production use.

### Capability routes

All routes below require a connected Vault Owner and the relevant granted
scope. The REST adapter accepts fixed Graph operations only; clients do not
provide Graph paths or tokens. All write bodies include `confirmed: true`,
which must follow an owner review of the proposed content or change.

| Route | Request / result |
| --- | --- |
| `GET /api/connectors/instagram/publishing-limit` | Current rolling quota `used`, `total`, and `durationSeconds` from Meta; the latter two can be null. |
| `POST /api/connectors/instagram/media/photo-container` | Public HTTPS `imageUrl`; optional `caption`, `altText`, `carouselItem`, `isAiGenerated`; returns a signed `containerHandle`. |
| `POST /api/connectors/instagram/media/reel-container` | Public HTTPS `videoUrl`; optional `caption`, `shareToFeed`, `isAiGenerated`; returns a signed `containerHandle`. |
| `POST /api/connectors/instagram/media/story-image-container`, `/story-video-container` | Public HTTPS `imageUrl` or `videoUrl`; returns a signed Story `containerHandle`. Stories do not take captions. |
| `POST /api/connectors/instagram/media/video-carousel-item` | Public HTTPS `videoUrl`; returns a signed child `containerHandle`. |
| `POST /api/connectors/instagram/media/carousel-container` | Two to ten photo/video child `containerHandle` values in `children`; optional `caption`, `isAiGenerated`; returns a signed `containerHandle`. |
| `GET /api/connectors/instagram/media/containers/{handle}` | Container `kind` and Meta processing `status`. |
| `POST /api/connectors/instagram/media/publish` | `containerHandle`; publishes only a ready photo, reel, Story, or carousel container and returns `mediaId`. |
| `GET /api/connectors/instagram/media/{media_id}/comments?limit=25&after=…` | Comments on owned media, `comments` and `nextCursor`; limit 1–50. |
| `POST /api/connectors/instagram/comments/{comment_id}/reply` | `message` up to 2,200 characters; returns `commentId` after verifying the comment belongs to owned media. |
| `POST /api/connectors/instagram/comments/{comment_id}/hide` | Boolean `hidden`; returns the new hidden state after the same ownership check. |
| `POST /api/connectors/instagram/comments/{comment_id}/delete` | Deletes an owned-media comment; returns `deleted`. |
| `GET /api/connectors/instagram/insights/account?metric=…` | One allowlisted account metric for one day: `reach`, `views`, `accounts_engaged`, `total_interactions`, or `profile_links_taps`; returns `metric`, `available`, `value`. |
| `GET /api/connectors/instagram/insights/media/{media_id}?metric=…` | One allowlisted metric on owned media: `reach`, `views`, `likes`, `comments`, `saved`, `shares`, `total_interactions`, `ig_reels_avg_watch_time`, or `ig_reels_video_view_total_time`. |
| `GET /api/connectors/instagram/tags?limit=25&after=…` | Media that tags the connected account, `media` and `nextCursor`; this is not a general mention or hashtag search. |
| `GET /api/connectors/instagram/messages/{recipient_id}` | Up to 20 recent messages in an existing conversation with the specified recipient. |
| `POST /api/connectors/instagram/messages/{recipient_id}/send` | `message` up to 1,000 UTF-8 bytes; sends text only after the service sees that recipient's inbound message within 24 hours; returns `messageId`. |

Publishing uses media files at publicly fetchable HTTPS URLs, not Instagram
post URLs or local files. Photo, reel, Story, and carousel creation returns a
short-lived, owner/account-bound handle. Poll container status before publish;
only `FINISHED` is publishable. A durable database claim allows each creation
container to be submitted for publication once, including after an uncertain
Meta response. The service does not blindly retry a write if Meta's result is
unknown. Meta's published quota figures differ across guides,
so use the `publishing-limit` route's live response. Messaging does not support
cold outreach or arbitrary recipients; a recipient must already have a
conversation, and standard replies have a 24-hour window. Insights can be
unavailable for a metric or account; `available: false` is distinct from zero.
Meta's regular owned-media edge excludes Stories, so the owned-post list does
not show newly published Stories.

The server exchanges a one-time authorization code for a short-lived token,
then for an Instagram User token with a roughly 60-day lifetime. It refreshes
the long-lived token before expiry under a single-owner lifecycle lease and
requires reconnection if refresh or the grant is rejected. The returned media
cursor is an opaque paging value; clients must pass it back unchanged and must
not derive Graph URLs from it. Disconnect removes the local grant. The owner may
also remove the app in Instagram's **Apps and Websites** settings to revoke
provider-side access.

## Meta sources

- [Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login)
- [Business Login and token lifecycle](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Instagram API with Facebook Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login)
- [App Review](https://developers.facebook.com/documentation/instagram-platform/app-review)
- [Tech Providers](https://developers.facebook.com/docs/development/release/tech-providers/)
- [Access Verification](https://developers.facebook.com/docs/development/release/access-verification/)
- [Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [Insights](https://developers.facebook.com/documentation/instagram-platform/insights)
- [Comment moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation)
- [Instagram Login messaging](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)
- [Instagram oEmbed](https://developers.facebook.com/documentation/instagram-platform/oembed)
- [Meta tokenless oEmbed announcement](https://developers.facebook.com/blog/post/2026/06/15/tokenless-access-to-meta-oembed-apis/)
- [Webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks)
