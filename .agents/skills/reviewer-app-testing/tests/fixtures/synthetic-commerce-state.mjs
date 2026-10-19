import { randomUUID } from "node:crypto";
import { newCommerceState } from "../../scripts/scope-commerce-rehearsal-state.mjs";
const APP_ORIGIN = "https://uat.one.hushh.ai";

export function syntheticState() {
  const fixture = () => ({ synthetic: true, personRef: randomUUID(), scopeRef: "synthetic", scopeHandle: "synthetic_value",
    machineScope: "attr.synthetic.value", expectedPayloadSha256: "a".repeat(64) });
  return newCommerceState({ appOrigin: APP_ORIGIN, platformAccountId: "acct_synthetic", schemaHead: 283,
    fixtures: { primary: fixture(), counterpart: fixture() } });
}

