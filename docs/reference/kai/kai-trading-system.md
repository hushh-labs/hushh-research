# Kai Trading System

Canonical reference for the Trading specialist that runs strategy research,
backtesting, paper trading, and per-order-approved live execution under Kai.

## North Star and the 69.69% IRR

The system's stated North Star is a sustained internal rate of return at or
above 69.69%. This is treated as an **optimization target**, not a guarantee.

Why this matters:

- The only widely-cited fund that has sustained returns near this level is
  Renaissance Medallion (~66% gross), and it is closed to outside capital.
- Every realized-IRR surface in this system reports the actual number
  alongside Sharpe, Sortino, Calmar, max drawdown, and turnover.
- UI copy, MCP tool descriptions, and audit-log entries must NOT imply the
  target is a guarantee. PR review rejects copy that does.

The optimizer maximizes risk-adjusted return (default: Sortino on out-of-sample
walk-forward folds). The 69.69% line is rendered as a reference threshold on
equity-curve charts, never as a contract.

## Capability Boundary

In scope:

- Strategy library: momentum, mean reversion, trend, Renaissance-tier overlay,
  risk-parity allocator, position sizing (Kelly cap, vol targeting).
- Backtest harness: walk-forward + purged k-fold CV, deterministic clock,
  cost model with slippage and commission.
- Paper-trading loop: live market data, simulated fills, position book in PKM.
- Execution scaffold: `OrderIntent` → `OrderPreview` → `ExecutionApproval` →
  `ExecutionOrder` → `ExecutionStatus`, with `MockExecutionBroker` for tests.
- Live broker adapter (Alpaca Trading API), behind paper-graduation gate.
- Risk + governance: circuit breakers, kill switch, audit log.

Out of scope:

- Auto-trade from debate or optimize. Only the Trading specialist emits
  `OrderIntent`s, and only via the per-order approval flow.
- Strategies that depend on inside information, customer order flow, or any
  other input the user did not consent to share.
- Any path that bypasses the eight binding rules in
  `kai-brokerage-connectivity-architecture.md` → "Permissioned Execution Rules".

## Milestone Gate Order

Each milestone is independently shippable. Live broker code MUST NOT merge
until M0 is approved.

- **M0** Charter, scopes, manifest, doc updates.
- **M1** Market data plane (OHLCV, corporate actions, cache).
- **M2** Strategy library + position sizing.
- **M3** Backtest harness with deterministic equity curves.
- **M4** Paper-trading service + position book.
- **M5** Execution scaffold with `MockExecutionBroker`.
- **M6** Live Alpaca Trading API adapter — only enabled after seven days of
  paper parity reconcile against Plaid holdings inside tolerance.
- **M7** Frontend Trading tab in the Kai dashboard.
- **M8** Risk + governance + kill switch.
- **M9** API routes + MCP tool registration.

## Kill Switch

`KAI_TRADING_MODE` env var, three values:

- `paper` — every `ExecutionBroker.submit` is routed to `MockExecutionBroker`.
  The live broker adapter is never instantiated.
- `live` — real orders flow, subject to all binding rules.
- `halt` — every submit is rejected. In-flight `ExecutionOrder`s are cancelled
  best-effort against the broker. The trading specialist refuses to emit new
  `OrderIntent`s until the env var is changed.

A drawdown-driven auto-halt flips `live → halt` when 30-day rolling drawdown
exceeds 10%. Recovery from `halt` requires manual operator action.

## Risk Limits (defaults)

Configurable per user; defaults below are conservative.

| Limit | Default |
|---|---|
| Daily loss circuit breaker | -2% NAV |
| Max gross leverage | 1.0x |
| Max net leverage | 1.0x |
| Per-name cap | 5% NAV |
| Sector cap | 25% NAV |
| Single-day turnover cap | 100% NAV |
| Auto-halt drawdown | 10% rolling 30d |
| Stale-data window | 60s |

Any breached limit fails closed at submit time. The breach reason is logged
to `kai_execution_audit` and surfaced in the approval modal.

## PKM Keys

- `financial.trading.strategies.<id>` — strategy config + parameters
- `financial.analytics.backtests.<run_id>` — backtest results
- `financial.trading.paper.<strategy_id>.book` — paper position book
- `financial.trading.live.book` — live position book (separate source-of-truth)

## Compliance Disclaimers

Every approval modal carries the disclaimer:

> Past performance does not predict future results. The 69.69% IRR target is
> a research goal, not a guarantee. Trades you approve are your decision; the
> Trading specialist is a tool, not a fiduciary. Live orders are placed only
> after you click-to-sign each preview.

The `not_investment_advice: True` flag on Kai's manifest remains set.

## Related Docs

- `kai-brokerage-connectivity-architecture.md` — binding execution rules
- Future: `kai-trading-strategy-catalog.md` — per-strategy mathematical specs
- Future: `kai-trading-runbook.md` — operator runbook, kill-switch drills
