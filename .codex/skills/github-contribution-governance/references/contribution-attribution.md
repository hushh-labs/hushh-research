# Contribution Attribution

Use this reference for GitHub green-dot, commit author, and maintainer-harvest
credit decisions.

## Identity Gate

1. Confirm active GitHub login.
2. Confirm repo-local Git author name and email.
3. If email is blank, generic, or not associated with the active account, set
   repo-local Git config before committing.
4. Do not expose private verified emails; summarize whether a verified address
   exists.

## Green-Dot Rules

1. A branch push alone is not complete.
2. GitHub counts commits when the author email is associated with the account
   and the commits land on the default branch or `gh-pages`.
3. PRs and issues can also count as contribution events in standalone repos.
4. If older local commits used the wrong email, safe recovery is explicit
   branch-level rebase/amend before merge or a new correctly authored follow-up
   commit.

## Maintainer Harvest Credit

1. Prefer direct contributor PR merge when the head is clean, scoped, green,
   canonical, and safe.
2. Use `Co-authored-by:` only when contributor code or tests are materially
   reused in the actual landing commit.
3. Use public GitHub no-reply identities derived from public user id/login or
   another verified address provided by the contributor.
4. If only the idea or direction is used, record public acknowledgement and
   internal dashboard harvest credit instead of co-authoring.
5. Never rewrite `main` to retrofit co-author credit after merge.
6. If external GitHub credit is explicitly requested after a missed harvest, use
   a transparent follow-up PR with a real, non-empty co-authored harvest replay
   or supplemental patch plus a repo ledger entry.
