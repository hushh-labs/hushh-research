# Broker Execution Future State


## Visual Context

Canonical visual owner: [Agent Kai — Your Explainable Investing Copilot](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Planned architecture for moving from read-only brokerage connectivity to broker-backed execution without rewriting Kai’s portfolio model.

## Current Boundary

- Kai can connect to brokerages through Plaid
- Kai can read holdings and investment transactions
- Kai can refresh, compare, debate, and optimize
- Kai cannot place trades

## Future Execution Goals

- broker-agnostic execution contract
- explicit investor approval before order submission
- audit trail for every approval and order state transition
- post-trade reconciliation back into Kai context

## Reserved Core Objects

- `BrokerConnection`
- `ExecutionBroker`
- `ExecutionAccount`
- `OrderIntent`
- `OrderPreview`
- `ExecutionApproval`
- `ExecutionOrder`
- `ExecutionStatus`

## Policy Invariants

- execution consent is separate from read consent
- approval must be explicit by default
- no silent auto-trading from Debate or Optimize
- Renaissance and debate outputs can inform `OrderIntent`, not directly trigger live orders
- live order placement requires broker suitability and account-level validation

## Planned Phases

### Phase A

- order-intent generation
- preview-only execution contract
- no broker submission

### Phase B

- paper trading / simulated fills
- broker adapter scaffolding

### Phase C

- live broker adapters
- approval UX
- audit + reconciliation

## Relationship To Plaid

Plaid stays a connectivity and portfolio-context source.
It is not the execution layer and should not be modeled as one.
