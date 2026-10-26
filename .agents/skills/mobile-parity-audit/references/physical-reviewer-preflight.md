# Physical Reviewer Preflight

Use for normal-session XCUI on an existing signed-in iPhone/iPad. Browser
reviewer bootstrap, device authorization and vault unlock are different gates.
Reuse the existing AppUITests and reviewer identity resolver; do not create
another reviewer store or a privileged app-unlock route.

## Establish admission before private input

1. Record candidate source SHA, built-product identity and selected physical
   destination. A successful compile/install does not prove UI automation.
   Bind the app **and** runner/test executable to that source. An attach-only
   definition using `UseDestinationArtifacts` runs the installed test bundle;
   rebuilding a runner on the Mac does not update it on the phone. Install its
   matching signed runner separately, without reinstalling One merely for a
   harness change. Keep executable digests and install receipts with the run,
   and require the requested case's observed markers before interpreting its
   result. A stale installed runner is not evidence against the new feature.
   Serialize dependency installation, web export, native resource sync and
   packaging. Compare exported application files with the signed bundle before
   installation; a successful native build can still contain stale web assets.
2. Inspect `xcrun devicectl list devices` and
   `xcrun devicectl device info lockState --device <udid>`. Pairing does not prove
   unlocked transport; a connection reset is not a vault rejection. Recheck once
   after reconnection, not in an unbounded retry loop.
   For Wi-Fi, inspect live Bonjour discovery and the current network rather than
   reusing an earlier IP. A reachable endpoint or an `available (paired)` row is
   not an authenticated tunnel. Inspect this version's `devicectl manage pair
   --help`; reconnect the existing paired UDID without unpairing or clearing app
   state, then require a successful details/service probe with `Transport Type:
   localNetwork`. Hostname lookup and paired-UDID lookup can differ. Separate a
   failed tunnel handshake from DDI compatibility and XCTest admission. Do not
   restart shared CoreDevice/Xcode services while another session owns work.
   A failed upload does not establish that USB is required. After reconnecting
   the existing pairing, recheck the authenticated service and make one bounded
   transfer attempt appropriate to the artifact size. Install the app and matching
   runner serially; verify both receipts before launch or attach-only testing.
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
   A reconnect/account-verification page precedes vault admission. Diagnose
   its transport and deployed response contract before retrying credentials.
   Bind the backend's serving source to the candidate's expected principal
   fields; HTTP 200 alone is insufficient. If necessary, use a bounded
   read-only probe through the existing native auth owner, emitting status and
   schema-validation booleans only. Never relax principal validation or silently
   substitute another environment. Record an explicitly selected dev replica
   as dev evidence, not UAT or release acceptance.
   If whole-value input is not acknowledged, do not submit or retry the private
   value. Use the existing synthetic secure-entry probe first, with the matching
   Xcode toolchain selected explicitly through `DEVELOPER_DIR`. On the same
   iOS 27.2 candidate, Xcode 27.1 delivered six of eight public characters;
   Xcode 27.2 passed both public samples and the subsequent normal reviewer
   unlock. This comparison identifies a working toolchain, not every possible
   input-loss cause. Keep synthetic counts separate from private input, which
   must remain process-only and produce only acknowledgement booleans.
7. Check that the native privacy cover has actually retired before private
   input. XCTest can report an underlying WebKit control as hittable while
   UIKit still covers it. Use only the authored recovery action or cancel a
   positively identified authenticator prompt; never remove the shield, tap
   an unrelated system alert or interpret blocked input as credential rejection.

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
   When order is part of the proof, verify observed test-start order; an ordered
   CLI selection does not establish XCTest execution order. Use separate
   attach-only runs when necessary, without relaunching or resetting the app.
5. Check destination/admission before content. Finance setup is not a passed
   Finance workspace; missing fixtures are not successful empty states. Keep
   rapid interruption tests, and distinguish tap delivery from later settlement.
6. If one journey stops a family batch, account for its remaining steps as not
   reached. Restore through authored Back/Chat, verify admission, and run only
   those isolated journeys. Never hide the original failure with a green retry.
   Register restoration before the first route or overlay change, including
   admission failures; verify the resulting warm destination instead of assuming
   a cleanup tap succeeded. Retained native pages may share control identifiers:
   resolve the current eligible destination, not an arbitrary global first match.
7. Require the requested family/test identity and its observed completion receipt,
   not merely exit zero or a passing count: an incorrectly selected generic smoke
   does not prove the requested workspace. Record exact candidate/runtime, actions reached, assertions, exclusions and
   blockers. Rebuild the runner alone for harness-only corrections. Preserve
   unrelated edits and keep physical iPad, iPhone and simulator acceptance distinct.
8. Route landing and redeployment through the full Admin SOP in `repo-operations`.
   Local install, source checks and a partial device batch do not authorize or
   prove a successful deployment.

## Native drawer continuity

Use the current renderer boundaries in `hushh-webapp/docs/ios-native-surface-adoption.md`.
A React drawer and asynchronous native clipping do not share a display transaction;
retained hosts or pose receipts cannot qualify that composition. Keep recovery
drawers coherently React; a native study owns its entire overlapping presentation.

Hold a partial drag before release, then cancel, re-grab and close through authored
controls. Inspect synthetic transition frames, not only settled screenshots or
host identities. Keep underlying input and accessibility isolated until visible
exit completion: an animator's target property is not a retirement receipt.

Runner preparation may interrupt and legitimately retire an owned study. Re-enter
only through its explicit opt-in public action after privacy admission; never
remove the shield or automatically resurrect a retired popup. Account separately
for harness admission, visual composition, interaction, privacy and frame pacing.
Keep recordings public-only throughout their lifetime, including exit/background.

Reject unusable performance evidence: a zero rendered-frame count alongside a
positive frame rate does not establish zero hitches. Keep display-link cadence
separate from compositor metrics. An unsupported recording capability is not a
transition-frame pass. Check the installed executable's debugger entitlement and
the current process identity after installation before diagnosing attach failure;
an alive app does not establish an available XCTest accessibility server.
