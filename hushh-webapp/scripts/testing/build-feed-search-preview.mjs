/** Isolated production-component layout harness, never a live UAT environment. */
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { Scanner } from "@tailwindcss/oxide";
import { compile } from "tailwindcss";

export async function buildFeedSearchPreview(outDir, beforeSource) {
  const root=process.cwd(), boundary=path.join(root,"e2e/fixtures/feed-search-boundaries.tsx");
  const overrides={
    "lib/services/feed-service.ts":"FeedService",
    "lib/feed/use-contact-name-search.ts":"useContactNameSearch",
    "lib/connections/private-contact-names.ts":"PRIVATE_NAMES_CHANGED",
    "lib/services/auth-service.ts":"AuthService",
    "components/feed/feed-finance-search.tsx":"FeedFinanceSearch",
    "lib/navigation/back-layers.tsx":"useBackLayer,unwindBackLayer",
    "lib/navigation/back-layers.ts":"useBackLayer,unwindBackLayer",
    "lib/agent/local-onboarding-actions.ts":"useLocalOnboardingActionHandler",
    "components/direct-messages/direct-message-link.tsx":"DirectMessageLink",
  };
  const scanner=new Scanner({}), candidates=new Set();
  await build({configFile:false,logLevel:"error",oxc:{jsx:{runtime:"automatic"}},resolve:{alias:[{find:"@",replacement:root}]},define:{"process.env.NODE_ENV":JSON.stringify("production"),"process.env":"{}"},plugins:[{
    name:"feed-preview-provider-boundaries",enforce:"pre",
    load(id){const clean=id.split("?")[0], relative=path.relative(root,clean).split(path.sep).join("/");
      if(beforeSource&&relative==="components/feed/feed-activity-search.tsx")return fs.readFileSync(beforeSource,"utf8");
      if(overrides[relative])return `export {${overrides[relative]}} from ${JSON.stringify(boundary)};`;
      if(clean.endsWith("/node_modules/next/navigation.js"))return `export {useRouter,usePathname,useSearchParams} from ${JSON.stringify(boundary)};`;
      if(clean.endsWith("/node_modules/next/link.js"))return `export {default} from ${JSON.stringify(boundary)};`;
    },
    transform(source,id){if(!id.includes("node_modules")&&/\.[tj]sx?$/.test(id))for(const token of scanner.scanFiles([{content:source,extension:"tsx"}]))candidates.add(token);},
  }],build:{outDir,emptyOutDir:false,lib:{entry:path.join(root,"e2e/fixtures/feed-search.tsx"),name:"FeedPreview",formats:["iife"],fileName:()=>"fixture.js"}}});
  const compiler=await compile(fs.readFileSync(path.join(root,"app/globals.css"),"utf8").replace(/^@source\s+[^;]+;\s*$/gm,""),{base:path.join(root,"app"),async loadStylesheet(id,base){const file=id==="tailwindcss"?path.join(root,"node_modules/tailwindcss/index.css"):id==="tw-animate-css"?path.join(root,"node_modules/tw-animate-css/dist/tw-animate.css"):path.resolve(base,id);return {path:file,base:path.dirname(file),content:fs.readFileSync(file,"utf8")};}});
  return {script:fs.readFileSync(path.join(outDir,"fixture.js"),"utf8"),css:compiler.build([...candidates])};
}
