# Kai Observability Property, Stream, and Dataset Matrix

Use this reference when the task depends on the current live GA4/Firebase/BigQuery topology.

## Production

- GA4 property: `526603671`
- label: `hushh-pda`
- reporting role: canonical business-reporting surface
- web measurement ID: `G-2PCECPSKCR`

Streams:

| Surface | Stream ID | Firebase / web identifier | Reporting note |
| --- | --- | --- | --- |
| Android | `13694989021` | `1:1006304528804:android:e38e29d91ba817aecfd931` | include |
| iOS | `13695001361` | `1:1006304528804:ios:eb2720b5eda7da4bcfd931` | include |
| Web | `13695004816` | `G-2PCECPSKCR` / `1:1006304528804:web:d2479c8817799a28cfd931` | include |
| HushhVoice iOS | `13702689760` | `1:1006304528804:ios:fc1e5fd477d3f757cfd931` | exclude from Kai growth models and excluded from current BigQuery export streams |

GA4 configuration:

- custom key events:
  - `investor_activation_completed`
  - `ria_activation_completed`
- event-scoped custom dimensions:
  - `journey`
  - `step`
  - `entry_surface`
  - `auth_method`
  - `portfolio_source`
  - `workspace_source`
  - `env`
  - `platform`
  - `event_category`
  - `app_version`

BigQuery:

- link present: yes
- project: `hushh-pda`
- dataset when materialized: `analytics_526603671`
- current operator check: verify the dataset and event tables actually appear before dashboard cutover

## UAT

- GA4 property: `533362555`
- label: `hushh-pda-uat`
- reporting role: validation-only analytics lane
- web measurement ID: `G-H1KGXGZTCF`

Streams:

| Surface | Stream ID | Firebase / web identifier | Reporting note |
| --- | --- | --- | --- |
| iOS | `14383415557` | `1:745506018753:ios:efea0fede200b1d1778b40` | validation only |
| Web | `14383500973` | `G-H1KGXGZTCF` / `1:745506018753:web:9d0c1d3da8767c32778b40` | validation only |
| Android | `14383555179` | `1:745506018753:android:7d6bed4640373c95778b40` | validation only |

Native UAT release note:

- UAT native streams exist for topology readiness.
- There are currently no separate iOS or Android UAT app-store builds.
- Current store-distributed native builds are production analytics surfaces.
- Native UAT validation requires a future TestFlight/internal-track or dev-device debug build.

GA4 configuration:

- custom key events:
  - `investor_activation_completed`
  - `ria_activation_completed`
- event-scoped custom dimensions:
  - `journey`
  - `step`
  - `entry_surface`
  - `auth_method`
  - `portfolio_source`
  - `workspace_source`
  - `env`
  - `platform`
  - `event_category`
  - `app_version`

BigQuery:

- link present: yes
- project: `hushh-pda-uat`
- dataset when materialized: `analytics_533362555`
- current operator check: treat UAT export as validation-only, not as the canonical dashboard source

## Shared-Auth Nuance

UAT may authenticate against the shared auth plane through `NEXT_PUBLIC_AUTH_FIREBASE_*`, but analytics sink selection still comes from:

1. web measurement ID resolution
2. native Firebase app-stream mapping

That means:

- shared auth does not justify merging UAT analytics into production
- shared auth also does not imply UAT traffic should appear in the production property

## Verification reminders

1. Use GA Admin API for property, stream, key-event, custom-dimension, and BigQuery-link inspection.
2. Use `bq ls -a` plus table checks to confirm export materialization.
3. Do not trust dashboard cutover until both property-side and project-side checks agree.
