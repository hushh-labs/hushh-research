# Developer Access Matrix


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This is the current access model for `developers@hushh.ai` in the `hush1one.com` organization.

## Org-level inherited roles

The developers group inherits this baseline across all projects:

- `roles/browser`
- `roles/logging.viewer`
- `roles/monitoring.viewer`
- `roles/serviceusage.serviceUsageAdmin`
- `roles/serviceusage.serviceUsageConsumer`
- `roles/serviceusage.apiKeysAdmin`
- `roles/oauthconfig.editor`
- `roles/iam.serviceAccountViewer`
- `roles/iam.serviceAccountUser`
- `roles/cloudbuild.builds.editor`
- `roles/artifactregistry.admin`
- `roles/aiplatform.user`
- `roles/run.admin`
- `roles/cloudsql.viewer`
- `roles/cloudsql.instanceUser`
- `roles/cloudsql.studioUser`
- `roles/cloudsql.client`
- `roles/storage.objectAdmin`

Notes:

- New projects inherit the same developer baseline automatically.
- There should be no normal project-level IAM bindings for `developers@hushh.ai` unless a project needs an explicit exception.

## Explicitly blocked from the shared developers group

These remain outside the shared developers group:

- `roles/secretmanager.secretAccessor`
- `roles/iam.serviceAccountTokenCreator`
- `roles/iam.serviceAccountAdmin`
- `roles/iam.serviceAccountKeyAdmin`
- `roles/resourcemanager.projectIamAdmin`
- `roles/resourcemanager.organizationAdmin`
- `roles/orgpolicy.policyAdmin`
- `roles/billing.admin`
- `roles/editor`
- `roles/owner`

## Runtime identities

Cloud Run app services no longer use the default compute service account.

### Production

- `consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com`
  - `roles/secretmanager.secretAccessor`
  - `roles/aiplatform.user`
- `hushh-webapp-runtime@hushh-pda.iam.gserviceaccount.com`
  - `roles/secretmanager.secretAccessor`

### UAT

- `consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com`
  - `roles/secretmanager.secretAccessor`
  - `roles/aiplatform.user`
  - `roles/cloudsql.client`
- `hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com`
  - `roles/secretmanager.secretAccessor`

Deployment identities that need to attach these service accounts have `roles/iam.serviceAccountUser` on the runtime identities:

- `1006304528804-compute@developer.gserviceaccount.com`
- `745506018753-compute@developer.gserviceaccount.com`
- `github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com`

Scheduler, backup, and Firebase admin service accounts remain separate from runtime identities.

## Cloud SQL Studio and DB access path

Cloud SQL IAM auth is enabled on:

- `hushh-pda:us-central1:hushh-vault-db`
- `hushh-pda-uat:us-central1:hushh-uat-pg`

The developers group is added to both instances as:

- `developers@hushh.ai`
- user type: `CLOUD_IAM_GROUP`
- database role: `cloudsqlsuperuser`

This is the current developer DB access path for Cloud SQL Studio and IAM-based login.

## Operating rules

- Prefer org-level IAM for the shared developers group.
- Prefer dedicated runtime service accounts over the default compute service account.
- Keep project-level bindings only for runtime identities and true exceptions.
- If a new app service is created, create a dedicated runtime service account first and attach it before rollout.
