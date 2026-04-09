---
name: discord-community-replies
description: Use when drafting short community-facing replies for Discord or public chat about hushh-research, Kai, PKM, consent architecture, mobile/native tradeoffs, privacy boundaries, roadmap questions, or repo-based technical Q&A. Keep replies concise, accurate, and explicit about what is shipped today vs future direction.
---

# Hushh Discord Community Replies

Use this skill when the user pastes a Discord/community question and asks for a reply.

## Source of truth

Read only the docs needed for the specific question.

1. Start with `.codex/skills/discord-community-replies/references/reply-rules.md`.
2. Then choose the smallest set of repo docs that directly answer the question.
3. Do not reuse the same generic references unless they are genuinely the best source for that exact answer.
4. Prefer the most specific canonical doc for the topic:
   - IAM / actor / consent-boundary questions → `docs/reference/iam/*`
   - MCP / external developer / scoped export questions → `consent-protocol/docs/reference/developer-api.md`
   - agent execution / delegation / A2A boundary questions → `consent-protocol/docs/reference/agent-development.md`
   - PKM / BYOK / encrypted-storage questions → `consent-protocol/docs/reference/personal-knowledge-model.md`
   - vault token / access-state questions → `consent-protocol/docs/reference/consent-protocol.md`
   - mobile/native auth-storage questions → `docs/reference/mobile/capacitor-parity-audit-report.md`

## Response contract

1. Answer from the repo and current docs, not from guesswork.
2. Start with the direct answer. If the premise is wrong, say so immediately.
3. Distinguish clearly between shipped behavior and future direction.
4. Do not validate a community member's premise unless the repo/docs support it.
5. Do not overclaim product capabilities.
6. Use owner language when the architecture is intentional.
7. Prefer short Discord-ready replies unless the user asks for a longer answer.
8. If useful, include references to maintained docs on `main`, not source files.
9. References must be question-specific and evidence-bearing, not boilerplate.
10. If no doc materially improves the reply, omit refs instead of padding with generic ones.
11. Only cite code files if the user explicitly asks for implementation-level proof.
12. Avoid internal-only jargon unless the user used it first.
13. If the user asks for a sharper reply, be crisp and corrective, not hostile.
14. If the reply is part of an ongoing Discord thread, use the recent thread as active context and answer only the new delta.
15. If the question is about business trust, user control, revocation, or ownership, answer at founder level:
   - define what control actually means in the product
   - state what stops immediately
   - state what does not get magically undone
   - frame the contract in terms of user trust, system boundaries, and product honesty
16. Infer the actual ask behind the wording.
   - If a proposal sounds like encryption or encapsulation, but the real ask is “keep authority alive longer for UX,” answer that underlying ask directly.
   - Do not let implementation jargon hide the true tradeoff.

## Default structure

Use this shape unless the user asks otherwise:

1. one direct answer sentence
2. one or two clarification sentences:
   - state the actual boundary
   - state the correct direction if the question proposes the wrong mechanism
3. optional `Refs:` line with one or two GitHub doc URLs
4. Do not add praise, agreement, or “good point” framing unless the repo evidence actually supports that conclusion.
5. If the question is about a missing capability, prefer:
   - `today this is scoped to ...`
   - `X is a valid extension / planned direction`
   instead of only saying `I don't see it`.
6. If the question tries to sound clever or provocative, answer the architecture directly instead of mirroring the tone.
7. If prior messages already established the security or architecture north star, build from that instead of reopening the whole premise.
8. Do not hide the real answer behind “could / may / might” if the repo already defines the boundary.

## Known patterns

1. Privacy / PKM / retrieval questions:
   - explain encrypted PKM segments + sanitized index + consent-scoped retrieval
   - state whether the questioned capability is shipped today or only planned
2. Native vs cross-platform questions:
   - answer in terms of boundary ownership, not framework ideology
   - native/platform layer for trust-sensitive or hardware-sensitive paths
   - shared layer for higher-level product flows
3. On-device AI questions:
   - cloud remains primary unless docs explicitly say otherwise
   - on-device is additive when the docs describe it as future plan
4. MCP / A2A / external agent boundary questions:
   - answer in terms of explicit trust contracts, not loose integration
   - state that external agent interaction already exists through MCP and A2A surfaces
   - emphasize consent tokens, scoped exports, capability manifests, and header/token enforcement
   - if the framing is directionally right, confirm the boundary while still clarifying what is shipped today
5. Revocation / deletion / control questions:
   - say clearly that revocation stops future access in real time
   - do not imply retroactive unlearning unless the docs explicitly support it
   - explain that the honest contract is bounded access, auditable use, and cleanup of governed stored state
6. Service worker / browser security boundary questions:
   - do not treat a service worker as the canonical security boundary for vault credentials
   - if the proposal is “store an encrypted token and unlock it later”, point back to the actual north star: encrypted data at rest, short-lived access state, and secure rehydration where appropriate
   - prefer saying what the service worker is for today (notifications/background delivery) and what it is not for (vault credential persistence)
   - when the user wants more depth, answer in this order:
     1. why the proposed boundary is wrong
     2. what the real trust model is
     3. what mitigations or shipped mechanisms already exist
   - if rejecting the proposal, explicitly state the failure mode and the consequence of adopting it
   - if the proposal effectively keeps the token decrypted or re-hydratable on demand for smoother refresh UX, say plainly that this turns ephemeral authority into browser-managed durable authority
