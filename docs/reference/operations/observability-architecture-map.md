# Observability Architecture Map

## Visual Map

```mermaid
flowchart LR
  subgraph identity["Identity Plane"]
    auth["Firebase Identity Plane<br/>single web config"]
  end

  subgraph analytics["Analytics Plane"]
    web["Web Runtime<br/>measurement ID / gtag"]
    native["Native Runtime<br/>Firebase Analytics app stream"]
    prodga["GA4 Prod Property<br/>526603671"]
    uatga["GA4 UAT Property<br/>533362555"]
  end

  subgraph reporting["Reporting Plane"]
    bqprod["BigQuery Export<br/>analytics_526603671"]
    bquat["BigQuery Export<br/>analytics_533362555"]
    dashboard["Looker Studio Dashboard<br/>approved BigQuery views"]
  end

  auth --> web
  auth --> native
  web --> prodga
  web --> uatga
  native --> prodga
  native --> uatga
  prodga --> bqprod
  uatga --> bquat
  bqprod --> dashboard
```

Use this as the canonical map for Kai observability decisions. The system is split into three planes:

1. identity plane
2. analytics collection plane
3. reporting plane

Shared auth is allowed. Shared analytics is not.

## Collection Flow

```mermaid
flowchart TD
  ui["Kai web or native surface"]
  emitter["Observability contract<br/>metadata-only events"]
  webga["gtag + dataLayer (optional GTM)"]
  nativega["Firebase Analytics plugin"]
  property["GA4 property per environment"]
  export["BigQuery export link"]
  sql["Modeled SQL views / queries"]
  growth["Growth dashboard"]

  ui --> emitter
  emitter --> webga
  emitter --> nativega
  webga --> property
  nativega --> property
  property --> export
  export --> sql
  sql --> growth
```

Rules:

1. Web tagging must not depend on GTM presence.
2. Native tagging must use the Firebase-linked app stream.
3. Dashboards must use modeled queries, not inferred GA cards.
4. `event_category` is added centrally as `funnel`, `feature`, or `system`.

## Environment Split

```mermaid
flowchart TB
  prod["Production Property<br/>526603671"]
  prodweb["Web stream<br/>13695004816<br/>G-2PCECPSKCR"]
  prodios["iOS stream<br/>13695001361"]
  prodandroid["Android stream<br/>13694989021"]
  voice["HushhVoice iOS<br/>13702689760<br/>excluded"]
  uat["UAT Property<br/>533362555"]
  uatweb["Web stream<br/>14383500973<br/>G-H1KGXGZTCF"]
  uatios["iOS stream<br/>14383415557"]
  uatandroid["Android stream<br/>14383555179"]

  prod --> prodweb
  prod --> prodios
  prod --> prodandroid
  prod --> voice
  uat --> uatweb
  uat --> uatios
  uat --> uatandroid
```

Environment policy:

1. Production is the only canonical business-reporting surface.
2. UAT is a validation-only analytics lane.
3. `HushhVoice` remains on the production property for now, but Kai reporting excludes it.
4. Current iOS and Android store builds are production-facing; UAT native validation requires TestFlight/internal-track or dev-device debug builds.

## Identity vs Sink

```mermaid
flowchart LR
  uatuser["UAT session"]
  auth["Firebase identity plane<br/>single web config"]
  webcfg["UAT web config<br/>G-H1KGXGZTCF"]
  nativecfg["UAT native Firebase app IDs"]
  uatga["UAT GA4 property<br/>533362555"]
  prodga["Prod GA4 property<br/>526603671"]

  uatuser --> auth
  uatuser --> webcfg
  uatuser --> nativecfg
  webcfg --> uatga
  nativecfg --> uatga
  auth -. does not choose sink .-> prodga
```

The Firebase identity plane is not the analytics sink.

Sink selection happens here:

1. web: measurement ID chosen at runtime/build time
2. native: Firebase app configuration compiled into the app

Required verification:

1. UAT HTML resolves the UAT measurement ID.
2. UAT native builds map to UAT app streams.
3. UAT DebugView sees UAT validation traffic.
4. Production DebugView does not receive the same UAT validation session.
5. Production dashboard SQL reads only from the production export dataset.

## Canonical Event Hierarchy

The dashboard contract is built around:

1. `growth_funnel_step_completed`
2. `investor_activation_completed`
3. `ria_activation_completed`

Supporting observability events exist for:

1. page views and navigation
2. auth lifecycle
3. onboarding and import lifecycle
4. API request health
5. consent/account/Gmail operations
6. RIA status and workspace lifecycle

Governed high-intent feature events:

1. `market_insights_loaded`
2. `portfolio_viewed`
3. `recommendation_viewed`
4. `marketplace_profile_viewed`

See:

- [observability-event-matrix.md](./observability-event-matrix.md)
- [analytics-verification-contract.md](../quality/analytics-verification-contract.md)

## Reporting and Verification Rules

1. Production dashboards read only from `analytics_526603671`.
2. UAT queries read only from `analytics_533362555`, and only for validation.
3. BigQuery export presence is not enough; dataset and event-table materialization must be verified.
4. GA DebugView and Firebase DebugView are validation tools, not the canonical reporting surface.
5. If a KPI can only be explained from raw GA cards and not from modeled SQL, the KPI is not governed well enough yet.
