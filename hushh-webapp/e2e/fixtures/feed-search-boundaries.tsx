// Synthetic provider/session ports for the isolated DESIGN PREVIEW only.
import React, { useSyncExternalStore } from "react";
import type { FeedItem } from "../../lib/services/feed-service";
import { feedItemScope } from "../../lib/feed/agent-scopes";
const base = { read: true, created_at: "2026-11-19T08:12:00Z", metadata: {} };
export const records: FeedItem[] = [
  { ...base,id:"1001",activity_group_id:"location-grant:preview-alex",source_domain:"location",event_type:"location_share_revoked",actor_label:"Alex",metadata:{counterpart_label:"Alex",feed_audience:"owner",reason:"owner_revoke"} },
  { ...base,id:"1002",activity_group_id:"finance-analysis:preview-aapl",source_domain:"kai",event_type:"kai_analysis_completed",actor_label:null,metadata:{ticker:"AAPL",run_id:"preview-aapl"},created_at:"2026-11-19T07:45:00Z" },
  { ...base,id:"1003",activity_group_id:"location-grant:preview-ankit",source_domain:"location",event_type:"location_share_expired",actor_label:"Ankit Kumar Singh",metadata:{counterpart_label:"Ankit Kumar Singh"},created_at:"2026-10-03T12:00:00Z" },
  { ...base,id:"1004",activity_group_id:"kyc-workflow:preview-kyc",source_domain:"gmail",subagent_id:"agent_kyc",event_type:"mail_message_sent",actor_label:null,metadata:{workflow_id:"preview-kyc"},created_at:"2026-10-02T11:00:00Z" },
  { ...base,id:"1005",activity_group_id:"connection:preview-connect",source_domain:"connections",event_type:"connection_accepted",actor_label:"Maya Patel",created_at:"2026-10-01T10:00:00Z" },
];
let state = { path:"/one/feed", persona:"investor" as "investor"|"ria", revision:0 };
const listeners=new Set<()=>void>();
export function change(update:Partial<typeof state>){state={...state,...update,revision:state.revision+1};listeners.forEach(fn=>fn());}
export function useFixture(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>state);}
export const router={push(href:string){change({path:href});}};
export const useRouter=()=>router;
export const usePathname=()=>state.path.split("?")[0];
export const useSearchParams=()=>new URLSearchParams(state.path.split("?")[1]);
export const useBackLayer=()=>{};
export const unwindBackLayer=()=>false;
export const useLocalOnboardingActionHandler=()=>{};
export const FeedFinanceSearch=()=>null;
export const FeedDriveSearch=()=>null;
export const FeedService={async searchActivity({query}:{query:{scope?:string;query?:string}}){
  const term=(query.query||"").toLocaleLowerCase();
  const items=records.filter(item=>(!query.scope||feedItemScope(item)===query.scope)&&(!term||[item.actor_label,item.metadata.ticker,item.event_type].join(" ").toLowerCase().includes(term)));
  const client=state.persona==="ria"&&query.scope==="advisor"&&term.startsWith("ank");
  return {items,next_cursor:null,top_hit:client?{kind:"client",label:"Ankit Kumar Singh",href:"/ria/clients/preview-investor?from=%2Fone%2Ffeed"}:null,suggestion:term==="ankti"?"ankit":null};
}};
export const DirectMessageLink=React.forwardRef<HTMLAnchorElement,React.AnchorHTMLAttributes<HTMLAnchorElement>>(function Link({href,children,...props},ref){return <a {...props} ref={ref} href={href} onClick={event=>{event.preventDefault();router.push(href!);}}>{children}</a>;});
export default DirectMessageLink;

export const AuthService={getIdToken:async()=>{throw new Error("Live auth is unavailable in this synthetic preview");}};

export const useContactNameSearch=()=>async(query:string)=>({query});
export const PRIVATE_NAMES_CHANGED="one:private-contact-names-changed";
