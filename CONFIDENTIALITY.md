# Confidentiality

Hushh runs an asset-management business. In that business, the ideas are the
product. This is the one rule everyone — human or agent — follows in every
Hushh repository before touching anything about the fund.

## The rule

**Talk about the strategy in the open. Never publish how we run it.**

*Open, at the level of a conference talk:* we own great businesses permanently,
sell premium at extremes, keep 22% in Treasuries, and show the 27 names
proudly. The philosophy — Buffett, Munger, Simons, Musk, the respects, the
Iron Rules stated as principles.

*Never open — private repository only, and gated inside it:*

- Portfolio weights, target allocations, and the math that produces them.
- Signal definitions with their parameters: thresholds, look-backs, gates.
- Ladder and execution mechanics with numbers: strikes, expirations,
  coverage caps, DTE windows, rebuild timelines.
- Simulation, backtest, and paper-trading results: returns, drawdowns, P&L.
- Broker, custodian, vendor, counterparty, and fee terms.
- Investor material: the data room, PPM, LP lists.
- Keys, tokens, signing secrets. Anywhere. Ever.

Not sure which side something is on? It is on the private side.

## In practice

1. **A repository holding anything on that list is private.** No exceptions,
   no "temporarily", no "it's only a branch".
2. **Every such repository runs the visibility guard**
   (`.github/workflows/visibility-guard.yml`). It fails every run — and once a
   day on its own — the moment the repository is public.
3. **Public repositories reference the fund only at the open level.** Link to
   the private repository; never copy from it.
4. **Before any Hushh repository goes public**, run the checklist and get the
   GP's written sign-off in the pull request.

Checklist:

- [ ] Nothing under `config/`, `dataroom/`, `state/`, `reports/`, `sim/`.
- [ ] The full history searched, not just the tip. A deleted file is still a
      published file.
- [ ] The visibility guard is absent. A repository that needs it cannot go
      public.
- [ ] GP sign-off linked.

## If it happens anyway

Speed, then honesty, then the fix.

1. **Make it private now.** Settings → Danger Zone → Change visibility.
   Investigate after, not before.
2. **Record the window.** Organization owners: Settings → Audit log, action
   `repo.access`. When it went public, when it was closed.
3. **Measure the exposure.** Forks, stars, watchers, Wayback snapshots.
   Forks made while public survive the change — ask their owners to delete.
4. **Rotate what rotates.** Any credential that was ever in the tree. Weights
   and parameters are the GP's call — log the decision either way.
5. **Write it down** in `docs/incidents/`: what, when, how long, what leaked,
   what was done. Dates, not adjectives.
6. **Fix the cause.** If the mistake was possible, add the guard that makes
   it impossible.

## For the organization owners, once

The rule above is convention plus one workflow. What makes it structural is
three settings in the organization, not in any repository:

- Member privileges → Repository creation: **private only**.
- Member privileges → Repository visibility change: **owners only**.
- Member privileges → Repository forking: **off** for private repositories.

After that, this mistake needs an owner to make it.
