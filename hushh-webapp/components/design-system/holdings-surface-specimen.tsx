import { AgentTurnStreamPanel } from "@/components/agent/agent-turn-stream-panel";
import { consumeNativeAdkFrames, createNativeAdkTurnOutput } from "@/lib/a2ui/native-adk-visual-stream";
import { ONE_A2UI_CATALOG } from "@/lib/a2ui/surface-store";
import { formatSavedPortfolioMoney } from "@/lib/kai/market-value-format";

const surfaceId = "demo_holdings";
const samplePositions = [
  { name: "S&P 500 Index Fund", ticker: "VOO", bucket: "Equities", value: 2146.80 },
  { name: "Microsoft", ticker: "MSFT", bucket: "Equities", value: 1143.60 },
  { name: "U.S. Treasury ETF", ticker: "SGOV", bucket: "Treasury", value: 985.25 },
  ...Array.from({ length: 49 }, (_, index) => ({
    name: `Sample holding ${index + 4}`,
    ticker: `DEMO${String(index + 4).padStart(2, "0")}`,
    bucket: "Equities",
    value: 80 - index,
  })),
];
const currency = "USD";
const holdings = samplePositions.map(({ name, ticker, value }) =>
  [name, ticker, formatSavedPortfolioMoney(value, currency)],
);
const portfolioValue = samplePositions.reduce((total, position) => total + position.value, 0);
const allocation = ["Equities", "Treasury"].map(name => ({
  name,
  value: samplePositions.filter(position => position.bucket === name)
    .reduce((total, position) => total + position.value, 0),
}));

function buildSampleTurn() {
  const message = {
    version: "1.0",
    createSurface: {
      surfaceId,
      catalogId: ONE_A2UI_CATALOG,
      components: [
        { id: "root", component: "SurfaceCard", children: ["heading", "source", "holdings", "allocation", "performance"] },
        { id: "heading", component: "TextBlock", text: "Holdings", emphasis: "title" },
        { id: "source", component: "TextBlock", text: `Sample statement · ${holdings.length} holdings`, emphasis: "muted" },
        {
          id: "holdings",
          component: "DataTable",
          label: "Sample portfolio holdings",
          columns: ["Holding", "Symbol", "Market value"],
          rows: { "@path": "/holdings" },
          previewRows: 5,
        },
        { id: "allocation", component: "PortfolioAllocation", snapshot: { "@path": "/allocation" } },
        { id: "performance", component: "PortfolioPerformance", snapshot: { "@path": "/performance" } },
      ],
      dataModel: {
        holdings,
        allocation: {
          currency,
          totalValue: portfolioValue,
          rows: allocation,
        },
        performance: {
          currency, value: portfolioValue, invested: 6000, cash: 0,
          history: [
            { date: "2026-09-30", value: 6000 },
            { date: "2026-10-31", value: portfolioValue },
          ],
        },
      },
    },
  };
  const event = {
    author: "one",
    content: {
      parts: [{
        functionResponse: {
          name: "send_a2ui_json_to_client",
          response: { validated_a2ui_json: [message] },
        },
      }],
    },
  };
  return consumeNativeAdkFrames(createNativeAdkTurnOutput(), "data: " + JSON.stringify(event) + "\n\n").output;
}

const sampleTurn = buildSampleTurn();

export function HoldingsSurfaceSpecimen() {
  return (
    <AgentTurnStreamPanel
      nativeSurfaces={sampleTurn.surfaces}
      streamEvents={[]}
      responseText={sampleTurn.settledText + sampleTurn.partialText}
      isStreaming={false}
    />
  );
}
