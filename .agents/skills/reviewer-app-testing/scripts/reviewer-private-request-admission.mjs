/** Explicit private-owner rehearsal ports; callers verify the signed endpoint and owner. */
export function requireBoundedConnectorAdmission({ admitMutation, admitOwnerPodConnectorOperation }) {
  if (admitOwnerPodConnectorOperation && typeof admitMutation !== "function")
    throw new Error("Private connector rehearsal requires bounded mutation admission.");
}

export async function admitPrivateReviewerRequest(request, {
  appOrigin, allowMemoryPreparation, admitOwnerPodMemoryPreparation,
  admitOwnerPodConnectorOperation,
}) {
  const target = new URL(request.url());
  if (request.method().toUpperCase() !== "POST" || target.protocol !== "https:" ||
      target.origin === appOrigin || target.username || target.password ||
      target.search || target.hash) return false;
  let admission;
  if (allowMemoryPreparation && admitOwnerPodMemoryPreparation &&
      target.pathname === "/api/one/pod/memory/proposals") {
    admission = admitOwnerPodMemoryPreparation;
  } else if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true" &&
      admitOwnerPodConnectorOperation && !target.port &&
      /^\/api\/one\/pod\/agent-chat\/connectors\/custom_[a-f0-9]{32}\/mcp\/(?:catalog|verify|oauth\/(?:begin|complete|cancel))$/.test(target.pathname)) {
    admission = admitOwnerPodConnectorOperation;
  }
  if (!admission || request.isNavigationRequest()) return false;
  try { return await admission(request) === true; }
  catch { return false; }
}
