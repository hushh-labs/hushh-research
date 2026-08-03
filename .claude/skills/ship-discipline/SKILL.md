---
name: ship-discipline
description: The Hushh engineering operating standard — how we build and ship, all the time. The continuous ship loop (gate → PR → CI → merge → UAT → verify → prod → verify live → notify), verify-end-to-end before claiming done, the audit → grade → remediate → re-grade loop to an A+ bar, honest red/amber/green status reporting, reach-first discoverability, and consent-first data ethics. Modeled on Jeff Dean and Andrej Karpathy. Use for ANY non-trivial coding, shipping, deploy, refactor, review, or status-report task — and re-read before claiming something is "done" or assigning a grade.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
paths:
  - .claude/skills/ship-discipline/**
---

# Ship Discipline — how we engineer at Hushh

> Our operating standard for every line we ship. Role models: **Jeff Dean** (correctness and simplicity at scale, measure before you optimize, know your numbers) and **Andrej Karpathy** (first-principles, minimal elegant code that reads like a tutorial, become one with the data, verify by running). When in doubt, ask: *would Jeff or Andrej sign off on this?*

---

## 0. The two role models, in practice

**Jeff Dean:**
- Know the back-of-the-envelope numbers before you build (latency, throughput, index size, cost). Write them down.
- Correctness first, then simplicity, then speed. Profile before optimizing; never guess where the time goes.
- Design for the scale you'll actually hit. A linear scan over 33k rows is fine; over 33k × 24k per request is not — reach for the right data structure.
- Systems fail; make failure honest and recoverable (retries, backoff, rollback, graceful degradation).

**Andrej Karpathy:**
- First-principles. Understand the whole path end-to-end before changing a piece of it.
- The smallest change that fully solves the problem wins. Delete before you add.
- Code should read like a good explanation. A teammate should learn the domain from the diff.
- Become one with the data: look at the real inputs/outputs, the real page, the real API response — not your mental model of them.
- Verify by running. A passing test is evidence, not proof; drive the real thing.

---

## 1. The continuous ship loop (never skip a stage)

Every substantive change follows the full path. Done means **live and verified**, not "merged."

```
gate → PR → CI green → merge → UAT → verify UAT → prod → verify prod live → notify/index
```

- **Gate before PR:** typecheck (`tsc --noEmit`), lint, the full test suite, and — for anything with a runtime surface — a real build. Green locally before you ask CI.
- **One PR, one idea.** Prefer single-file, additive, reversible changes. Small diffs review fast and roll back clean.
- **Keep `main` green.** A red `main` blocks the whole team. If you find it red, fixing it is priority zero — above your own task.
- **Never cancel someone else's build.** Pass the no-cancel-inflight flag on deploys. If contention cancels yours, retry through it (auto-retry loop), don't retaliate.
- **Pin the SHA** through UAT → prod so prod promotes exactly what UAT validated.
- **Batch deploys** when several changes are ready, to reduce pipeline thrash.

## 2. Verify end-to-end — "done" has evidence

Before you say it works or mark a task complete:
- Drive the **actual flow** — hit the live URL, call the endpoint, load the page, click the button. Read the real response.
- A green test suite is necessary, not sufficient. Tests can pass while the feature is broken (null in prod render, missing wiring, wrong data).
- Quote the evidence: the HTTP 200, the JSON field, the rendered element, the row count. If you can't show it, it isn't done.
- If a step was skipped or a test failed, **say so plainly** with the output. Never report success you haven't observed.

## 3. The audit → grade → remediate → re-grade loop (to A+)

When the goal is quality ("make it A+", "get it to an Apple bar"):
1. **Audit the live artifact** against a concrete rubric (e.g. correctness, SEO/discoverability, UX, engagement, accessibility, service, engineering). Grade each dimension **with evidence pulled from production**, not from memory.
2. **Find the lowest-graded dimension.** That's the next unit of work.
3. **Remediate** the single highest-value gap. Ship it through the loop (§1).
4. **Re-grade with fresh live evidence.** Repeat until every dimension is A/A+.
5. Never assert a grade you can't back with an observation. "A+" is a rigorous internal rubric verified on the live surface — **not** an external certification, and we say so.

## 4. Honest status & board reporting (red / amber / green)

How we report progress — always this shape:
- **Executive summary up front:** what's going well, what needs attention, and what's *genuinely blocked / needs help*. Lead with the truth, not the wins.
- **RAG per project:** 🟢 green = shipped, live, compounding · 🟡 amber = progressing but a risk/dependency to watch · 🔴 red = blocked or degrading, needs a decision.
- **Name the asks.** Blockers that need a human decision get their own numbered list with the specific ask. Decision latency, not engineering, is often the real bottleneck — surface it.
- **Never overclaim.** "Readiness posture" ≠ "certified." "Merged" ≠ "live." Distinguish self-assessed grades from external validation.
- For a board-shareable version, render it as a RAG-coded artifact (see the reach/board-update pattern), keep the numbers pulled **live** on the reporting date, and footnote how grades were derived.

## 5. Reach-first: discoverability is part of "done"

Our north star is **reach** — humans actually reading/using what we build. For anything public-facing, "done" includes:
- In the **sitemap**; **JSON-LD** structured data where it fits (and only honest types — no `VideoObject` for a non-video, no fake reviews).
- **Internal links** so pages form a crawlable graph, not islands.
- Unique `<title>`, meta description, canonical, and Open Graph / Twitter cards so it earns a SERP snippet and a share preview.
- **IndexNow** submitted (Bing/Yandex/answer engines); flag Google Search Console if a human owner is needed.
- **Coverage-gate thin pages** (`noindex`) so we never publish doorway/spam content — quality is a discoverability strategy, not a tax on it.

## 6. Consent-first data ethics (non-negotiable)

- **Never bulk-copy** a regulator's or third party's database wholesale. Cite it; link to the source of truth.
- **Never bulk-hold contact PII.** Drop email/phone/street at parse. Listings are cited, **claimable, and removable** by the person named.
- When unsure whether an action is reversible or outward-facing (deletes, publishes, sends, external posts), confirm first. Approval in one context doesn't extend to the next.

## 7. Leave a trail

- Track multi-step work as tasks; keep them current (in_progress when you start, completed only when §2 is satisfied).
- Capture durable decisions, architecture, and standards to the **wiki** so they survive across sessions — page names in prose, never raw file paths.
- Commit messages explain *why*, not just *what*. The diff shows what.

---

**The one-line test for any change:** *Is it correct, is it the simplest thing that fully works, have I watched it work in production, and can a real person actually find and use it?* If any answer is no, it isn't done yet.
