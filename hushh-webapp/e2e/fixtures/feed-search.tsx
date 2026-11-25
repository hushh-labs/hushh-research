import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppPageShell, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { ShellActionSurfaceBase } from "../../components/app-ui/shell-action-surface-base";
import { SettingsGroup, SettingsPresentationProvider } from "../../components/app-ui/settings-ui";
import { FeedActivitySearch } from "../../components/feed/feed-activity-search";
import { FeedRow } from "../../components/feed/feed-row";
import { FeedActionableRow } from "../../components/feed/feed-actionable-row";
import { LocationAgentIcon } from "../../components/icons/agents";
import { Search } from "../../components/icons";
import { openFeedSearch, resetFeedSearchView } from "../../lib/feed/feed-search-events";
import { consumeFeedSearchReturn, visitFeedSearchRoute, clearFeedSearch } from "../../lib/feed/feed-search-memory";
import { openFeedResult } from "../../lib/feed/result-navigation";
import { records, router, useFixture, change } from "./feed-search-boundaries";
const getToken=async()=>"synthetic-preview-only", isCurrent=()=>true;
function Feed(){
 const state=useFixture();const [initial]=useState(()=>consumeFeedSearchReturn("preview-owner"));
 const [search,setSearch]=useState(Boolean(initial?.open));
 const mode=useCallback((value:boolean)=>setSearch(value),[]);
 return <><header className="mb-5 mt-5 flex items-center justify-between"><h1 className="text-xl font-semibold">Feed</h1>{document.documentElement.dataset.before!=="true"?<ShellActionSurfaceBase aria-label="Search Feed" onClick={openFeedSearch}><Search className="size-5"/></ShellActionSurfaceBase>:null}</header>
 <SettingsGroup title="Live" separatorInset>{["one","two"].map((id,index)=><FeedActionableRow key={id} item={{id:"preview-emergency-"+id,operationKey:"location-grant:emergency-"+id,icon:LocationAgentIcon,scopeId:"location",sourceLabel:"Location",title:"Emergency alert from Ankit",description:"",sortAt:1,displayTimestamp:Date.parse("2026-11-19T09:41:00Z")-index*60000,emphasis:"emergency",actions:[{key:"open",label:"Open",tone:"primary",run:()=>openFeedResult(router,"/one/location?incidentId=preview-"+id)}]}}/>)}</SettingsGroup>
 <FeedActivitySearch ownerId="preview-owner" getToken={getToken} isCurrent={isCurrent} onOpen={item=>openFeedResult(router,"/one/location?grantId="+item.activity_group_id?.split(":")[1])} onModeChange={mode} initial={initial} persona={state.persona}/>
 {!search?<SettingsGroup title="Recent activity" separatorInset>{records.slice(0,4).map(item=><FeedRow key={item.id} item={item} openable onOpen={()=>{}}/>)}</SettingsGroup>:null}</>;
}
function Fixture(){const state=useFixture();visitFeedSearchRoute(state.path.split("?")[0]);const inFeed=state.path==="/one/feed";
 return <SettingsPresentationProvider density="compact"><div data-app-surface="one" data-profile-type-scale="page"><aside className="bg-amber-100 px-4 py-2 text-xs text-amber-950">DESIGN PREVIEW · SYNTHETIC · NOT UAT</aside><AppPageShell width="reading"><AppPageContentRegion>{inFeed?<Feed key={state.persona}/>:<section className="space-y-4 py-5"><h1 className="text-xl font-semibold">{state.path.startsWith("/ria/clients")?"Client workspace":"Location share"}</h1><p className="text-sm">Synthetic destination boundary</p><code className="block break-all text-xs">{state.path}</code><button onClick={()=>change({path:"/one/feed"})}>Back to Feed</button></section>}</AppPageContentRegion></AppPageShell></div><nav aria-label="Preview controls" className="mt-8 flex gap-4 p-4 text-xs"><button onClick={()=>{clearFeedSearch();resetFeedSearchView();change({path:"/one/feed"});}}>Fresh Feed visit</button><button onClick={()=>{clearFeedSearch();change({persona:state.persona==="ria"?"investor":"ria",path:"/one/feed"});}}>Switch persona</button></nav></SettingsPresentationProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
