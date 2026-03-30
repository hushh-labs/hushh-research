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

Public cards must not include private portfolio or sensitive personal fields.

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
