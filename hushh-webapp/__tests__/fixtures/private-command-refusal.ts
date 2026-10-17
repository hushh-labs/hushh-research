/** Refuse at discovery or assessment without admitting a different transport. */
export async function privateCommandRefusal(
  route: string, phase: "capabilities" | "assessment" = "assessment",
): Promise<Response> {
  if (route === "agent-chat/capabilities" && phase === "assessment") {
    return Response.json({ identity: { type: "google-adk" }, transport: { streaming: true } });
  }
  if (route === (phase === "capabilities" ? "agent-chat/capabilities" : "commands/assess")) {
    return Response.json({ detail: { code: "POD_DIRECT_NOT_READY" } }, { status: 503 });
  }
  throw new Error("Unexpected private command route: " + route);
}
