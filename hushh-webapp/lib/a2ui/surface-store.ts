import catalog from "../../contracts/a2ui/morphy-one.v1.catalog.json";

export const ONE_A2UI_CATALOG = catalog.catalogId;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = Record<string, Json>;
type Binding = { "@path": string };
type TableCell = string | number | null;
type Component =
  | { id: string; component: "SurfaceCard"; children: string[] }
  | { id: string; component: "TextBlock"; text: string | Binding; emphasis?: "title" | "body" | "muted" }
  | { id: string; component: "DataTable"; label: string; columns: string[]; rows: TableCell[][] | Binding; previewRows?: number }
  | { id: string; component: "PortfolioAllocation" | "PortfolioPerformance" | "PortfolioSources"; snapshot: Binding }
  | { id: string; component: "SavedPortfolio"; section: "holdings" | "allocation" | "performance" | "sources" }
  | { id: string; component: "FinancePortfolioUpload" }
  | { id: string; component: "FinanceStockPreview"; ticker: string }
  | { id: string; component: "MarketSnapshot"; view: "gainers" | "losers" | "movers" }
  | { id: string; component: "FinanceTopGainers" }
  | { id: string; component: "FinancePlaidConnection" }
  | { id: string; component: "FinancePortfolioPicker"; mode: "switch" | "delete" }
  | { id: string; component: "FinanceShareProposal"; audience: "connection" | "verified_advisor" | "received" };

export type A2uiSurface = Readonly<{
  components: ReadonlyMap<string, Component>;
  dataModel: JsonObject;
}>;
export type A2uiSurfaces = ReadonlyMap<string, A2uiSurface>;

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_COMPONENTS = 24;
const MAX_SURFACES = 12;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[_\p{ID_Start}][\p{ID_Continue}]{0,79}$/u.test(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function boundedJson(value: unknown, depth = 0): value is Json {
  if (depth > 10) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4000;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => boundedJson(item, depth + 1));
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 100 && entries.every(([key, item]) =>
    key.length <= 100 && !RESERVED_KEYS.has(key) && boundedJson(item, depth + 1));
}

function pointerTokens(pointer: unknown): string[] | null {
  if (pointer === undefined || pointer === "" || pointer === "/") return [];
  if (typeof pointer !== "string" || pointer.length > 500 || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return null;
  const tokens = pointer.slice(1).split("/").map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  return tokens.length <= 10 && !tokens.some(token => RESERVED_KEYS.has(token)) ? tokens : null;
}

function binding(value: unknown): value is Binding {
  return record(value) && keys(value, ["@path"]) && typeof value["@path"] === "string" && pointerTokens(value["@path"]) !== null;
}

export function readA2uiBinding(surface: A2uiSurface, value: Json | Binding): Json | undefined {
  if (!binding(value)) return value;
  let node: Json | undefined = surface.dataModel;
  for (const token of pointerTokens(value["@path"]) ?? []) {
    if (Array.isArray(node) && /^(?:0|[1-9]\d*)$/.test(token)) node = node[Number(token)];
    else if (record(node) && Object.hasOwn(node, token)) node = node[token] as Json;
    else return undefined;
  }
  return node;
}

export function a2uiTableRows(value: unknown, columns: number): TableCell[][] | null {
  return Array.isArray(value) && value.length <= 1000 && value.every(row =>
    Array.isArray(row) && row.length === columns && row.every(cell => cell === null ||
      typeof cell === "string" && cell.length <= 200 || typeof cell === "number" && Number.isFinite(cell)))
    ? value : null;
}

function parseComponent(value: unknown): Component | null {
  if (!record(value) || !identifier(value.id)) return null;
  const { id, component } = value;
  switch (component) {
    case "SurfaceCard": {
      const { children } = value;
      if (id !== "root" || !keys(value, ["id", "component", "children"]) ||
          !Array.isArray(children) || !children.length || children.length > 16 ||
          !children.every(identifier) || children.includes("root") || new Set(children).size !== children.length) return null;
      return { id, component, children };
    }
    case "TextBlock": {
      const { text, emphasis } = value;
      if (!keys(value, ["id", "component", "text", "emphasis"]) ||
          !(boundedString(text, 1000) || binding(text)) ||
          (emphasis !== undefined && emphasis !== "title" && emphasis !== "body" && emphasis !== "muted")) return null;
      return { id, component, text, emphasis };
    }
    case "DataTable": {
      const { label, columns, rows, previewRows } = value;
      if (!keys(value, ["id", "component", "label", "columns", "rows", "previewRows"]) || !boundedString(label, 80) ||
          !Array.isArray(columns) || columns.length < 1 || columns.length > 8 ||
          !columns.every(column => boundedString(column, 80)) ||
          (previewRows !== undefined && (typeof previewRows !== "number" ||
            !Number.isInteger(previewRows) || previewRows < 1 || previewRows > 20))) return null;
      const tableRows = binding(rows) ? rows : a2uiTableRows(rows, columns.length);
      return tableRows ? { id, component, label, columns, rows: tableRows, previewRows } : null;
    }
    case "PortfolioAllocation":
    case "PortfolioPerformance":
    case "PortfolioSources":
      return keys(value, ["id", "component", "snapshot"]) && binding(value.snapshot)
        ? { id, component, snapshot: value.snapshot }
        : null;
    case "FinanceShareProposal":
      return keys(value, ["id", "component", "audience"]) &&
        (value.audience === "connection" || value.audience === "verified_advisor" || value.audience === "received")
        ? { id, component, audience: value.audience }
        : null;
    case "MarketSnapshot": {
      const { view } = value;
      return id === "root" && keys(value, ["id", "component", "view"]) &&
        (view === "gainers" || view === "losers" || view === "movers")
        ? { id, component, view }
        : null;
    }
    case "FinancePortfolioUpload":
    case "FinanceTopGainers":
    case "FinancePlaidConnection":
      return id === "root" && keys(value, ["id", "component"]) ? { id, component } : null;
    case "FinanceStockPreview":
      return id === "root" && keys(value, ["id", "component", "ticker"]) &&
        typeof value.ticker === "string" && /^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(value.ticker)
        ? { id, component, ticker: value.ticker } : null;
    case "FinancePortfolioPicker":
      return id === "root" && keys(value, ["id", "component", "mode"]) &&
        (value.mode === "switch" || value.mode === "delete")
        ? { id, component, mode: value.mode } : null;
    case "SavedPortfolio": {
      const { section } = value;
      return id === "root" && keys(value, ["id", "component", "section"]) &&
        (section === "holdings" || section === "allocation" || section === "performance" || section === "sources")
        ? { id, component, section }
        : null;
    }
    default:
      return null;
  }
}

function parseComponents(value: unknown, previous = new Map<string, Component>()) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_COMPONENTS) return null;
  const next = new Map(previous);
  const incoming = new Set<string>();
  for (const item of value) {
    const component = parseComponent(item);
    if (!component || incoming.has(component.id)) return null;
    incoming.add(component.id);
    next.set(component.id, component);
  }
  return next.size <= MAX_COMPONENTS ? next : null;
}

function setAtPath(node: Json, tokens: readonly string[], value: Json): Json | undefined {
  const [key, ...remaining] = tokens;
  if (key === undefined) return value;
  const removing = remaining.length === 0 && value === null;
  if (Array.isArray(node)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
    const index = Number(key);
    if (index >= node.length) return undefined;
    if (removing) return node.filter((_, itemIndex) => itemIndex !== index);
    const replacement = setAtPath(node[index]!, remaining, value);
    return replacement === undefined ? undefined : node.map((item, itemIndex) => itemIndex === index ? replacement : item);
  }
  if (!record(node)) return undefined;
  const current = node as JsonObject;
  if (removing) return Object.fromEntries(Object.entries(current).filter(([name]) => name !== key));
  const replacement = setAtPath(current[key] ?? {}, remaining, value);
  return replacement === undefined ? undefined : { ...current, [key]: replacement };
}

/** Reduce the read-only catalog subset. Unsupported messages never alter a surface. */
export function applyA2uiMessage(state: A2uiSurfaces, message: unknown): A2uiSurfaces {
  if (!record(message) || message.version !== "1.0" || Object.keys(message).length !== 2) return state;
  const operation = Object.keys(message).find(key => key !== "version");
  const payload = operation ? message[operation] : undefined;
  if (!record(payload) || !boundedString(payload.surfaceId, 100)) return state;
  const id = payload.surfaceId;
  const existing = state.get(id);
  switch (operation) {
    case "createSurface": {
      if (existing || state.size >= MAX_SURFACES ||
          !keys(payload, ["surfaceId", "catalogId", "sendDataModel", "components", "dataModel"]) ||
          payload.catalogId !== ONE_A2UI_CATALOG || (payload.sendDataModel !== undefined && payload.sendDataModel !== false)) return state;
      const components = payload.components === undefined ? new Map<string, Component>() : parseComponents(payload.components);
      const dataModel = payload.dataModel === undefined ? {} : payload.dataModel;
      if (!components || !record(dataModel) || !boundedJson(dataModel)) return state;
      return new Map(state).set(id, { components, dataModel });
    }
    case "updateComponents": {
      if (!existing || !keys(payload, ["surfaceId", "components"])) return state;
      const components = parseComponents(payload.components, new Map(existing.components));
      return components ? new Map(state).set(id, { ...existing, components }) : state;
    }
    case "updateDataModel": {
      if (!existing || !keys(payload, ["surfaceId", "path", "value"]) || !boundedJson(payload.value)) return state;
      const tokens = pointerTokens(payload.path);
      if (!tokens) return state;
      const dataModel = setAtPath(existing.dataModel, tokens, payload.value);
      return record(dataModel) && boundedJson(dataModel)
        ? new Map(state).set(id, { ...existing, dataModel }) : state;
    }
    case "deleteSurface": {
      if (!existing || !keys(payload, ["surfaceId"])) return state;
      const next = new Map(state);
      next.delete(id);
      return next;
    }
    default:
      return state;
  }
}
