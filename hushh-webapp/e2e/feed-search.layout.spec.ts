import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";
// @ts-expect-error JavaScript fixture build port, isolated from the application.
import { buildFeedSearchPreview } from "../scripts/testing/build-feed-search-preview.mjs";
let fixture:{script:string;css:string}, folder:string;
test.beforeAll(async()=>{folder=fs.mkdtempSync(path.join(os.tmpdir(),"feed-search-layout-"));fixture=await buildFeedSearchPreview(folder,process.env.FEED_SEARCH_BEFORE_SOURCE);});
test.afterAll(()=>{if(folder&&path.basename(folder).startsWith("feed-search-layout-"))fs.rmSync(folder,{recursive:true,force:true});});
for(const width of [393,1440])test.describe(`${width}px`,()=>{
 test.use({deviceScaleFactor:width===393?3:1,isMobile:width===393,hasTouch:width===393,timezoneId:"UTC"});
 test(`Feed search and Advisor journey at ${width}px`,async({page})=>{
 const errors:string[]=[];page.on("pageerror",error=>{errors.push(error.message);console.error("Preview runtime:",error.message);});
 await page.setViewportSize({width,height:width===393?852:1000});
 await page.route("http://localhost/feed-preview",route=>route.fulfill({contentType:"text/html",body:`<!doctype html><html data-before="${process.env.FEED_SEARCH_BEFORE_SOURCE?'true':'false'}"><head><meta charset="utf-8"><title>One Feed · design preview</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${stripAppFontFaces(fixture.css)+productFontStyle()}body{margin:0;background:var(--background);color:var(--foreground)}</style></head><body><div id="root"></div></body></html>`}));
 await page.route("**/logos/*.svg",route=>route.fulfill({contentType:"image/svg+xml",body:fs.readFileSync(path.join(process.cwd(),"public",new URL(route.request().url()).pathname))}));
 await page.goto("http://localhost/feed-preview");await page.addScriptTag({content:fixture.script});
 await expect(page).toHaveTitle("One Feed · design preview");
 await expect(page.getByRole("heading",{name:"Feed",exact:true})).toBeVisible();
 const shot=async(name:string)=>{await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:test.info().outputPath(`${name}-${width}.png`),animations:"disabled"});};
 if(process.env.FEED_SEARCH_BEFORE_SOURCE){await shot("before");expect(errors).toEqual([]);return;}
 await expect(page.getByRole("search")).toHaveCount(0);await expect(page.getByText("Emergency alert from Ankit",{exact:true})).toHaveCount(2);await shot("01-mixed");
 await page.getByRole("button",{name:"Search Feed",exact:true}).click();const scope=page.getByRole("combobox",{name:"Agent scope"});await scope.selectOption("location");
 await expect(page.getByRole("button",{name:"Remove Location scope"})).toBeVisible();await expect(page.getByText("Your AAPL analysis is ready",{exact:false})).toHaveCount(0);await shot("02-location");
 const query=page.getByRole("textbox",{name:"Search Feed"});await query.fill("Ank");await expect(page.getByText("Location sharing with Ankit Kumar Singh expired",{exact:false})).toBeVisible();await shot("03-person");
 await page.getByRole("button",{name:"Open Location sharing with Ankit Kumar Singh expired",exact:true}).click();await expect(page.getByRole("heading",{name:"Location share"})).toBeVisible();await shot("04-result");
 await page.getByRole("button",{name:"Back to Feed"}).click();await expect(query).toHaveValue("Ank");await expect(scope).toHaveValue("location");await shot("05-return");
 await page.getByRole("button",{name:"Clear search",exact:true}).first().click();await expect(query).toHaveValue("");await expect(scope).toHaveValue("location");await page.getByRole("button",{name:"Remove Location scope"}).click();await expect(scope).toHaveValue("");await shot("06-all");
 await page.getByRole("button",{name:"Switch persona"}).click();await page.getByRole("button",{name:"Search Feed",exact:true}).click();await scope.selectOption("advisor");await query.fill("Ank");await expect(page.getByLabel("Top Hit")).toContainText("Ankit Kumar Singh");await shot("07-advisor");
 await page.getByRole("button",{name:"Ankit Kumar Singh",exact:true}).click();await expect(page.getByRole("heading",{name:"Client workspace"})).toBeVisible();await expect(page.locator("code")).toContainText("/ria/clients/preview-investor?from=%2Fone%2Ffeed");await shot("08-client");
 expect(errors).toEqual([]);
});
});
