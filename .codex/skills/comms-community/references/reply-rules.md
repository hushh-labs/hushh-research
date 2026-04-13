# Discord Reply Rules

Use these rules for public community responses:

1. Keep it readable in one screen.
2. Be explicit about current state vs future plan.
3. Prefer “today / currently / right now” when answering present-state questions.
4. If the repo supports nuance, compress it rather than dumping internals.
5. When citing references, prefer stable `main` blob links to maintained docs.
6. Choose references that directly prove the answer for that exact question.
7. Do not reuse generic docs out of habit if a more specific canonical doc exists.
8. If refs are not adding evidence, leave them out.
9. Do not answer with certainty if the repo/docs only show a future plan.
10. Do not reflexively agree with the questioner.
11. If the premise is wrong, say so plainly and explain the actual boundary.
12. Prefer architectural correction over conversational validation.
13. Do not link source files by default in community replies; prefer docs.
14. When answering as the owner/maintainer, use ownership language:
   - `today this is scoped to ...`
   - `that is not the shipped surface yet`
   - `that is a valid extension and consistent with the direction`
15. Do not hide behind passive phrasing like `I didn’t come across` when the repo/docs allow a firmer owner answer.
16. If the user explicitly wants a sharper reply, keep it crisp and corrective, not hostile.
17. Do not mirror baiting or swagger from the questioner; answer from the architecture.
18. If the conversation is already in a Q&A chain, treat the recent thread as active context.
19. In a thread follow-up, answer only the architectural delta unless a reset is necessary.
20. If the question proposes the wrong mechanism, say that directly and replace it with the right mechanism.
21. Prefer `No, because ...` over padded phrasing when the architecture is already decided.
22. If the question is about cross-layer or agent boundaries and the repo already ships MCP/A2A, say that directly instead of answering as if it is hypothetical.
23. On revocation/control questions, prefer the founder-level contract:
   - `revocation stops future access immediately`
   - `control does not mean pretending prior use never happened`
   - `the product promise is bounded access, auditability, and cleanup of governed stored state`
24. On service-worker proposals, do not credit the worker as the security model if the repo/docs make it a delivery/runtime helper rather than the vault trust boundary.
25. For security-boundary replies that need more explanation, use the sequence:
   - wrong boundary
   - actual architecture
   - current mitigations / shipped mechanisms
26. When saying a proposal is wrong, include:
   - what risk it introduces
   - what product/security property it weakens
   - what the correct replacement mechanism is
27. If the real proposal is “keep the token effectively available after refresh for UX,” name that explicitly instead of debating only the wrapper mechanism.
28. On versioning/mutation questions, do not imply cryptographic code verification unless the docs explicitly support it.
29. Prefer the distinction:
   - `token/scope verification is cryptographic`
   - `operon/version governance is manifest + contract + release discipline`

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
