"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { FeedActivityDetail } from "@/components/feed/feed-activity-detail";
import { AuthService } from "@/lib/services/auth-service";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

/** An ended Live link opens its owned incident receipt, never another person's map. */
export function LocationIncidentReceipt({itemId, owner}:{itemId?:string|null;owner:string|null}) {
  const router=useRouter();
  const episode=useRef({owner,auth:getAuthSessionGeneration(),vault:snapshotVaultSessionEpoch()});
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const current=useCallback(()=>mounted.current && episode.current.owner===owner &&
    episode.current.auth===getAuthSessionGeneration() && isVaultSessionEpochCurrent(episode.current.vault),[owner]);
  const token=useCallback(async()=>{const value=await AuthService.getIdTokenWithRetry();if(!value)throw new Error("Sign in required");return value;},[]);
  if (!owner || !itemId || !/^[1-9][0-9]{0,18}$/.test(itemId)) return <p role="status">This location share ended or is unavailable.</p>;
  return <FeedActivityDetail key={`${owner}:${itemId}`} routePath="/one/location" item={{id:itemId,source_domain:"location",event_type:"location_share_expired",actor_label:null,metadata:{},read:true,created_at:""}}
    getToken={token} isCurrent={current} onClose={()=>router.replace("/one/feed",{scroll:false})} />;
}
