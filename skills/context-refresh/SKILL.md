---
name: context-refresh
description: Rebuild an accurate 0-to-1 picture of a workstream after time away — what was built, what is actually deployed right now, what is blocked, and what decisions are already settled. Use when returning to a branch after hours or days, when asked to "catch me up", "refresh my context", "where were we", "what's the status", "recap this thread", or before resuming work whose state you are reconstructing from memory rather than evidence. Also use before any status report to a founder, board, or team, because a briefing assembled from recollection is the highest-consequence place to be confidently wrong.
allowed-tools: Read Grep Glob Bash
---

# Context refresh

Apply the repo-wide Principal Craft Kernel and Bacterial Software Architecture Gate from
`AGENTS.md`; this skill adds context-recovery discipline, not authority to weaken
correctness, security, or verification.

This is `verify-before-claim` (`skills/verify-before-claim/SKILL.md`) pointed at a different
target. There, the risk is claiming a change works. Here, the risk is claiming you know
where things stand. Both fail the same way: a confident report assembled from memory.

**The rule: reconstruct state from the live system, not from the conversation.**

Anything the conversation told you was true was true *then*. Time has passed. `main` has
moved, deployments have been overwritten, PRs have gone stale, someone else has shipped.
A recap that replays the transcript is a recording, not a status report.

---

## The refresh sequence

Run these in order. Each one can invalidate your assumptions from the previous step, and
the cheapest checks come first.

### 1. Establish real time and real position

```bash
date -u '+%Y-%m-%d %H:%M UTC'
git fetch origin main --quiet
git log -1 --format='%h %ad %s' --date=short          # what is actually at HEAD
git rev-list --count HEAD..origin/main                # how far behind
git rev-list --count origin/main..HEAD                # how far ahead
git status --short                                    # uncommitted work
```

**Never state elapsed time from the conversation.** If the user says "it's been 3 days",
check — it may be five. Report the real interval; it changes how stale everything else is.

Divergence is the single most decision-relevant number after an absence. A branch that was
current when you left may be hundreds of commits behind, which silently converts "ready to
merge" into "needs a sync and conflict resolution first."

### 2. Verify what is actually deployed — never infer it

Deployment is the fact most likely to have changed while you were away, and the one people
most often report from memory.

- Probe the **live endpoints**. Assert on response *content*, not just status. A `200` that
  says "not found" is a soft failure that looks identical to health.
- Check the **deployment history**, not just the current state: who deployed last, when, and
  what SHA. In a shared environment, someone else has probably deployed over you.
- Where a feature is meant to be dark, **confirm it is still dark**. A flag-gated route
  returning `404` is a positive result and worth stating as one.

Distinguish three separate claims that get conflated:

| Claim | What proves it |
|---|---|
| The code exists | It is committed on the branch |
| The code is deployed | A deploy run succeeded **and** the live service serves it |
| The feature works | A code path executed and produced the expected effect |

Most post-absence briefings quietly promote the first into the third. Say which one you
actually have.

### 3. Reconstruct the arc from commits, not recollection

```bash
git log origin/main..HEAD --format='%h %ad %s' --date=short   # what this branch adds
git diff origin/main...HEAD --shortstat                        # scale of the change
```

Commit messages written at the time are more reliable than a summary written now. Read them.
Where this repo's practice has been followed they carry the reasoning, not just the change.

### 4. Check the open surfaces

Pull requests, CI status on the **current** head, and any background or scheduled work that
may have completed or failed while you were gone. CI green on a SHA from last week says
nothing about the SHA at HEAD today.

### 5. Separate settled decisions from open questions

Decisions the user already made are the most valuable thing to surface, because
re-litigating them wastes the session and irritates the person who made them. Pull them out
explicitly: constraints they set, options they rejected, and the reasoning where it was
given.

Then state, separately, what is genuinely still open — and do not disguise an open question
as a settled one to make the recap feel tidier.

---

## Shape of a good refresh

Lead with orientation, then evidence, then direction:

1. **Where things stand** — a short paragraph someone could act on immediately.
2. **What changed while you were away** — often the single most useful section, and the one
   a transcript replay cannot produce.
3. **Deployment status** — live-verified, with the environments that were deliberately left
   untouched named explicitly.
4. **The arc** — why each piece exists, in the order it happened, since sequence usually
   carries the reasoning.
5. **Hard numbers** — tests, diff scale, divergence, coverage gaps.
6. **Settled decisions** — so they are not reopened.
7. **Where to pick up** — including the first blocker, named plainly.

Match the medium to the volume. A few facts belong in the reply. A genuine 0-to-1 rebuild
across many surfaces is easier to absorb as a structured document than as prose.

## Failure modes this exists to prevent

- **Replaying the transcript.** The conversation is a record of the past, not a description
  of the present.
- **Reporting stale deployment state.** "It's deployed" was true five days ago; check.
- **Silent staleness.** Divergence from the trunk does not announce itself. Measure it.
- **Confusing built with working.** See the table in step 2.
- **Burying the blocker.** If something must happen before anything else can, it goes near
  the top, not in a closing list.
- **Tidying away uncertainty.** If a fact could not be verified, say so. An honest gap is
  more useful than a plausible guess, and far cheaper than one acted upon.

## Pre-flight

```
[ ] I fetched the trunk and measured real divergence
[ ] I probed live endpoints and checked response content, not just status
[ ] I checked who deployed last and when, not just what is running
[ ] Elapsed time is measured, not quoted from the conversation
[ ] Every "deployed" or "working" claim maps to evidence I gathered this session
[ ] Settled decisions are listed so they are not reopened
[ ] The first blocker is stated near the top
[ ] Anything I could not verify is labelled as unverified
```
