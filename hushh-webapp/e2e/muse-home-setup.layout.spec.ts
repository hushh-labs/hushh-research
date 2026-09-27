import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Real React-rendered components, with fixture data. Interaction behavior is
// covered by their RTL suites; these checks measure browser layout and scrolling.
let fixtures: Record<string,string>;
let css: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  execFileSync(process.execPath,["scripts/testing/capture-muse-review-fixtures.mjs"],{cwd:process.cwd(),stdio:"pipe"});
  fixtures=JSON.parse(fs.readFileSync("node_modules/.cache/muse-final-review/fixtures.json","utf8")).fixtures;
  const root=process.cwd();
  const {compile}=await import(pathToFileURL(path.join(root,"node_modules/tailwindcss/dist/lib.mjs")).href);
  const compiler=await compile(fs.readFileSync("app/globals.css","utf8").replace(/^@source\s+[^;]+;\s*$/gm,""),{
    base:path.join(root,"app"),onDependency:()=>{},
    loadStylesheet:async(id:string,base:string)=>{
      const file=id==="tailwindcss"?path.join(root,"node_modules/tailwindcss/index.css"):id==="tw-animate-css"?path.join(root,"node_modules/tw-animate-css/dist/tw-animate.css"):path.resolve(base,id);
      return {path:file,base:path.dirname(file),content:fs.readFileSync(file,"utf8")};
    }
  });
  const candidates=new Set<string>();
  for(const markup of Object.values(fixtures)) for(const match of markup.matchAll(/class="([^"]+)"/g)) for(const token of match[1].replace(/&amp;/g,"&").replace(/&quot;/g,'"').split(/\s+/)) candidates.add(token);
  // Keep the route's CSS module rules in the same scope as the captured list.
  const setupStyles=fs.readFileSync("components/onboarding/setup/one-setup-hub.module.css","utf8")
    .replace(/:global\(([^)]+)\)/g,"$1")
    .replace(/\.flatChecklist/g,'[data-muse-setup-list="true"]');
  css=stripAppFontFaces(compiler.build([...candidates]))+setupStyles;
});
async function open(page:Page,screen:string,theme:string){
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.setContent(`<!doctype html><html class="${theme==="dark"?"dark":""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${productFontStyle()}${css}</style></head><body>${fixtures[screen]}</body></html>`);
  await awaitProductFont(page);
}
async function assertControlsFit(page:Page,width:number){
  const result=await page.locator("button:visible, a:visible").evaluateAll(elements=>elements.map(el=>{
    const r=el.getBoundingClientRect();return {name:el.getAttribute("aria-label")||el.textContent,left:r.left,right:r.right,height:r.height,width:r.width,overflow:el.scrollWidth-el.clientWidth};
  }));
  for(const r of result){
    expect(r.left,`${r.name}: left edge`).toBeGreaterThanOrEqual(-1);
    expect(r.right,`${r.name}: right edge`).toBeLessThanOrEqual(width+1);
    expect(r.height,`${r.name}: touch height`).toBeGreaterThanOrEqual(44);
    expect(r.width,`${r.name}: touch width`).toBeGreaterThanOrEqual(44);
    expect(r.overflow,`${r.name}: clipped content`).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
}
for(const theme of ["light","dark"]){
  for(const width of [320,390,768,1440]){
    test(`${theme} Home, setup and long Chat action fit ${width}px`,async({page},testInfo)=>{
      await page.setViewportSize({width,height:900});
      for(const screen of ["homeList","homeGrid","setup","action"]){
        await open(page,screen,theme);
        await assertControlsFit(page,width);
        if(screen==="homeList"){
          const surfaces=await page.evaluate(()=>({body:getComputedStyle(document.body).backgroundColor,home:getComputedStyle(document.querySelector('[data-one-launcher-root="true"]')!).backgroundColor}));
          expect(surfaces.body).toBe(surfaces.home);
          for(const id of ["wallet","pkm"]){
            const title=page.getByTestId(`one-agent-list-row-${id}`).locator('[data-ui-role="row-label"]');
            const geometry=await title.evaluate(el=>({height:el.getBoundingClientRect().height,line:parseFloat(getComputedStyle(el).lineHeight)}));
            expect(geometry.height).toBeLessThanOrEqual(geometry.line+1);
          }
        }
        if(screen==="setup"){
          const finish=page.getByRole("button",{name:"Finish setting up One"});
          const bounds=(await finish.boundingBox())!;
          expect(bounds.width).toBeLessThanOrEqual(480);
          expect(bounds.height).toBe(50);
        }
        if(screen==="action"){
          const confirm=page.getByTestId("specialist-directive-confirm");
          await expect(confirm).toHaveText("Confirm this request and share my selected information");
          await confirm.focus();
          await expect(confirm).toBeFocused();
        }
        if(width===320||width===1440) await page.screenshot({path:testInfo.outputPath(`${screen}-${theme}-${width}.png`),fullPage:true});
      }
    });
  }
  test(`${theme} setup intro keeps Continue reachable in short landscape`,async({page},testInfo)=>{
    await page.setViewportSize({width:667,height:320});
    await open(page,"intro",theme);
    const intro=page.locator("[data-capability-cinematic-intro]");
    const continueButton=page.getByRole("button",{name:"Continue"});
    await continueButton.scrollIntoViewIfNeeded();
    const rect=(await continueButton.boundingBox())!;
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y+rect.height).toBeLessThanOrEqual(320);
    expect(rect.width).toBeLessThanOrEqual(480);
    expect(await intro.evaluate(el=>getComputedStyle(el).overflowY)).toBe("auto");
    await assertControlsFit(page,667);
    await page.screenshot({path:testInfo.outputPath(`intro-${theme}-landscape.png`)});
  });
}
