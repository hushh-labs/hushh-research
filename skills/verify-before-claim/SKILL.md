---
name: verify-before-claim
description: The engineering bar for all coding work in this repo — verify against the running artifact before claiming anything, reproduce every gate locally before pushing, make the smallest correct change, and never suppress a control to move faster. Use at the start of any coding task, before reporting work as done, before pushing or deploying, and whenever tempted to say "it works" from memory rather than evidence. Encodes the real failure modes that cost this team two weeks.
allowed-tools: Read Grep Glob Bash
---

# Verify before you claim

Apply the repo-wide Principal Craft Kernel and Bacterial Software Architecture Gate from
`AGENTS.md`; this skill adds verification practice and failure-diagnosis discipline, not
authority to weaken correctness, security, or verification.

This skill is the operational expansion of one line in that kernel — *"do not claim
certainty without saying what was verified"*. The kernel states the rule; this states the
specific ways it gets broken here.

The single rule: **a claim is only as good as the evidence you gathered for it.**
Everything below is a specific way that rule gets broken.

---

## 0. What we actually learn from Jeff Dean and Andrej Karpathy

Not decoration — these are the working habits. Both, from opposite ends of the
field, converge on the same enemy: **systems that fail silently.**

### Karpathy — "it fails silently"

His central warning about neural nets is that they are a *leaky abstraction*: a
misconfigured system does not crash, it **trains and produces plausible garbage**.
Everything looks fine. That is exactly our failure mode:

- A branch failed CI for **two weeks** and looked healthy — the tests never ran.
- A page returned `200` and said **"Blog not found."**
- Annotating a source line *appeared* to fix a scanner finding. It did not.

His method, applied here:

- **Become one with the data.** Before writing code, read the actual system:
  the real write path, the real gate script, the real config. Do not design from
  the mental model — design from the artifact.
- **End-to-end skeleton + dumb baseline first.** Get the simplest possible thing
  working end to end and *verified*, then add sophistication. We inverted this and
  paid for it: we built four sophisticated controls before ever proving the branch
  could pass CI or deploy anywhere.
- **Verify at every step; trust nothing.** Add one thing, confirm it did what you
  expected, then add the next. Never batch five unverified changes.
- **Evals are the ground truth.** Not intuition, not "it looks right." If you
  cannot measure it, you do not know it.
- **Code like bacteria** — small, self-contained, independently useful pieces that
  another system could lift without importing your whole world.

### Jeff Dean — know the mechanism, design for failure

- **Back-of-the-envelope before you build.** Estimate orders of magnitude first —
  requests, rows, bytes, round trips — and let that pick the design. Knowing that a
  memory reference is nanoseconds, a datacenter round trip is microseconds, and a
  cross-continent round trip is ~150ms tells you where the design must not go.
  Cheap arithmetic beats expensive rewrites.
- **At scale, everything fails all the time.** Failure is the normal case, not the
  exception. Design so a component's failure degrades the system instead of breaking
  it. This is *precisely* why our audit mirror can never break the consent write it
  mirrors, and why our key resolver has a strict/fail-safe split.
- **Measure the real bottleneck; don't optimize by intuition.** Instrument, then
  act on the number.
- **Watch the tail, not the mean.** The p99 is what users actually feel. A system
  that is fast on average and terrible at the tail is a terrible system.
- **Get the interface right.** Implementations get replaced; a good seam survives.
  The `ComputeBackend` protocol is worth more than any single backend behind it.
- **Roll out incrementally and be able to roll back.** Which is our ship-dark rule.

### The synthesis

Karpathy says *verify every step because failure is silent.* Dean says *assume
failure and design so it degrades safely.* Together: **build the smallest thing that
runs end to end, prove it with measurement, make every component fail safe, and never
believe a system is working because it looks like it is.**

---

## 1. Verify against the artifact, not your memory

Never report status from what you believe. Fetch it, run it, look at it.

- **Status codes lie.** A page returned `200` and we called production live. Its title
  said *"Blog not found"* — a soft-404. **Check content, not just the code.**
- **Screenshots lie without measurement.** A mobile render looked clipped. Measuring
  `document.documentElement.scrollWidth` vs `clientWidth` proved zero overflow — it
  was a headless artifact. **Measure the property you actually care about.**
- **Local runs are not CI.** Tests passed locally for two weeks while CI was red the
  entire time, because the failing gates were governance lanes that never ran locally.

**Checklist before saying "done":**
- [ ] Did I run it, or am I remembering?
- [ ] Did I check the *content* of the response, not just the status?
- [ ] Did I measure the specific property, or eyeball a proxy for it?
- [ ] Is CI green **on the exact SHA I pushed**?

## 2. Reproduce the gate locally before you push

Guessing at a gate burns a CI cycle and teaches you nothing.

- Install the **CI-pinned version** of the tool. We installed `gitleaks 8.24.2` — the
  exact version CI uses — and reproduced the three findings precisely before touching
  anything. Two minutes of setup replaced an unknown number of red pushes.
- Run the gate's own script (`scripts/ci/*-check.sh`) rather than an approximation.
- Re-run it after the fix and confirm the *specific* message is gone.

**Subtlety worth remembering:** history-scanning tools behave differently from
file-scanning tools. Annotating a source line did **not** clear a gitleaks finding,
because gitleaks scans historical commit diffs — the finding lived in the commit that
introduced the line. The mechanism determines the fix.

## 2b. Read the failure signal before you believe its name

A failure's *label* is a design choice someone made; it is not evidence. Three specific
traps, each of which cost us real time:

- **Fallback classifications lie about their cause.** `runtime_mount_missing` is the
  *default* the dev lane emits when the parity report is empty, and
  `semantic_verifier_failed` fires when no report was produced at all. Neither means what
  its name says. We reported a broken dev environment to the board for two weeks on the
  strength of a label that actually meant "a script exited before writing its report".
  **Read the code that emits the classification before repeating it.**
- **Timing is a diagnostic.** A step that fails in ~1 second did not reach the network. That
  is argument parsing, config validation, or a missing binary — not an API or credentials
  problem. A step that fails after ~30s is doing real work. Check the duration before
  forming a hypothesis; it eliminates whole categories for free.
- **Green on the run is not green on the thing.** The workflow reporting success and the
  service actually serving your code are two different claims. Verify deployed revision,
  response *content*, and that flag-gated surfaces are still dark.
- **The worst failure signal is no signal.** A hang has no label to misread. Bumping
  `DB_VERSION` on our IndexedDB service would have blocked forever, because `openDb()`
  never closed its connections and an upgrade waits on every open handle — the promise
  simply never settles. Anything that waits on a resource being released (schema upgrades,
  advisory locks, connection pools, file handles) fails this way. When something is *slow*
  rather than *wrong*, ask what it is waiting for and who was supposed to let go.

## 2c. Unversioned interfaces between config and code

The dev lane runs its **workflow definition from `main`** while running the **script that
workflow invokes from the deployed SHA**. Those two travel independently, so a flag added
to the invocation in `main` breaks every in-flight branch whose copy of the script does not
yet parse it — instantly, with a misleading label.

Generalise the check: whenever configuration and the code it drives come from different
refs, versions, or repositories, that seam is unversioned and will skew. Ask where the
caller comes from, where the callee comes from, and whether anything forces them to agree.
The same question applies to generated files — `.claude/agents/*.md` are generated from
`agents/*.toml`, so editing the generated copy is a change that silently disappears
on the next sync.

## 2d. What actually runs is a list someone maintains, not everything you wrote

Adding a file does not add it to CI. `consent-protocol/scripts/test-ci.manifest.txt` is a
**curated allow-list** — its own header says *"Keep this list small and stable"* — so a new
test file passes locally, passes under your own `pytest` invocation, and never runs in CI at
all. The gate still goes green, because it ran the same files it ran yesterday.

This produced the worst kind of false claim made in this repo, and it recurred three times
in a single session:

> *"Verified: 14 new tests pass, protocol-check.sh exit 0 with 712 tests total."*

Both halves are true. The conjunction is false, and false in exactly the direction a reader
will take it — it invites the conclusion that the 14 are among the 712. They were not. The
file was never in the manifest, so the second number was measured on a suite that had never
seen the first.

**The signal that caught it was the number that did not move.** 712 before, 712 after. Any
time you add tests, checks, routes, or fixtures, the total is a free assertion: predict the
delta *before* running the gate, and treat a count that stayed still as a finding to
investigate rather than a suite that happens to be stable. (Registering the five files this
session added moved it 712 → 794 — that delta is the evidence, not the exit code.)

Generalise past this one file. Ask of any gate: **does it discover its work, or is it handed
a list?** Enumerated inclusion hides in manifests, allow-lists, `include:` globs, workflow
`paths:` filters, suite indexes, and route registries. Every one of them fails the same
silent way — by succeeding.

## 3. Read the real code before you design

Design decisions made from assumption get thrown away.

- Reading the actual consent write path revealed it used the Supabase client while the
  proven receipt-chain used asyncpg — **they cannot share a transaction.** That single
  fact changed the whole design from "atomic in-row chain" to "fail-safe mirror," and
  it was invisible from the outside.
- Reading `migrate.py` proved it resolves migrations from the manifest, not a directory
  scan — which made relocating parked migrations provably safe rather than hopeful.

**Know what crosses a serialization boundary.** IndexedDB structured-clones what you
store, so a value read back is never the object you wrote — a `toBe` identity assertion
there tests the boundary, not your code, and tells you nothing either way. The same holds
for JSON round-trips, ORM hydration, and anything that survives a process restart. Assert
on the *behaviour* or the *stored bytes*, not on object identity.

**Before writing code:** find the thing you're extending, read it, and read one
existing example of the pattern you're about to follow.

## 4. Smallest correct change — and understand the mechanism

- Prefer the change that makes the gate *correct* over the change that makes it *quiet*.
- When two conventions conflict, say so out loud instead of picking one silently. The
  parked-migration band and the manifest-head gate were mutually exclusive; that
  conflict — not any bug — is why the branch was red for two weeks.
- Reuse a proven primitive rather than inventing a second one. The consent-audit chain
  is deliberately the same construction as the fabric receipt ledger.

## 5. Never suppress a control to go faster

This is the line that does not move.

- **Annotate false positives with a reason**, using the repo's existing convention, and
  say why it is not a secret. Never blanket-ignore.
- **Never fabricate a human attestation.** A DCO `Signed-off-by` is a legal statement
  that a named human has the right to submit the work. Sign as the authenticated
  connected identity per the SOP — never invent a name to clear a gate.
- If a gate blocks you and you believe the gate is wrong, **escalate it as a question**;
  do not edit the gate to pass.
- A gate that refuses is often correct. Production refused an artifact that had not
  been through UAT. Dev refused a deploy into a misconfigured environment. Both were
  the system working.

## 6. Ship dark

Every meaningful control lands behind a kill-switch that defaults to **off**.

- The flag reads off when **unset**, so a half-configured environment is safe.
- Test **both** branches — including the guarantee that flag-off behavior is unchanged.
- Additive controls must be **fail-safe**: the audit mirror can never break the write
  it mirrors.
- Write the unfinished edge into the **file**, not the wiki. The limitation you document
  is a gift; the one you hide is a trap.
- Dark is a staging state, not a destination — every flag needs a named condition for
  turning it on.

## 7. Say the true thing, including about yourself

- **Correct your own errors promptly and plainly.** "Production is live" was wrong;
  saying so immediately mattered more than looking consistent.
- **Distinguish pre-existing from newly-introduced.** Always check whether a failure is
  yours — compare against a control (an untouched file, an existing page, `main`).
- **Two true sentences can compose into a false claim.** *"The new tests pass"* and *"the
  gate is green with 712 tests"* were each accurate; placed side by side they asserted a
  link — that the new tests were in the 712 — which had not been verified and was not true.
  Before reporting two facts together, ask what a reader will infer from the pair. If you
  verified the link, say it explicitly; if you did not, say that instead. This is the
  easiest way to mislead while believing you are being precise.
- **Flag structural changes before making them**, not after. Merging to `main` to reach
  production was necessary and instructed, but it broke a stated invariant and should
  have been surfaced in the moment.
- **Encode honesty in the code, not the marketing.** `AAL3-candidate` is a technical
  decision that makes over-claiming a compile-time impossibility.
- **Withhold what genuinely should be withheld.** Publishing exactly which components
  are unpatched is a map for an attacker, not transparency.

## 8. Close the loop on process, not just the bug

The most valuable finding of the last two weeks was not any single defect — it was that
**nobody noticed a branch was red for two weeks.** When you fix something, ask what
would have caught it earlier, and whether that signal exists.

---

## Fast pre-flight

Run before reporting any coding work complete:

```
[ ] I read the code I changed, and one example of the pattern I followed
[ ] The file I edited is hand-authored, not generated from another source
[ ] Any failure label I am repeating, I traced to the code that emits it
[ ] The gate I might trip, I reproduced locally at the CI-pinned version
[ ] Tests pass — and I know which ones actually exercise my change
[ ] New tests/checks are registered wherever CI enumerates them, and the total count moved
[ ] CI is green on the exact pushed SHA (not "should be")
[ ] Flag-off behavior is unchanged, and I tested that specifically
[ ] Limitations are written in the file, in plain language
[ ] Nothing I did suppresses a control or fabricates an attestation
[ ] Anything structural or invariant-breaking is stated out loud
[ ] Claims in my report are things I verified, not things I expect
```
