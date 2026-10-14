/** Legacy capabilities permit assessment; only the assessment is refused. */
export async function privateCommandRefusal(route: string): Promise<Response> {
  if (route === "agent-chat/capabilities") {
    return Response.json({ identity: { type: "google-adk" }, transport: { streaming: true } });
  }
  if (route === "commands/assess") {
    return Response.json({ detail: { code: "POD_DIRECT_NOT_READY" } }, { status: 503 });
  }
  throw new Error("Unexpected private command route: " + route);
}
