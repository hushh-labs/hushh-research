import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import A2uiPortfolioRead from "@/components/a2ui/a2ui-portfolio-read";
import { consumeNativeAdkFrames, createNativeAdkTurnOutput } from "@/lib/a2ui/native-adk-visual-stream";
import { A2uiSurfaceView } from "@/components/a2ui/a2ui-surface-view";
import { a2uiTableRows, applyA2uiMessage, ONE_A2UI_CATALOG, readA2uiBinding } from "@/lib/a2ui/surface-store";

const create = {
  version: "1.0",
  createSurface: {
    surfaceId: "holdings",
    catalogId: ONE_A2UI_CATALOG,
    dataModel: { "broker/age": { "~current": ["MSFT"] } },
    components: [{ id: "root", component: "TextBlock", text: { "@path": "/broker~1age/~0current/0" } }],
  },
};
const update = (path: string, value: unknown) => ({
  version: "1.0", updateDataModel: { surfaceId: "holdings", path, value },
});

describe("One read-only A2UI catalog", () => {
  it.each(["consent-protocol", "hushh-webapp"])(
    "ships the canonical catalog in %s",
    (packageDir) => {
      const catalog = "contracts/a2ui/morphy-one.v1.catalog.json";
      const repoRoot = resolve(process.cwd(), "..");
      const canonical = readFileSync(resolve(repoRoot, catalog), "utf8");
      const packaged = readFileSync(resolve(repoRoot, packageDir, catalog), "utf8");
      expect(packaged.replaceAll("\r\n", "\n")).toBe(canonical.replaceAll("\r\n", "\n"));
    },
  );

  it.each(["gainers", "losers", "movers"])("accepts the requested market view %s", (view) => {
    const components = [{ id: "root", component: "MarketSnapshot", view }];
    const payload = { ...create, createSurface: { ...create.createSurface, components } };

    const surface = applyA2uiMessage(new Map(), payload).get("holdings");
    expect(surface?.components.get("root")).toEqual(components[0]);

    const unsupported = { ...payload, createSurface: {
      ...payload.createSurface, components: [{ ...components[0], view: "news" }],
    } };
    expect(applyA2uiMessage(new Map(), unsupported).size).toBe(0);
  });

  it("uses v1.0 pointer binding and leaves the earlier snapshot intact", () => {
    const initial = applyA2uiMessage(new Map(), create);
    const previous = initial.get("holdings")!;
    const next = applyA2uiMessage(initial, update("/broker~1age/~0current/0", "VOO"));
    expect(readA2uiBinding(next.get("holdings")!, { "@path": "/broker~1age/~0current/0" })).toBe("VOO");
    expect(readA2uiBinding(previous, { "@path": "/broker~1age/~0current/0" })).toBe("MSFT");
    expect(applyA2uiMessage(next, create)).toBe(next);
    const removed = applyA2uiMessage(next, {
      version: "1.0", deleteSurface: { surfaceId: "holdings" },
    });
    expect(removed.size).toBe(0);
    expect(applyA2uiMessage(removed, update("/", {}))).toBe(removed);
  });

  it("fails closed for an unknown catalog, privileged component, or unsafe path", () => {
    const empty = new Map();
    expect(applyA2uiMessage(empty, {
      ...create, createSurface: { ...create.createSurface, catalogId: "untrusted:catalog" },
    })).toBe(empty);
    const created = applyA2uiMessage(empty, create);
    expect(applyA2uiMessage(created, {
      version: "1.0",
      updateComponents: {
        surfaceId: "holdings",
        components: [{ id: "root", component: "Button", action: { event: { name: "send" } } }],
      },
    })).toBe(created);
    expect(applyA2uiMessage(created, update("/__proto__/polluted", true))).toBe(created);
    expect(applyA2uiMessage(created, update("/", JSON.parse('{"constructor": {"polluted": true}}')))).toBe(created);
  });
});

it("consumes a fragmented native ADK result from top-level One only", () => {
  const native = (author: string) => "data: " + JSON.stringify({
    author,
    content: {
      parts: [{ functionResponse: {
        name: "send_a2ui_json_to_client",
        response: { validated_a2ui_json: [create] },
      } }],
    },
  }) + "\n\n";
  const empty = createNativeAdkTurnOutput();
  expect(consumeNativeAdkFrames(empty, native("finance")).output).toBe(empty);
  const stream = native("one");
  const first = consumeNativeAdkFrames(empty, stream.slice(0, 25));
  expect(first.output).toBe(empty);
  const second = consumeNativeAdkFrames(first.output, stream.slice(25), first.remainder);
  expect(readA2uiBinding(second.output.surfaces.get("holdings")!, { "@path": "/broker~1age/~0current/0" })).toBe("MSFT");
  expect(second.remainder).toBe("");
});

it("delivers a coalesced Browser receipt under its native session without retaining it in visual output", () => {
  const receipt = { invocationId: "invocation", toolCallId: "call", status: "accepted",
    binding: { owner_id: "owner", task_id: `browser_${"a".repeat(32)}` } };
  const observed: unknown[] = [];
  const output = consumeNativeAdkFrames(createNativeAdkTurnOutput(),
    `event: start\ndata: {"sessionId":"session"}\n\nevent: browser_task\ndata: ${JSON.stringify(receipt)}\n\nevent: done\ndata: {}\n\nevent: browser_task\ndata: ${JSON.stringify(receipt)}\n\n`,
    "", (value, sessionId) => observed.push({ value, sessionId }),
  ).output;
  expect(observed).toEqual([{ value: receipt, sessionId: "session" }]);
  expect(output).toMatchObject({ status: "complete", sessionId: "session", settledText: "" });
  expect(JSON.stringify(output)).not.toContain(receipt.binding.task_id);
});

it("keeps all 52 validated holding rows when a malformed frame precedes an update", () => {
  const holdings = Array.from({ length: 52 }, (_, index) => [`TEST${index + 1}`, index + 1]);
  const showHoldings = {
    ...create,
    createSurface: {
      ...create.createSurface,
      dataModel: { holdings },
      components: [{
        id: "root", component: "DataTable", label: "Holdings",
        columns: ["Symbol", "Market value"], rows: { "@path": "/holdings" },
      }],
    },
  };
  const previous = applyA2uiMessage(new Map(), showHoldings);
  const nativeUpdate = {
    author: "one",
    content: { parts: [{ functionResponse: {
      name: "send_a2ui_json_to_client",
      response: { validated_a2ui_json: [update("/holdings/51/1", 1052)] },
    } }] },
  };
  const { output } = consumeNativeAdkFrames(
    { ...createNativeAdkTurnOutput(), surfaces: previous },
    `data: {"invalid":\n\ndata: ${JSON.stringify(nativeUpdate)}\n\n`,
  );
  const rows = a2uiTableRows(readA2uiBinding(output.surfaces.get("holdings")!, { "@path": "/holdings" }), 2);
  expect(rows).toHaveLength(52);
  expect(rows?.at(-1)).toEqual(["TEST52", 1052]);
});

it("replaces partial text with ADK's settled answer without repeating it", () => {
  const frame = (partial: boolean, text: string) =>
    `data: ${JSON.stringify({ author: "one", partial, content: { parts: [{ text }] } })}\n\n`;
  const partial = consumeNativeAdkFrames(
    createNativeAdkTurnOutput(), frame(true, "Your ") + frame(true, "52 holdings."),
  ).output;
  expect(partial.partialText).toBe("Your 52 holdings.");
  const final = consumeNativeAdkFrames(partial, frame(false, "Your 52 holdings.")).output;
  expect(final.settledText).toBe("Your 52 holdings.");
  expect(final.partialText).toBe("");
  const { output: complete } = consumeNativeAdkFrames(
    final, "event: done\ndata: {}\n\n" + frame(false, "late text"),
  );
  expect(complete.status).toBe("complete");
  expect(complete.settledText).toBe("Your 52 holdings.");
  const { output: proposal } = consumeNativeAdkFrames(
    final, 'event: review\ndata: {"args":"untrusted"}\n\n',
  );
  expect(proposal).toBe(final);
  const { output: paused } = consumeNativeAdkFrames(
    final, "event: review\ndata: {}\n\n" + frame(false, "late text"),
  );
  expect(paused).toMatchObject({ status: "awaiting_review", settledText: "Your 52 holdings." });
  expect(paused.errorCode).toBeUndefined();
});

it("binds saved portfolio facts without inferring missing currency or gain coverage", () => {
  const portfolio = {
    currency: "USD", value: 500, cash: 0,
    sinceBought: { gain: 25, covered: 10, eligible: 52 },
  };
  const input = {
    ...create,
    createSurface: {
      ...create.createSurface,
      dataModel: { portfolio },
      components: [{
        id: "root", component: "PortfolioPerformance", snapshot: { "@path": "/portfolio" },
      }],
    },
  };
  const surface = applyA2uiMessage(new Map(), input).get("holdings")!;
  const value = readA2uiBinding(surface, { "@path": "/portfolio" });
  const view = render(createElement(A2uiPortfolioRead, { component: "PortfolioPerformance", value }));
  expect(view.getByText("Cash")).toBeTruthy();
  expect(view.getByText("Since-purchase figures cover 10 of 52 positions.")).toBeTruthy();
  expect(view.queryByText("Invested")).toBeNull();
  view.rerender(createElement(A2uiPortfolioRead, {
    component: "PortfolioPerformance", value: { ...portfolio, currency: null },
  }));
  expect(view.container.childElementCount).toBe(0);
});

it("shows the saved statement name and import time, or the linked Plaid label", () => {
  const importedAt = "2026-11-26T09:00:00Z";
  const input = {
    ...create,
    createSurface: {
      ...create.createSurface,
      dataModel: { source: { kind: "statement", fileName: "November.pdf", importedAt } },
      components: [{ id: "root", component: "PortfolioSources", snapshot: { "@path": "/source" } }],
    },
  };
  const surface = applyA2uiMessage(new Map(), input).get("holdings")!;
  expect(surface.components.get("root")?.component).toBe("PortfolioSources");
  const value = readA2uiBinding(surface, { "@path": "/source" });
  const view = render(createElement(A2uiPortfolioRead, { component: "PortfolioSources", value }));
  expect(view.getByText("November.pdf")).toBeTruthy();
  expect(view.container.querySelector("time")?.dateTime).toBe(importedAt);
  view.rerender(createElement(A2uiPortfolioRead, {
    component: "PortfolioSources", value: { kind: "plaid", fileName: "November.pdf", importedAt },
  }));
  expect(view.getByText("Linked Plaid account")).toBeTruthy();
  expect(view.queryByText("November.pdf")).toBeNull();
  expect(view.container.querySelector("time")).toBeNull();
});

it.each([
  ["verified_advisor", "Portfolio sharing was proposed.", { showAmounts: true }],
  ["received", "Received Finance was offered.", { grantId: "model-chosen-grant" }],
])("keeps restored %s share proposals inert and rejects model-supplied share terms", (audience, label, unsupported) => {
  const proposal = { id: "root", component: "FinanceShareProposal", audience };
  const surface = {
    ...create,
    createSurface: { ...create.createSurface, components: [proposal] },
  };
  const accepted = applyA2uiMessage(new Map(), surface).get("holdings")!;
  const view = render(createElement(A2uiSurfaceView, { surface: accepted }));
  expect(view.getByText(label)).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
  const state = new Map();
  expect(applyA2uiMessage(state, {
    ...surface,
    createSurface: { ...surface.createSurface, components: [{ ...proposal, ...unsupported }] },
  })).toBe(state);
});
