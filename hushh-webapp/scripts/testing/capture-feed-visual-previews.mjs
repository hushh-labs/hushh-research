/** Deterministic component previews. No credentials, accounts, or network requests. */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "tailwindcss";
import { transform } from "lightningcss";
import { chromium } from "@playwright/test";
import { cases as journeyCases, escapeHtml as h, previewId, previewTime } from "./feed-visual-journey.mjs";

import { policyPreviewCases } from "./feed-policy-preview-cases.mjs";
import { locationPreviewCases } from "./location-feed-preview-cases.mjs";
const cases = [...locationPreviewCases, ...journeyCases, ...policyPreviewCases];
const root = process.cwd();
if (!process.argv[2]) throw new Error("Provide an output directory for the design previews.");
const output = path.resolve(process.argv[2]);
const rendered = await fs.mkdtemp(path.join(root, "__tests__", ".feed-visual-"));
await fs.mkdir(output, { recursive: true });
const fixtureInput = JSON.stringify(cases.map(item => ({
  ...item,
  id: "preview-" + previewId(item.family),
  destination: item.destination.replace("{id}", item.key === "16-statement-saved" ? "stmt_preview_october" : previewId(item.family)),
})));

try {
  const testSource = `
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { it, vi } from "vitest";
import { AppPageShell, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { SettingsGroup, SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { FeedRow } from "@/components/feed/feed-row";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";
import { FinanceAgentIcon, KycAgentIcon, LocationAgentIcon } from "@/components/icons/agents";
import { productFontStyle } from "../../e2e/fixtures/product-font";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const cases = ${fixtureInput};
const timestamp = ${JSON.stringify(previewTime)};
it("renders deterministic Feed and detail design previews", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(timestamp));
  const shell = (name: string, content: React.ReactNode) => renderToStaticMarkup(
    <div data-app-surface="one" data-profile-type-scale="page">
      <aside className="bg-amber-100 px-4 py-2 text-xs font-semibold text-amber-950">DESIGN PREVIEW · SYNTHETIC · NOT UAT</aside>
      <AppPageShell as="main" width="reading" data-app-surface="one" data-profile-type-scale="page">
        <AppPageContentRegion>
          <header className="mb-5 mt-4 flex items-center gap-3 text-xl font-semibold">
            <span aria-hidden="true" className="rounded-full border px-3 py-1">‹</span>{name}
          </header>
          {content}
        </AppPageContentRegion>
      </AppPageShell>
    </div>,
  );
  const records = cases.map(item => {
    const Icon = item.section === "Location" ? LocationAgentIcon : item.section === "Finance" ? FinanceAgentIcon : KycAgentIcon;
    const sourceItem = "feedItem" in item ? item.feedItem as FeedItem : null;
    const presented = sourceItem ? presentFeedItem(sourceItem) : null;
    const destination = presented?.exactDestination && presented.href ? presented.href : sourceItem ? "/one/feed · selected recorded detail" : item.destination;
    const displayed = presented ? [presented.label, presented.description].filter(Boolean).join(" · ") : item.copy;
    const search = item.key.includes("-search-") || item.key === "16-statement-saved";
    const content = <SettingsPresentationProvider density="compact">
      {search ? <label className="mb-3 block px-2 text-sm">Search activity<input readOnly value="October" className="mt-1 w-full rounded-lg border bg-background px-3 py-2" /></label> : null}
      {item.key === "location-09-nearby" ? <p className="p-4 text-sm text-muted-foreground">No activity yet</p>
      : item.key === "location-00-mixed" ? <>
        <SettingsGroup title="Live" separatorInset>{["Ankit", "Ankit"].map((person,index)=><FeedActionableRow key={index} item={{id:"incident-"+index,icon:LocationAgentIcon,sourceLabel:"Location",title:"Emergency alert from "+person,description:"",emphasis:"emergency",sortAt:1,displayTimestamp:Date.parse(timestamp)-index*60000,href:"#incident-"+index,actions:[]}} />)}</SettingsGroup>
        <SettingsGroup title="Needs you" separatorInset>{[["Maya asked to see your location for 1 hour","Review"],["You sent a Check-In to 2 of 3 people","Review remaining"]].map(([title,label])=><FeedActionableRow key={title} item={{id:title,icon:LocationAgentIcon,sourceLabel:"Location",title,description:"",sortAt:1,actions:[{key:"review",label,tone:"primary",run:()=>{}}]}} />)}</SettingsGroup>
        <SettingsGroup title="Today" separatorInset><FeedRow item={{id:"ended",source_domain:"location",event_type:"location_share_revoked",actor_label:"Alex",metadata:{counterpart_label:"Alex",feed_audience:"owner",reason:"owner_revoke"},read:true,created_at:timestamp}} onOpen={()=>{}} /><FeedActionableRow item={{id:"finance",icon:FinanceAgentIcon,sourceLabel:"Finance",title:"Portfolio imported",description:"29 holdings",sortAt:1,actions:[]}} /></SettingsGroup>
      </>
      : item.key === "22-institution-return" ? <SettingsGroup title="Needs you"><p className="p-4 text-sm">No reconnection required</p></SettingsGroup>
      : <SettingsGroup title={search ? "Search results" : item.action ? "Needs you" : "Activity"} separatorInset>
        {sourceItem ? <FeedRow item={sourceItem} openable onOpen={() => {}} /> : item.key === "17-analysis-saved" ? <FeedRow item={{
          id: "100", source_domain: "kai", event_type: "kai_analysis_saved", actor_label: null,
          metadata: { ticker: "AAPL", run_id: item.id }, read: false, created_at: timestamp,
        }} onOpen={() => {}} />
        : <FeedActionableRow item={{
          id: item.id, icon: Icon, iconTone: "capability", sourceLabel: item.section === "Location" ? "Location" : undefined, title: item.copy,
          description: "", href: "#detail", sortAt: Date.parse(timestamp),
          displayTimestamp: Date.parse(timestamp),
          actions: item.action ? [{ key: "open", label: item.action, tone: "primary", run: () => {} }] : [],
        }} />}
      </SettingsGroup>}
    </SettingsPresentationProvider>;
    const detail = <article className="space-y-3 rounded-2xl border bg-background p-4">
      <h2 className="text-lg font-semibold">{displayed}</h2>
      <p className="text-sm">{item.state}</p>
      <dl className="space-y-3 text-xs">
        <div><dt className="font-semibold">Viewer</dt><dd>{item.role}</dd></div>
        <div><dt className="font-semibold">Illustrative destination</dt><dd className="break-all">{destination}</dd></div>
        <div><dt className="font-semibold">Live verification source</dt><dd className="break-all">{item.authority}</dd></div>
      </dl>
    </article>;
    return { key: item.key, displayed, destination, feed: shell("Feed", content), detail: shell("Record detail", detail) };
  });
  writeFileSync(${JSON.stringify(path.join(rendered, "rendered.json"))}, JSON.stringify({ records, font: productFontStyle() }));
});
`;
  const testFile = path.join(rendered, "render-preview.test.tsx");
  await fs.writeFile(testFile, testSource);
  execFileSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", testFile], { stdio: "inherit", env: { ...process.env, TZ: "UTC" } });
  const { records, font } = JSON.parse(await fs.readFile(path.join(rendered, "rendered.json"), "utf8"));
  const style = (await fs.readFile("app/globals.css", "utf8")).replace(/^@source\s+[^;]+;\s*$/gm, "");
  const css = await compile(style, {
    base: path.join(root, "app"),
    onDependency: () => {},
    async loadStylesheet(id, base) {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
        : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: await fs.readFile(file, "utf8") };
    },
  });
  const classNames = new Set(records.flatMap(row => [row.feed, row.detail]).flatMap(markup =>
    [...markup.matchAll(/class="([^"]*)"/g)].flatMap(match => match[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", String.fromCharCode(34)).replaceAll("&#x27;", String.fromCharCode(39)).split(/\s+/u))
  ));
  const builtCss = transform({ code: Buffer.from(css.build([...classNames])), minify: true }).code.toString()
    .replace(/@font-face\s*\{[^}]*url\([^)]*\/fonts\/[^)]*\)[^}]*\}/g, "");
  const browser = await chromium.launch({ channel: process.env.FEED_PREVIEW_BROWSER || "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, timezoneId: "UTC" });
    await page.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === "https://feed-preview.invalid" && /^\/logos\/[a-z]+\.svg$/.test(url.pathname)) {
        return route.fulfill({ contentType: "image/svg+xml", body: await fs.readFile(path.join(root, "public", url.pathname)) });
      }
      return route.abort();
    });
    for (const row of records) {
      for (const kind of ["feed", "detail"]) {
        const markup = row[kind].replaceAll('src="/logos/apple.svg"', 'src="data:image/svg+xml;base64,' + (await fs.readFile(path.join(root,"public/logos/apple.svg"))).toString("base64") + '"');
        await page.setContent('<!doctype html><html lang="en"><head><base href="https://feed-preview.invalid/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + builtCss + font + 'body{margin:0;background:var(--background);color:var(--foreground)}</style></head><body>' + markup + "</body></html>");
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(async img => {
            try { await img.decode(); } catch { throw new Error("Preview image failed: " + img.getAttribute("src")); }
          }));
        });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Horizontal overflow: " + row.key);
        if (!(await page.locator("main").isVisible())) throw new Error("Preview did not render: " + row.key);
        await page.screenshot({ path: path.join(output, row.key + "-" + kind + ".png"), animations: "disabled" });
        if (row.key === "location-00-mixed" && kind === "feed") {
          await page.setViewportSize({width:1440,height:1000});
          await page.screenshot({path:path.join(output,"location-00-mixed-desktop.png"),animations:"disabled"});
          await page.setViewportSize({width:393,height:852});
        }
      }
    }
  } finally {
    await browser.close();
  }
  const cards = cases.map(item => '<tr><td>' + h(item.key) + '<br><a href="' + item.key + '-feed.png">Feed</a> · <a href="' + item.key + '-detail.png">Detail</a></td><td>' + h(item.role) + '<br>' + h(item.feedItem?.activity_group_id || previewId(item.family)) +
    '</td><td>' + h(item.state) + '<br><small>' + h(item.authority) + '</small></td><td>' + h(records.find(record => record.key === item.key)?.displayed || item.copy) +
    '</td><td><code>' + h(records.find(record => record.key === item.key)?.destination || item.destination.replace("{id}", item.key === "16-statement-saved" ? "stmt_preview_october" : previewId(item.family))) + '</code></td><td>Preview only · UAT not run</td></tr>').join("");
  const contact = cases.map(item => '<article><h2>' + h(item.key) + '</h2><div><a href="' + item.key +
    '-feed.png"><img loading="lazy" src="' + item.key + '-feed.png" alt="Feed design preview"></a><a href="' + item.key +
    '-detail.png"><img loading="lazy" src="' + item.key + '-detail.png" alt="Detail design preview"></a></div></article>').join("");
  await fs.writeFile(path.join(output, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>One Feed visual review</title><style>' +
    'body{font:15px/1.5 system-ui;margin:24px;color:#202129;background:#fafafa}article{background:white;border:1px solid #ddd;border-radius:12px;padding:14px}article h2{font-size:15px}article div{display:flex;gap:8px}img{width:100%;max-width:175px;height:auto;border:1px solid #ddd}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px}table{border-collapse:collapse;width:100%;margin:30px 0;text-align:left}th,td{padding:8px;border:1px solid #ddd;overflow-wrap:anywhere}td small{color:#454653}</style><h1>One Feed · design previews</h1><p>iPhone 15 Pro viewport · 393 × 852 CSS px at 3×. Synthetic records and illustrative detail states. These are not live UAT or native screenshots.</p><section>' + contact +
    '</section><h2>Verification matrix</h2><table><tr><th>Screenshot</th><th>Role / synthetic operation ID</th><th>Expected authoritative state</th><th>Displayed copy</th><th>Expected tap</th><th>Result</th></tr>' + cards + '</table></html>');
  console.log("Wrote " + cases.length + " preview pairs: " + pathToFileURL(path.join(output, "index.html")).href);
} finally {
  await fs.rm(rendered, { recursive: true, force: true });
}
