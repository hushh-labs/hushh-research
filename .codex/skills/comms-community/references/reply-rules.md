# Discord Reply Rules

Use these rules for public community responses:

1. Keep it readable in one screen. Hard cap: 3 to 4 lines of prose. If the point does not fit, it is not the point. Signature sits on its own line after that.
2. Casual thread register, not memo register. Contractions are fine. Short sentences. Read it out loud, if it sounds like a memo it is wrong, if it sounds like a thread message it is right.
3. No section headers, no bold sub-labels like `**On X:**`. Fold sub-points into the prose.
4. Lead with the answer in the same breath as the correction if the premise is off. First sentence is the conclusion. Evidence or doc pointer follows in one line.
5. Be explicit about current state vs future plan.
6. Prefer `today / currently / right now` when answering present-state questions.
7. If the repo supports nuance, compress it rather than dumping internals.
8. Public/community replies should link markdown docs only, not source files. `.py`, `.ts`, `.tsx`, `.yaml`, `.json` are internal context, not public citation material.
9. Internal repo-backed Q&A may cite source files or GitHub issue/PR links when they directly prove the point and the user asked for evidence or the premise needs correction.
10. All public links must be full GitHub URLs on `main`, not relative paths. Format: `https://github.com/hushh-labs/hushh-research/blob/main/<path>`. Append `#L<n>` or `#L<start>-L<end>` only when pointing to a specific passage.
11. Never use em-dashes (`—` U+2014) or en-dashes (`–` U+2013). Use commas, periods, parentheses, colons, or hyphens.
12. Choose references that directly prove the answer for that exact question.
13. Do not reuse generic docs out of habit if a more specific canonical doc exists.
14. If refs are not adding evidence, leave them out.
15. End with a signature line naming which codex skills were used, format: `_codex skills used: \`<skill-id>\`[, \`<workflow-id>\`]_`. No em-dash prefix.
16. Do not answer with certainty if the repo/docs only show a future plan.
17. Do not reflexively agree with the questioner.
18. If the premise is wrong, say so plainly and explain the actual boundary.
19. Prefer architectural correction over conversational validation.
20. When answering as the owner/maintainer, use ownership language:
   - `today this is scoped to ...`
   - `that is not the shipped surface yet`
   - `that is a valid extension and consistent with the direction`
21. Do not hide behind passive phrasing like `I didn't come across` when the repo/docs allow a firmer owner answer.
22. If the user explicitly wants a sharper reply, keep it crisp and corrective, not hostile.
23. Do not mirror baiting or swagger from the questioner; answer from the architecture.
24. If the conversation is already in a Q&A chain, treat the recent thread as active context.
25. In a thread follow-up, answer only the architectural delta unless a reset is necessary.
26. If the question proposes the wrong mechanism, say that directly and replace it with the right mechanism.
27. Prefer `No, because ...` over padded phrasing when the architecture is already decided.
28. If the question is about cross-layer or agent boundaries and the repo already ships MCP/A2A, say that directly instead of answering as if it is hypothetical.
29. On revocation/control questions, prefer the founder-level contract:
   - `revocation stops future access immediately`
   - `control does not mean pretending prior use never happened`
   - `the product promise is bounded access, auditability, and cleanup of governed stored state`
30. On service-worker proposals, do not credit the worker as the security model if the repo/docs make it a delivery/runtime helper rather than the vault trust boundary.
31. For security-boundary replies that need more explanation, use the sequence:
   - wrong boundary
   - actual architecture
   - current mitigations / shipped mechanisms
32. When saying a proposal is wrong, include:
   - what risk it introduces
   - what product/security property it weakens
   - what the correct replacement mechanism is
33. If the real proposal is "keep the token effectively available after refresh for UX," name that explicitly instead of debating only the wrapper mechanism.
34. On versioning/mutation questions, do not imply cryptographic code verification unless the docs explicitly support it.
35. Prefer the distinction:
   - `token/scope verification is cryptographic`
   - `operon/version governance is manifest + contract + release discipline`
36. For repo-backed internal Q&A, verify the premise before drafting:
   - file/module exists in the current tree
   - concern is visible in current tests, logs, or code when feasible
   - otherwise answer that the report is not grounded in the current repo snapshot
37. When the user asks for reply variants, emit exactly these tiers:
   - `Default`
   - `Firmer`
   - `Detailed`
38. `Default` should be short and actionable.
39. `Firmer` should be explicit about what is and is not grounded in the repo.
40. `Detailed` should explain the repo evidence, what is real, what is not, and the next step to unblock the teammate.
41. Optional evidence links are only worth adding when they materially improve the answer:
   - source-file links for internal Q&A
   - issue/PR links when the concern is tied to open review or active branch work
   - no links when they add clutter without proof value

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
