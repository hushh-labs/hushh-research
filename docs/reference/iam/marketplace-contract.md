# Marketplace Contract


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Define two-sided discovery and consent-initiation behavior between investors and RIAs.

## Entry Surface

1. Route: `/marketplace`
2. Tabs: `Find RIAs`, `Find Investors`

## Interaction Contract

1. Discovery is allowed using public profile metadata only.
2. Private data is inaccessible before consent approval.
3. In current runtime, consent request creation is RIA -> Investor.

## Public Profile Contract

Public cards may include:

1. display name
2. verification badge/status
3. firm attribution
4. strategy/disclosure summary
5. qualified-deck admission status and curation tier
6. official SEC evidence links for public investor profiles

Public cards must not include private portfolio or sensitive personal fields.

## RIA Investor Deck Contract

The default RIA-facing investor deck is curated, not a raw signed-in user
directory.

1. Public SEC investor rows must have `marketplace_eligible=true`,
   `admission_status=qualified`, curation tier `showcase` or `qualified`, a
   non-empty public summary, CIK, source URLs, and latest official filing
   evidence.
2. Public SEC rows are discovery leads only. They return
   `connectable=false` and actions `shortlist` plus `view_more`.
3. hussh investor users only appear in the default RIA deck when their public
   marketplace metadata explicitly marks them as qualified. Login, investor
   persona, and marketplace opt-in alone are not enough.
4. Qualified hussh investor rows may return `connectable=true` and actions
   `connect` plus `view_more`.

## Relationship Lifecycle

1. `discovered`
2. `request_pending`
3. `approved`
4. `revoked`
5. `expired`
6. `blocked`

## Abuse Controls

1. Auth is mandatory for request creation surfaces.
2. Policy checks enforce actor direction, template allowlist, and duration caps.
3. Verification status gate blocks unverified RIA request creation.

## Observability Contract

Track metadata-only events for:

1. profile view/search
2. request create
3. request approve/deny/revoke
4. conversion and abuse-rate metrics
