/** Browser-memory observer. Retains only terminal flags and allowlisted actions. */
export function installConsentStreamProbe() {
  const originalFetch = window.fetch.bind(window);
  window.__consentRehearsalStreams = [];
  window.fetch = async (...args) => {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, window.location.href).pathname !== "/api/one/agent-chat") return originalFetch(...args);
    const proof = { httpOk: false, finished: false, runError: false, runErrorClass: null, malformed: false,
      aborted: false, settled: false, parkedActions: [] };
    window.__consentRehearsalStreams.push(proof);
    let response;
    try { response = await originalFetch(...args); }
    catch (error) { proof.settled = true; throw error; }
    proof.httpOk = response.ok;
    const parse = value => {
      if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    };
    const admitAction = action => {
      if (["consent.request", "consent.cancel_request"].includes(action) && !proof.parkedActions.includes(action)) {
        proof.parkedActions.push(action);
      }
    };
    const event = frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      let item;
      try { item = JSON.parse(data); } catch { proof.malformed = true; return; }
      if (item.type === "RUN_ERROR") {
        proof.runError = true;
        const code = item.code;
        proof.runErrorClass = typeof code !== "string" ? "untyped"
          : code.startsWith("MCP_") ? "connector"
          : code.startsWith("DATABASE_") ? "database"
          : code.startsWith("AGENT_RUNTIME_") ? "runtime"
          : ["MODEL_ERROR", "RESOURCE_EXHAUSTED"].includes(code) ? "model" : "other";
      }
      if (item.type === "RUN_FINISHED") proof.finished = true;
      if (item.type === "TOOL_CALL_RESULT") {
        let result = parse(item.content);
        for (const key of ["result", "content", "data"]) {
          const nested = parse(result?.[key]);
          if (nested?.status || nested?.directive || nested?.action_id) { result = nested; break; }
        }
        const directive = parse(result?.directive);
        if (["confirm_pending", "proposal_ready", "ready_to_run"].includes(result?.status) && directive &&
          (result.status === "confirm_pending" || directive.needsConfirmation === true || directive.needs_confirmation === true)) {
          admitAction(directive.actionId || directive.action_id || result.action_id);
        }
      }
      if (item.type === "STATE_DELTA" && Array.isArray(item.delta)) {
        for (const patch of item.delta) {
          if (typeof patch.path === "string" && patch.path.startsWith("/hussh:pending_directive:") &&
            ["add", "replace"].includes(patch.op) && patch.value?.kind === "action") {
            admitAction(patch.value.payload?.actionId);
          }
        }
      }
    };
    // Clone before handing the response to the app, and consume incrementally:
    // the app intentionally aborts the original fetch when it stages confirmation.
    const reader = response.clone().body?.getReader();
    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        if (!reader) { proof.malformed = true; return; }
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || "";
          for (const frame of frames) event(frame);
          if (buffer.length > 1_000_000) { proof.malformed = true; await reader.cancel(); break; }
        }
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer);
      } catch (error) {
        proof.aborted = error?.name === "AbortError";
        if (!proof.aborted) proof.malformed = true;
      } finally {
        proof.settled = true;
        reader?.releaseLock();
      }
    })();
    return response;
  };
}
