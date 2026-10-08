# Physical Reviewer Preflight

Use for normal-session XCUI on an existing signed-in iPhone/iPad. Browser
reviewer bootstrap, device authorization and vault unlock are different gates.
Reuse the existing AppUITests and reviewer identity resolver; do not create
another reviewer store or a privileged app-unlock route.

## Establish admission before private input

1. Record candidate source SHA, built-product identity and selected physical
   destination. A successful compile/install does not prove UI automation.
2. Inspect `xcrun devicectl list devices` and
   `xcrun devicectl device info lockState --device <udid>`. Pairing does not prove
   unlocked transport; a connection reset is not a vault rejection. Recheck once
   after reconnection, not in an unbounded retry loop.
3. Inspect this Xcode version's `devicectl device settings --help` before claiming
   a supported authorization or unlock command. Do not infer one from permission
   to operate the device or from the possession of its passcode.
4. Run one bounded credential-free attach-only smoke to establish XCTest body
   entry. The Developer UI Automation switch alone does not establish that.
   Classify pre-entry runner/authorization failures separately from assertions
   reached inside the app. A skipped test is not product acceptance.
5. If the OS asks for automation authorization, have the owner complete the
   prompt on the device, then resume the existing session. Apple states there
   is no supported automated passcode-entry mechanism for this prompt:
   [Apple Developer Tools guidance](https://developer.apple.com/forums/thread/693273).
   Do not disable the device passcode, enroll MDM, reset trust, reboot, or use
   private APIs merely to make the run pass. Reinspect support if Xcode changes.
6. Once admitted, forward the current authorized reviewer identity and vault
   passphrase through process memory only. Verify the visible account before
   entering the named secure field; submit normal Unlock once. A device passcode
   is not a vault passphrase. Persist neither in skills, env files, launch
   arguments, xctestrun files, screenshots, traces or diagnostics.

## Preserve the session and classify the result

- Update only the test runner for attach-only testing; product installation is
  separate cold preparation, never WebView/document-continuity evidence.
- Keep test attachments disabled; destroy credential-run result bundles. Emit
  only source/run identity, counts, static stage markers and sanitized codes.
- Distinguish `TRANSPORT_UNAVAILABLE`, `DEVICE_LOCKED`,
  `AUTOMATION_AUTHORIZATION_TIMEOUT`, `RUNNER_CONNECTION_FAILED`, identity
  mismatch, vault rejection and an actual UI-contract failure. Do not label an
  unclassified failure as authorization or retry credentials to diagnose it.
- Stop on an unchanged pre-entry blocker or rejected private input. Resume after
  an observed external-state change or a verified harness correction. Request
  device interaction only when the supported tooling cannot perform that gate.
- Once admitted, continue warm journeys without sign-out, reset or direct cold
  route jumps. Preserve passcode and privacy protection; do not promise the OS
  will keep its authorization forever.

## Account for screens, then batch the candidate

1. Join the existing generated surface map, native route inventory and semantic
   route projection. Account separately for physical pages, query/local tabs,
   legacy redirects, callbacks, exclusions and missing authorized fixtures.
   Do not create another route registry or count source coverage as interaction.
2. Group by shared family: shell/Chat, Profile/vault, Connect/Consent, Memory,
   Mail/Calendar/Drive, Finance/Wallet/RIA and public/auth flows. Keep every
   required row tied to current source, destination and prerequisites.
3. Correct verified shared defects together; run nearest contracts and core at
   the combined SHA. Prepare one product per runtime target, verify its actual
   packaged identity, then install separately from continuity testing.
4. Run one attach-only batch per physical device, serially within that device;
   independent devices may run concurrently. Keep credentials out of subsequent
   warm batches once normal admission is established.
5. Check destination/admission before content. Finance setup is not a passed
   Finance workspace; missing fixtures are not successful empty states. Keep
   rapid interruption tests, and distinguish tap delivery from later settlement.
6. If one journey stops a family batch, account for its remaining steps as not
   reached. Restore through authored Back/Chat, verify admission, and run only
   those isolated journeys. Never hide the original failure with a green retry.
7. Require the requested family/test identity and its observed completion receipt,
   not merely exit zero or a passing count: an incorrectly selected generic smoke
   does not prove the requested workspace. Record exact candidate/runtime, actions reached, assertions, exclusions and
   blockers. Rebuild the runner alone for harness-only corrections. Preserve
   unrelated edits and keep physical iPad, iPhone and simulator acceptance distinct.
8. Route landing and redeployment through the full Admin SOP in `repo-operations`.
   Local install, source checks and a partial device batch do not authorize or
   prove a successful deployment.
