# Switching on Google Contacts for web contact sync

The code shipped **dark**. `googleContactsAvailability()` returns `"unconfigured"`
whenever `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` is empty, which it is in every
environment — so web, iOS and Android behave exactly as they did before. This
file is the rest of the work, and none of it is code.

Everything below needs GCP permissions that an ordinary developer credential does
not carry. Verified 2026-08-24 with `testIamPermissions` against both
`hushh-pda` and `hushh-pda-uat`: a normal member account holds
`resourcemanager.projects.get` and nothing else on this path — no
`serviceusage.services.enable`, no `secretmanager.secrets.create`, no
`secretmanager.versions.add`, not even `secretmanager.versions.access`. Secret
*names* list fine, which reads like access and is not. Run these as a member of
`gcp-admins@hushh.ai`.

## Order matters, and getting it wrong breaks every frontend deploy

Step 3 creates the secret. Step 4 makes `frontend.cloudbuild.yaml` reference it.
Cloud Build resolves every `availableSecrets` entry before the build starts, so a
reference to a secret that does not exist yet fails the build — in all three
environments, on every branch, whether or not it touches contacts. **Do not merge
the step 4 diff until step 3 has run in all three projects.**

This is the same ordering rule as R1 in the `safe-changes` skill, in its
build-time form.

---

## Step 1 — Read the consent screen before changing anything

The UAT backend env file on the deploy host carries a **localhost** OAuth
callback, in a deployed environment. That is what a consent screen still in
*Testing* looks like. (The file is untracked by design, so this is a thing to go
and read, not a line to cite.)

If it is in Testing, then today **no Google scope reaches a real user** — Gmail
included — and only allowlisted test accounts work. Turning contacts on does not
change that. But publishing the screen, whenever that happens, means a first
production submission that necessarily includes the restricted `gmail.readonly`
scope and its CASA assessment. Contacts did not create that debt; it is simply
the feature that makes you look at it.

Dogfooding is not blocked either way. Add the tester accounts and the flow works.

```
https://console.cloud.google.com/apis/credentials/consent?project=hushh-pda
```

Read it. Do not publish it as part of this change.

## Step 2 — Enable the People API

Per project, all three:

```bash
for p in hushh-pda hushh-pda-uat hushh-pda-dev; do
  gcloud services enable people.googleapis.com --project="$p"
done

# prove it
for p in hushh-pda hushh-pda-uat hushh-pda-dev; do
  printf '%-16s ' "$p"
  gcloud services list --enabled --project="$p" \
    --filter="config.name=people.googleapis.com" --format='value(config.name)'
done
```

Three lines of `people.googleapis.com`, or the browser gets a 403 that looks
exactly like a consent failure.

## Step 3 — A dedicated browser OAuth client, then the secret

**Create a new Web application client. Do not add JavaScript origins to the Gmail
client.** Same Cloud project, so it inherits the already-configured consent screen
and starts no new verification — but a separate client id, so a mistake in the
contacts origins cannot reach the client Gmail and Calendar authenticate through.
That client is listed in the `safe-changes` shared-credential table for a reason.

Console → Credentials → Create credentials → OAuth client ID → **Web application**.

Authorized JavaScript origins — origins only, no paths, no trailing slash:

```
https://one.hushh.ai
https://uat.one.hushh.ai
https://dev.one.hushh.ai
http://localhost:3000
```

No redirect URIs. The Google Identity Services token flow does not use one.

Native is deliberately absent. `capacitor.config.ts` sets `iosScheme: "App"`, so
the iOS shell origin is `App://localhost`; Google will not accept a non-https
custom scheme, and native already has the real address book through the
first-party plugin. `googleContactsAvailability()` returns `"unconfigured"` on
native unconditionally, so nothing there ever asks.

Then create the secret — same value in all three projects, because a client id is
public and ships inside browser JavaScript:

```bash
CLIENT_ID='<the new client id>.apps.googleusercontent.com'

for p in hushh-pda hushh-pda-uat hushh-pda-dev; do
  gcloud secrets create NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID \
    --project="$p" --replication-policy=automatic 2>/dev/null || true
  printf '%s' "$CLIENT_ID" | gcloud secrets versions add \
    NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID --project="$p" --data-file=-
done
```

`printf` rather than `echo`: a trailing newline inside the secret becomes a
trailing newline in the client id, and Google rejects it with a message that
never mentions whitespace.

Verify all three before going near step 4:

```bash
for p in hushh-pda hushh-pda-uat hushh-pda-dev; do
  printf '%-16s ' "$p"
  gcloud secrets versions access latest \
    --secret=NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID --project="$p" | tail -c 30
  echo
done
```

No IAM grant is needed here. `roles/secretmanager.secretAccessor` is held at
project level in each project, so a new secret is readable by that project's
runtimes the moment it exists. That is only true because all three copies are
same-project — a cross-project reference would need an explicit per-secret grant
and would fail silently without one.

## Step 4 — The build plumbing

Only after step 3 shows a value in all three.

`deploy/frontend.cloudbuild.yaml`, three edits:

```yaml
# 1. in the docker build args, beside the other NEXT_PUBLIC_GOOGLE_* lines
          --build-arg NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=$$NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_VAL \

# 2. in that step's secretEnv list
      "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_VAL",

# 3. in availableSecrets
    - versionName: projects/$PROJECT_ID/secrets/NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID/versions/latest
      env: "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID_VAL"
```

**Do not add it to `required_vars`.** That list hard-fails the build on an empty
value. Contacts is a fallback that is allowed to be off, and the two Maps keys
are already precedent for a `NEXT_PUBLIC_` value that is wired but not required.

`hushh-webapp/Dockerfile`, beside the other `NEXT_PUBLIC_GOOGLE_*` pair:

```dockerfile
ARG NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
ENV NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
```

Both lines are needed. `ARG` alone reaches the build and not the bundle: Next.js
reads `process.env` at build time, so without the `ENV` line the value is
silently empty and the feature stays dark with no error anywhere.

Finally add the name to `scripts/ops/verify-env-secrets-parity.py`, so a project
missing the secret is a CI failure rather than one environment where the button
quietly does nothing.

## Step 5 — Prove it end to end

```bash
python3 scripts/ops/verify-env-secrets-parity.py --project hushh-pda-uat
```

Then in a **desktop** browser on `https://uat.one.hushh.ai` — desktop
specifically, because that is the surface with no Contact Picker at all and
therefore the only one where this path is reachable:

1. Open the contacts step. The Google fallback offers itself.
2. The consent sheet appears, scoped to `contacts.readonly` and nothing else.
3. Matches come back; DevTools → Network shows `people.googleapis.com` called
   **from the browser**, and no request to our API carrying a phone number.

That last check is the whole design. If a People API call ever shows up in
backend logs, `consent-protocol/tests/test_contacts_never_reach_the_server.py`
should have failed the build first — treat that as a bug in the test rather than
a tolerable shortcut.

## What stays unverified

Steps 1 and 3 are console actions with no read-back that proves *intent*. The
origins list can be correct while the consent screen is still in Testing, and
nothing in CI can tell those apart. The end-to-end check in step 5 on a real
desktop browser is the only thing that closes the gap, and it cannot be
automated — the consent sheet needs a human.
