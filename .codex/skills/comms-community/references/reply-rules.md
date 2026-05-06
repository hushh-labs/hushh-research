# Discord Reply Rules

Use these rules for public community responses:

0. Inherit the truth-first operating kernel from `.codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md`: extract material claims, classify them, and answer from current repo evidence before accepting contributor wording.
1. Keep it readable in one screen. Default hard cap: 3 to 4 lines of prose. If the user asks for an announcement, product update, launch note, or cinematic cadence, the reply may use more line breaks for rhythm but should still stay short enough to post without editing.
2. Casual thread register, not memo register. Contractions are fine. Short sentences. Read it out loud, if it sounds like a memo it is wrong, if it sounds like a thread message it is right.
3. No memo-style section headers or bold sub-labels like `**On X:**` in normal replies. For Discord announcements, one bold headline or anchor phrase is allowed when it improves scanability.
4. Lead with the answer in the same breath as the correction if the premise is off. First sentence is the conclusion. Evidence or doc pointer follows in one line.
5. Be explicit about current state vs future plan.
6. Prefer `today / currently / right now` when answering present-state questions.
7. If the repo supports nuance, compress it rather than dumping internals.
8. Public/community replies should link markdown docs only, not source files. `.py`, `.ts`, `.tsx`, `.yaml`, `.json` are internal context, not public citation material.
9. Internal repo-backed Q&A may cite source files or GitHub issue/PR links when they directly prove the point and the user asked for evidence or the premise needs correction.
10. All public links must be full GitHub URLs on `main`, not relative paths. Format: `https://github.com/hushh-labs/hushh-research/blob/main/<path>`. Append `#L<n>` or `#L<start>-L<end>` only when pointing to a specific passage.
11. For drafted Q&A / teammate-share replies, default output must include exactly:
   - `Brief reply`
   - `Detailed reply`
   - `Firmer reply` only when the user explicitly asks for sharper wording or the premise is materially wrong enough that a separate correction helps
12. When maintained docs answer the question, link those GitHub docs first. Do not answer with repo-relative paths unless the user explicitly wants repo-local references.
13. Never use em-dashes (`—` U+2014) or en-dashes (`–` U+2013). Use commas, periods, parentheses, colons, or hyphens.
14. Choose references that directly prove the answer for that exact question.
15. Do not reuse generic docs out of habit if a more specific canonical doc exists.
16. If refs are not adding evidence, leave them out.
17. End with a signature line naming which codex skills were used, format: `_codex skills used: \`<skill-id>\`[, \`<workflow-id>\`]_`. No em-dash prefix.
18. Do not answer with certainty if the repo/docs only show a future plan.
19. Do not reflexively agree with the questioner.
20. If the premise is wrong, say so plainly and explain the actual boundary.
21. Prefer architectural correction over conversational validation.
22. When answering as the owner/maintainer, use ownership language:
   - `today this is scoped to ...`
   - `that is not the shipped surface yet`
   - `that is a valid extension and consistent with the direction`
23. Do not hide behind passive phrasing like `I didn't come across` when the repo/docs allow a firmer owner answer.
24. If the user explicitly wants a sharper reply, keep it crisp and corrective, not hostile.
25. Do not mirror baiting or swagger from the questioner; answer from the architecture.
26. If the conversation is already in a Q&A chain, treat the recent thread as active context.
27. In a thread follow-up, answer only the architectural delta unless a reset is necessary.
28. If the question proposes the wrong mechanism, say that directly and replace it with the right mechanism.
29. Prefer `No, because ...` over padded phrasing when the architecture is already decided.
30. If the question is about cross-layer or agent boundaries and the repo already ships MCP/A2A, say that directly instead of answering as if it is hypothetical.
31. On revocation/control questions, prefer the founder-level contract:
   - `revocation stops future access immediately`
   - `control does not mean pretending prior use never happened`
   - `the product promise is bounded access, auditability, and cleanup of governed stored state`
32. On service-worker proposals, do not credit the worker as the security model if the repo/docs make it a delivery/runtime helper rather than the vault trust boundary.
33. For security-boundary replies that need more explanation, use the sequence:
   - wrong boundary
   - actual architecture
   - current mitigations / shipped mechanisms
34. When saying a proposal is wrong, include:
   - what risk it introduces
   - what product/security property it weakens
   - what the correct replacement mechanism is
35. If the real proposal is "keep the token effectively available after refresh for UX," name that explicitly instead of debating only the wrapper mechanism.
36. On versioning/mutation questions, do not imply cryptographic code verification unless the docs explicitly support it.
37. Prefer the distinction:
   - `token/scope verification is cryptographic`
   - `operon/version governance is manifest + contract + release discipline`
38. For repo-backed internal Q&A, verify the premise before drafting:
   - file/module exists in the current tree
   - concern is visible in current tests, logs, or code when feasible
   - otherwise answer that the report is not grounded in the current repo snapshot
39. When the user asks for reply variants, emit `Brief reply` and `Detailed reply` by default.
40. `Brief reply` should be short, actionable, and sendable without editing.
41. `Detailed reply` should explain only the extra repo evidence, current-state boundary, and next step needed to unblock the teammate.
42. Add `Firmer reply` only when requested or when the premise is materially wrong enough that a separate correction is useful.
43. Optional evidence links are only worth adding when they materially improve the answer:
   - source-file links for internal Q&A
   - issue/PR links when the concern is tied to open review or active branch work
   - no links when they add clutter without proof value
44. Founder-direct Q&A mode is the default for technical community guidance:
   - answer as the maintainer of the architecture, not as a passive reviewer
   - do not "yes-and" a proposal before checking whether the capability already exists
   - correct the premise first when a proposal describes shipped functionality as missing
   - separate `already exists`, `valid improvement`, and `not the right direction`
   - prefer the smallest useful next PR boundary over broad agreement
45. For MCP, consent, scope, and tool-discovery questions, always check the current shipped contract before drafting:
   - dynamic per-user scopes already exist through `discover_user_domains(user_id)` and `/api/v1/user-scopes/{user_id}`
   - MCP tool visibility is already filtered by the current developer principal's allowed tool groups
   - tool list visibility is not the security boundary; every tool call still needs server-side entitlement, token, and consent validation
   - if the contributor proposes "make tools dynamic based on consent," answer by distinguishing dynamic scope discovery, developer/tool entitlement, and per-call consent gating
46. Do not reduce high-risk product questions to conversational approval. For adaptive agent behavior, recommendations, finance outcomes, consent authority, vault access, or PKM memory:
   - name the risk introduced by the proposed mechanism
   - name the safe version of the idea
   - name the first acceptable implementation lane
   - if the change could affect regulated advice, trust boundaries, or durable memory, default to shadow/evaluation mode before runtime mutation
47. When a contributor suggests a feature that overlaps existing infrastructure, the reply should include one crisp maintainer sentence:
   - `That part already exists; the useful contribution is ...`
   - `That is not the boundary we want; the safer version is ...`
   - `Do not build a parallel path; extend the existing ... contract.`
48. For Kai decision, recommendation, portfolio outcome, and agent-weight questions, verify the shipped decision/stream contract before drafting:
   - realtime quote data is already part of the analysis provider path; do not accept "price is missing" without checking the current decision payload and raw card
   - current stream decisions already carry valuation/trend fields, `analysis_updated_at`, diagnostics, and a `market_snapshot` in the live stream path
   - the likely missing piece is usually a durable shadow-evaluation contract, not the visible decision card itself
   - keep user-facing Decision Card fields separate from internal evaluation telemetry unless the product surface explicitly needs the field
   - never suggest live agent-weight mutation from outcomes; recommend shadow logging, offline cohort evaluation, and promotion gates first
49. For statements phrased as "we are missing X," use this sequence:
   - check whether X already exists in code/docs/contracts
   - if X exists, say `we already capture X; the gap is Y`
   - if X exists only transiently, say `we compute X but do not persist it in the right evaluation surface yet`
   - if X truly does not exist, name the smallest contract where it belongs
   - do not draft a reply that treats an unverified "missing" claim as fact
50. Keep normal Q&A lean:
   - do not output three variants unless `Firmer reply` adds real value
   - do not add memo-like headings beyond `Brief reply` and `Detailed reply`
   - do not repeat the same point in both replies unless the detailed version needs it for clarity
   - do not include implementation inventories unless the user asks for exact files or proof
   - prefer one crisp correction plus one concrete next PR boundary

## Discord Native Formatting Mode

Use this mode when the user asks for Discord formatting, a channel post, product update, launch note, announcement, founder voice, cinematic cadence, or a message meant to be pasted directly into Discord.

Discord message length contract:

1. Default hard limit: `2000` characters per message content.
2. Default safe drafting budget: `1900` characters per message.
3. If a drafted Discord message exceeds the safe budget, split it into copy-ready batches instead of returning one oversized block.
4. Do not target `4000` characters unless the user explicitly asks for a Nitro-oriented draft; even then, keep a fallback split available.
5. Keep batch labels outside the copy block so the user can copy only the message body into Discord.
6. Use the deterministic helper when the draft is long:

```bash
python3 .codex/skills/comms-community/scripts/discord_chunk.py --limit 1900 < /tmp/discord-message.md
```

Copy batch format:

````md
Discord copy batch 1/2 (1840 chars)

```text
<message body only>
```
````

Allowed Discord formatting:

1. `**bold**` for one headline, name, or promise. Do not bold every important noun.
2. Short line breaks to create rhythm.
3. `>` blockquote for a motto, thesis, or one defining sentence.
4. Bullets for quick scan lists, especially ontology or release notes.
5. Inline code only for exact repo, API, command, token, or package identifiers.
6. One link max unless the user asks for sources.

Avoid:

1. Markdown tables. They read poorly in Discord.
2. Long section headings.
3. Nested bullets.
4. Decorative emoji unless the user explicitly wants brand/launch energy.
5. Formatting that hides the current-state versus future-state boundary.

Discord announcement pattern:

```md
**<cinematic anchor>.**

<one short line that says what changed>

<one short line that explains why it matters>

> <optional motto or thesis>
```

Common framing:

- `Not today.`
- `Right now, the model is ...`
- `The current boundary is ...`
- `That is part of the future direction, but not the shipped default yet.`
- `That is intentional, not an oversight.`
- `The tradeoff here is deliberate because ...`
- `No, that is not the boundary we want.`
- `That was already the point of the earlier boundary.`
- `No. The right boundary is ...`
