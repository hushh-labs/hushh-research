# Personal World Model: product and engineering KT

## Visual Context

Canonical owner: [One Index](./README.md).

```mermaid
flowchart LR
  Setup[Verified setup, vault and research policy] --> Ensure[Automatic ensure and resume]
  Ensure --> Research[Resumable native research]
  Research --> Draft[View-only Google research]
  Research --> Feed[Feed and optional email]
  Profile[Profile] --> Page[Personal World Model page]
  Draft --> Page
  Page --> Decide[Yes / No / Edit / Remove]
  Decide --> Memory[Encrypted Soul.md memory]
  Memory --> Decisions[Owner decisions]
  Decisions --> Ensure
  Memory --> Page
  Page --> Sources[Independent permitted URLs]
  Sources --> Review[Owner review]
  Review --> PKM[Encrypted PKM]
  Page --> Invite[Contact-bound invitation]
  Invite --> Claim[Recipient verification and claim]
  Claim --> Page
```

Hub content execution is available only in Shared. Private owners require a qualified pod capability; their work never falls back to the hub.

## User experience

Research is on by default. Setup discloses it, and once the owner's setup is resolved the first `ensure` call creates the missing preference row as enabled with readiness email enabled. An existing disabled row is the owner's explicit opt-out and is never turned back on; no migration rewrites existing rows. The owner keeps an off switch for research and for the readiness email.

There is no Build button, research settings screen or manual URL in the main journey. After vault unlock on any non-setup route, the app-wide world-model provider calls `ensure`: a new owner's research starts in the background, an existing owner without a model starts preparation, and interrupted work resumes. Research only progresses while an authenticated client keeps calling `ensure` or `/jobs`; the server keeps the derived chat key for at most 300 seconds. Drafts are purged after 24 hours, and a finished model may be prepared again seven days after its latest preparation started; purged unfinished work may resume sooner. Automatic messages remain outside chat.

Profile has one compact **Personal World Model** row immediately below Memory. It opens the dedicated `/one/profile/world-model` page as a full route, using the existing Profile icons, typography, cards, Back navigation and vault authority. The page shows one state: **Preparing your model**, **Ready to review** or **Up to date**.

Findings are grouped into seven display sections: About, Work, Education, Projects, Interests, Preferences and Public presence. Empty sections are hidden. Each finding is a short fact row with its source and visible **Yes** and **No**. One tap saves the decision to the owner's memory; there is no second Save step, and the row only shows success after the encrypted memory write commits. Tapping a row opens its sources, why it may be about the owner, its uncertainty, and **Edit** and **Remove**.

- **Yes** saves the exact statement.
- **No** remembers the rejection so the statement does not come back. It never saves an opposite fact: rejecting “likes blue” does not save “dislikes blue”.
- **Edit** saves only the owner's corrected wording.
- **Remove** deletes the saved statement and keeps it removed after sign-out and sign-in.

Native Google search suggestions stay displayed with the grounded findings they belong to. **Invite someone** is a later, separate action shown only once the model is usable, never while preparing or empty. The invitation claim block stays reachable on the page in every state. An invitation may carry selected, cited public professional facts from an independently supplied profile URL. It never grants the inviter access to the recipient’s full model.

### Easy user stories

1. **Find my public work.** Alex finishes setup and unlocks the vault; preparation starts without a button. A public company page and project repository support career and project facts under Work and Projects. Alex taps Yes on the ones that are right. Separately supplied permitted sources produce facts Alex can review and save.
2. **Separate namesakes.** Two people share Alex's name. A school or location match alone is insufficient. The draft stays uncertain rather than mixing their biographies.
3. **Find preferences.** Alex explicitly says “blue is my favorite color” in an attributed public interview. That can be proposed with its citation. Wearing blue, buying a gift, or requesting fewer ads does not prove a durable preference or dislike.
4. **Find little information.** Public search finds no reliably linked sources. The page explains that limitation. It does not fill empty sections with guesses.
5. **Keep control.** Alex taps No on a wrong fact; it does not come back and nothing opposite is saved. Alex corrects another with Edit and later removes it; it stays removed after signing in again. Research itself writes no approved memory.
6. **Invite Sam.** Once Alex's model is usable, Alex creates a link bound to Sam's email or international phone. Alex first prepares and checks a public professional preview. Sam can inspect it before claiming, then verifies the matching contact and claims it. Sam's own model is prepared automatically after Sam's setup unless Sam turned research off. Claiming shares nothing with Alex.

## Exact prompt and models

The single authored system instruction is the `one_personal_world_model.system_instruction` block in [the One manifest](../../../consent-protocol/hushh_mcp/agents/one/agent.yaml). Python loads this manifest; it contains no duplicate system prompt. The generated product-agent registries describe the same specialist. The instruction also tells the specialist not to propose again any claim in the owner's confirmed or rejected decisions, or an equivalent of one, and never to infer the opposite of a rejected claim. The model decides equivalence; host code does not.

The specialist's `gemini-default` currently resolves to **Gemini `gemini-3.6-flash`**, with medium thinking and a 16,384-token output ceiling. Gemini uses **native Google Search grounding on Vertex**. No Tavily key is needed. **URL Context on Vertex** reads independently supplied permitted public URLs for reviewable facts. Google research and saved owner knowledge have separate source-use contracts.

All managed text/chat, PWM, Live Voice, and embedding clients read [managed-ai-runtime.json](../../../consent-protocol/config/managed-ai-runtime.json).

| Environment | Vertex project | Text/PWM | Live | Embeddings |
| --- | --- | --- | --- | --- |
| Local/dev | `hushh-pda-uat` | `gemini-3.6-flash` | `gemini-live-2.5-flash-native-audio` | `gemini-embedding-001` |
| UAT | `hussh-511311` (Parth) | same | same | same |
| Production | `hushh-vertex-personal54` | same | same | same |

Text locations are `global`, `us`, `eu`; Live is regional `us-central1`. Cloud Run, SQL, Firebase, and application-secret infrastructure projects are separate from the managed Vertex project. BYOK remains a separate explicitly selected runtime.

Change the checked-in environment profile and deploy its revision. The compiler and runtime share validation and a normalized configuration hash. Candidate readiness compares the image's hash and exercises the configured text and enabled Live targets. The runtime config CI contract rejects managed environment reads outside the canonical settings boundary. Local development retains explicit overrides; hosted runtimes use the packaged profile and ignore retired per-surface project overrides.

## Six identity baselines and confidence pivots

These are stages of one manifest-backed specialist, not six independent services:

1. Read the trusted account name and verified contact; preserve missing values.
2. Keep separate candidate identities from public results.
3. Look for first-party identity anchors and exact identifier linkage.
4. Pivot from combined identifiers to name/email, name/phone, and then evidenced public anchors; never invent a pivot.
5. Inspect contradictions, dates, namesakes, and mirrored sources.
6. Return a decision with a plain-English reason before broad coverage.

Identity states are `owner_linked`, `candidate_for_review`, `ambiguous`, and `no_match`. The report maps these to matched/uncertain/no-match. **Probability stays null:** no calibrated identity estimator has been validated. Each fact independently has supported, uncertain, or conflicting evidence. Strong fact support does not establish that its subject is the owner.

Six baselines describe the reasoning process, not a six-query limit. Overall host-enforced bounds are 32 search invocations and 128 logical model calls across resumable slices. One search invocation may issue multiple Google queries; this is not a billable-query cap. Regional failover can make additional provider requests within a logical model call. Python enforces authority, budgets, receipts, schema, and deadlines. Semantic linkage and interpretation belong to the LLM and owner review.

## Twenty optional topic layers

The model contract keeps these twenty topics. The page groups them for display only (`PWM_SECTIONS` in `hushh-webapp/lib/services/world-model-decision-service.ts`): About = Personal; Work = Career, Business, Achievements; Education = Education; Projects = Projects, Publications; Interests = Interests, Community, Entertainment, Travel, Food; Preferences = Preferences, Dislikes, Style, Shopping, Communication; Public presence = Digital presence, Public records, Security. The grouping never reinterprets a statement.

| Layer | Supported scope |
| --- | --- |
| Business | Companies, products, evidenced founder roles |
| Career | Current/historical roles and expertise |
| Education | Studies and qualifications; enrollment distinguished from graduation |
| Personal | Public non-sensitive biography |
| Projects | Technical and creative work |
| Publications | Papers, books, articles, interviews, talks |
| Achievements | Awards; participation distinguished from winning |
| Community | Volunteering and organizing |
| Interests | Explicitly described hobbies/topics |
| Preferences | Stated choices, likes, routines |
| Dislikes | Explicit exclusions/dislikes; unknown is not dislike |
| Style | Stated colors, design, clothing choices |
| Food | Stated tastes |
| Travel | Published interests, excluding live whereabouts |
| Entertainment | Books, film, music, games |
| Shopping | Explicit product/brand choices |
| Communication | Stated language, tone, format/accessibility preferences |
| Digital presence | Evidenced public profile links |
| Public records | Non-sensitive professional registries |
| Security | Reserved for authorized breach metadata; adapter not implemented |

Each section permits up to eight facts with one to three exact source references. Empty categories are omitted. Topic coverage is a checklist, not a claim that information exists or every platform was searched. Private family relationships, children's dossiers, criminal allegations, sensitive inferences, private accounts, and stolen credentials are outside this public-web discovery endpoint.

### How advertising preferences relate

Advertising systems can combine account settings, activity, contextual signals, and inferred audience categories. Those are different evidence types. A “fewer ads” setting controls advertising; a search or click does not automatically establish a preference. PWM's prompt distinguishes owner declarations, public self-statements, platform actions, observed activity, platform inference, and PWM hypotheses. A saved research decision carries only the owner's wording, topic, decision time and basis `owner_declaration`; an independently supplied source fact carries reviewed text and its exact sources. Structured import/action provenance is a future schema extension, not an implemented private-account feed.

References: [Google My Ad Center](https://support.google.com/My-Ad-Center/answer/12155764), [Google advertising data controls](https://safety.google/privacy/ads-and-data/), [Google Takeout](https://support.google.com/accounts/answer/3024190).

## API and execution

Owner endpoints require an authenticated owner token and the unlocked-vault derived `X-Hussh-Chat-Key`. Invitation-preview alone accepts its opaque capability token in a POST body, exposing only the selected professional preview. Responses are private/no-store. Subject authority is inferred from the authenticated owner, never a client-supplied user ID.

| Endpoint | Meaning |
| --- | --- |
| `POST /api/one/world-model/research` | Explicit integration endpoint with name and verified contact |
| `POST /api/one/world-model/jobs` | Start or reuse owner research with server-resolved identity |
| `GET /api/one/world-model/jobs` | Poll the current job/draft |
| `DELETE /api/one/world-model/jobs?draft_id=…` | Discard that draft generation |
| `GET/PUT /api/one/world-model/preferences` | Read/update the research off switch and readiness-email preference |
| `POST /api/one/world-model/ensure` | Create the default preference once setup is resolved, then idempotently prepare or resume |
| `POST/GET/DELETE /api/one/world-model/source-reviews` | Prepare/read/discard a separate independently supplied source draft |
| `POST /api/one/world-model/source-reviews/complete` | Verify acknowledged owner PKM receipts for that source draft |
| `POST /api/one/world-model/invitation-preview` | Token-authorized public professional preview, without full-model authority |
| `POST /api/one/world-model/invitations/reject` | Verified intended recipient deletes the unclaimed invitation |
| `POST/GET /api/one/world-model/invitations` | Create/list the owner's invitations |
| `DELETE /api/one/world-model/invitations/{id}` | Revoke an invitation |
| `POST /api/one/world-model/claims` | Match verified recipient contact and record explicit claim consent |

Integration request:

```json
{
  "name": "Account display name",
  "email": "verified-owner@example.com",
  "phone_number": "+14155550123"
}
```

Name and at least one verified contact are required. Phone uses E.164. Every supplied field must match the freshly resolved owner's account. The UI normally calls `/ensure` or `/jobs` without sending identifiers. Arbitrary submitted identities are rejected.

`/ensure` and `POST /jobs` accept an optional body carrying the owner's earlier decisions, so research does not propose them again:

```json
{
  "owner_decisions": {
    "confirmed": ["Works on payments infrastructure"],
    "rejected": ["Likes blue"]
  }
}
```

Each list holds at most 50 statements of 1 to 600 characters. The server stores them in the sealed, chat-key-encrypted job state under `inputs`, carries them across resumes, and passes them to the specialist as data. The client separately hides any draft statement whose claim key is already decided; that is an exact-key match only.

A pending result uses HTTP 202. An offered result includes `draft_id`, `report`, `research.identity`, `research.checked_topics`, `research.gaps`, `research.searches_used`, and `pkm_written: false`. Missing configuration or failure before any successful search yields unavailable, not proof that no information exists. Later search failures may produce a partial cited draft with gaps.

The specialist deadline is 240 seconds; the job deadline is 270 seconds. The existing derived key's lifetime remains bounded to 300 seconds. Search calls currently execute serially. Attempt slots are charged durably before dispatch and survive retries and identity edits within the checkpoint budget window. Native search receipts, assessed candidates and topic attempts are checkpointed before the next dependent step. A slice ends before the existing 300-second key authority expires; the app-wide provider's next `ensure` or `/jobs` call from an active owner session resumes the same generation. No key is persisted to run indefinitely after sign-out. An interrupted closed app resumes after the next vault unlock. Full unattended processing after key expiry would require a separately designed processing grant; this release does not claim it.

`managed-ai-runtime.json.pwm_research` declares providers, search/model limits, slice/job/lease durations, preview bounds and notification scheduler identity. Secret-free native Vertex ADC remains the provider authority. Migration 340's old Tavily accounting table remains for migration compatibility, with no active PWM reader or writer. Native research uses the durable per-generation search and model limits above; it does not claim the legacy 900-credit monthly ceiling.

The readiness email is on by default and can be turned off. It uses the existing Workspace mail adapter, not another email provider. A metadata-only outbox is committed with the encrypted draft; a database trigger creates one Feed projection, and at most one email is sent per draft. The email links to the Personal World Model page and does not refer to a settings screen. Failure-to-success retries update that same row without resetting read/dismiss state. Email leases, generation checks, owner preferences and current checkpoint checks prevent duplicate/stale dispatch. Uncertain delivery is not blindly retried. UAT uses the configured test inbox; if that test configuration is absent, email is suppressed. A dedicated OIDC Cloud Scheduler endpoint wakes a bounded drain after scale-to-zero. Provisioning is part of the UAT release and remains behind the feature switch.


## State, save, reset, and invitations

Research uses encrypted checkpoints in namespace `one.personal_world_model.v1`, with identity/policy binding and durable attempts. A draft is not approved knowledge. Discard writes a content-free tombstone and changes the checkpoint fence, preventing an old worker from restoring it. Completion verifies every supplied owner-review commit receipt and dismisses only the specified draft generation; the legacy saved flag cannot bypass those checks. Completion grants no new write authority, and `POST /source-reviews/complete` still refuses a display-only Google research draft with 409.

Owner decisions on research facts live in the owner's vault-encrypted Soul.md memory, PKM domain `one_memory` (`hushh-webapp/lib/pkm/markdown-memory.ts`). The browser writes them through the existing `appendMarkdownMemoryFacts` writer, which uses compare-and-set and resolves only after the encrypted commit. `WorldModelDecisionService` (`hushh-webapp/lib/services/world-model-decision-service.ts`) is the only PWM caller:

| Decision | Memory write |
| --- | --- |
| Yes | Append the exact statement as a bullet |
| No | No bullet; private metadata only |
| Edit | `correct` mutation of the existing bullet to the owner's wording, or append when no bullet exists |
| Remove | `delete` mutation of the bullet; private metadata keeps it removed |

Private metadata `_pwm_claims`, keyed by `pwmClaimKey(statement)`, is stored beside `_source_summaries` in the same encrypted domain object. Every Soul.md writer preserves it, and it is never sent to a model as memory context. Each entry records only the decision, the owner-confirmed or declined wording, its topic, the decision time and basis `owner_declaration`. Grounded answer text, grounding source URLs and titles, and search-suggestion HTML are never saved. Every write resolves with the reloaded memory only after commit, rejects on any failure so the page never shows false success, and is idempotent on retry. There is no second plaintext biography store.

Account deletion removes `one_memory` with the rest of the owner's encrypted PKM, the `one_adk_sessions` research checkpoints, the research preference row and invitation state.

Invitation storage contains a random token hash, keyed contact commitment and optional AES-GCM encrypted professional preview. Its key is derived from the random invitation token and bound to the invitation ID. Raw contact, token and plaintext preview are not stored. New links open the public `/world-model/invite` preview with the token in the URL fragment. Login, phone verification, setup and vault continuation preserve the invitation destination. Links expire in seven days, with at most twenty pending invitations per inviter. Claims verify the intended contact under the shared graph lock, transfer the preview into the recipient’s encrypted source-review checkpoint in the same transaction, and erase transferable ciphertext. Repeated claims by the same recipient are idempotent. Rejection, revocation, reset and deletion remove invitation state. After claiming, the recipient's own model is prepared automatically unless they turned research off; sharing is a separate action.

Native Google results never enter memory as grounded content; only the owner's declaration from a Yes or Edit is saved. Only independently supplied permitted source drafts use `profile_review_v1`; checked/edited facts and their exact sources pass through the existing review and acknowledged-save contract. A provider receipt without successful retrieval cannot support a source fact.


## Apollo/AgentOne knowledge graph implementation plan

“Apollo” is treated here as the application graph; this change does not integrate Apollo.io or a new third-party enrichment database.

1. Project **Subject → Claim → Source**, plus topic membership, from approved PKM only. Use stable PKM domain/entity identities and normalized source identities.
2. Carry a snapshot/content revision. Invalidate graph projections when a source or fact is edited, deleted, retracted, or becomes inaccessible.
3. Extend the existing review/PKM schema with structured evidence basis, observation/publication dates, source-use rights, and supersession/contradiction relationships. Do not silently append unreviewed metadata to the current exact save payload.
4. Add graph/topic filters and inspectable source/claim nodes, with uncertainty and history. Reuse the existing Soul.md and PKM edit/delete flows.
5. Clear decrypted projection state on logout, vault lock, key rotation, or owner change. Keep graph persistence encrypted and canonical.
6. Add graph sharing through explicit consent grants. Invitation claims never imply permission to share.

The current page is a sectioned fact/source list, not an interactive graph. Authorized private-account imports, licensed breach metadata, calibrated probabilities and an interactive graph remain future work. Resumable native search, typed candidate assessments and independently supplied URL Context sources are implemented. Existing Instagram/LinkedIn VM workers live in `hushh-labs/HusshOne`; the Instagram scrape endpoint can initiate Follow requests and both need auth/retention hardening before any owner-scoped read-only PWM integration. They are not invoked by this release.

## Source and exposure references

- [Google Search grounding](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search) and [URL Context](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/url-context): native retrieval capabilities and receipt/display requirements.
- [Dedupe active labeling](https://docs.dedupe.io/en/latest/API-documentation.html), [Splink evaluation](https://moj-analytical-services.github.io/splink/api_docs/evaluation.html), and [confidence calibration](https://proceedings.mlr.press/v70/guo17a.html): references for future labeled evaluation. PWM currently uses explicit evidence states; it does not present an uncalibrated score as probability.
- [Google Cloud service terms](https://cloud.google.com/terms/service-terms): grounding reuse has specific restrictions; owner confirmation alone does not remove provider restrictions.
- [Wikidata access and CC0](https://www.wikidata.org/wiki/Wikidata:Data_access), [Crossref REST metadata](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), and [GitHub public users API](https://docs.github.com/en/rest/users/users#get-a-user): candidates for future direct-source adapters, not wired into this release.
- [Have I Been Pwned API](https://haveibeenpwned.com/API/v3): future authorized exact-identifier breach metadata checks; no collection or display of leaked passwords/tokens. No provider configured means unavailable. “No hit” never means never breached or currently safe.

## Release evidence

See the PR and its exact-commit CI for final verification. Contract/unit tests can prove state, schema, authority, and budget behavior. They do not establish live research precision, source coverage, or latency. Those require live managed Vertex access and consented, labeled evaluation cases before quality claims.


## Automated acceptance and user checks

- Native SDK test: actual nested ADK runner calls native-search child, records received citations, assesses identity and returns a typed report; paid slots precede dispatch.
- Negative controls: wrong-candidate sources, unsupported contact chains, invented coverage, failed URL receipts and unrequested URLs fail closed.
- Lifecycle checks: resumed work preserves spent budgets and `owner_decisions`; turning research off and on again clears old evidence; reset/discard fences old writers; email authority survives cancellation until its provider call ends.
- Review checks: selecting one source fact must never save the unchecked neighbor. Invitation payload includes selected facts only, with token/ID-bound encryption.
- Decision checks: Yes saves the exact statement; No writes no bullet and never an opposite; Edit saves only the corrected wording; Remove stays removed after reload; `_pwm_claims` survives other Soul.md writers and is excluded from model memory context; a failed commit shows no success; retries are idempotent.
- Default-on checks: `ensure` creates a missing preference only after setup is resolved and never flips an explicit opt-out; `owner_decisions` are bounded and carried in the sealed job state across resumes.

User checks on the deployed UAT revision: finish setup and unlock; navigate elsewhere and return while preparation continues; open the Feed item and the email link; open Personal World Model from Profile; tap Yes, No, Edit and Remove, then sign out and in and confirm each decision held; turn research off and confirm it stays off; add an independently supplied profile URL and save only one checked fact; prepare a professional preview and claim it with the intended verified contact; reject another invitation. No automatic PWM chat messages should appear. Live source quality and p50/p95 improvements are not claimed from unit tests.

## Profile presentation

The Profile row opens the dedicated `/one/profile/world-model` route as a full page, not an in-pane panel. The Profile pane renders outside the app-wide world-model provider, so an in-pane panel could not read research status. Edit and Remove for research facts happen on the page itself; Memory still lists the saved statements. Feed, email and existing `/one/profile/world-model?claim=...` invitation links open the same route and keep their contact-bound claim flow. Research, review, saving and invitation permissions remain unchanged.
