# Mobile Parity Check

Use this workflow pack when the task matches `mobile-parity-check`.

## Goal

Verify iOS, Android, web-bridge, and docs parity for native-facing routes and plugin surfaces.

## Steps

1. Start with `mobile-native` and use `mobile-parity-audit` as the default narrow path.
2. Open only the required reads listed in `workflow.json` plus the selected skill manifests.
3. Run the required commands first, then the verification bundle.
4. Capture every field listed in `impact_fields` before calling the work complete.
5. Escalate through `handoff_chain` when the task crosses domain boundaries.

## Common Drift Risks

1. updating web path without native parity review
2. forgetting plugin registration
3. allowing docs/runtime/native route drift
