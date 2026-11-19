"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useVault } from "@/lib/vault/vault-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { readPrivateCheckIn, type CheckInOperation } from "@/lib/one-location/check-in-operations";
import { CheckInFlow } from "./check-in-flow";
import type { LocationHubViewModel } from "./location-redesign-hub";

/** Exact owner receipt. Remaining sends require a fresh review of the point. */
export function CheckInOperationReview({ id, vm, onClose }: {id:string;vm:LocationHubViewModel;onClose:()=>void}) {
  const { vaultOwnerToken } = useVault();
  const epoch = snapshotVaultSessionEpoch();
  const [state,setState] = useState<{id:string;owner:string|null;epoch:number;operation?:CheckInOperation;failed?:boolean}|null>(null);
  const [reviewing,setReviewing] = useState<string|null>(null);
  useBackLayer("/one/location",reviewing===id?3:0,()=>{if(!vm.busy)setReviewing(null);return true;});
  useEffect(()=>{
    if(!vaultOwnerToken || !vm.userId)return;
    let current=true;
    void readPrivateCheckIn(vaultOwnerToken,id).then(operation=>{
      if(current && isVaultSessionEpochCurrent(epoch))setState({id,owner:vm.userId,epoch,operation});
    }).catch(()=>{if(current && isVaultSessionEpochCurrent(epoch))setState({id,owner:vm.userId,epoch,failed:true});});
    return()=>{current=false;};
  },[id,vm.userId,vaultOwnerToken,epoch]);
  const selected=state?.id===id && state.owner===vm.userId && state.epoch===epoch && vaultOwnerToken ? state : null;
  if(!selected)return <p role="status" className="p-4 text-sm text-muted-foreground">Loading Check-In…</p>;
  if(selected.failed || !selected.operation)return <div className="space-y-3 p-4"><p>Check-In history unavailable</p><Button variant="ghost" onClick={onClose}>Back</Button></div>;
  const operation=selected.operation;
  if(reviewing===id)return <CheckInFlow key={operation.id} vm={vm} resumeOperation={operation} onClose={()=>setReviewing(null)} />;
  return <section className="space-y-4 p-4" aria-label="Check-In receipt">
    <h2 className="text-lg font-semibold">{operation.state==="ended"?"Check-In ended":`Sent to ${operation.confirmedCount} of ${operation.intendedCount} people`}</h2>
    <time className="text-xs text-muted-foreground" dateTime={operation.createdAt}>{new Date(operation.createdAt).toLocaleString()}</time>
    <ul className="divide-y">{operation.targets.map(target=><li key={target.userId} className="flex justify-between gap-3 py-3 text-sm"><span>{target.label}</span><span className="text-muted-foreground">{target.status === "unavailable" ? "Unavailable" : target.grantId ? target.status==="active"?"Sent":"Ended" : "Not sent"}</span></li>)}</ul>
    {operation.targets.some(target=>target.status === "pending") ? <Button onClick={()=>setReviewing(id)}>Review remaining</Button> : null}
  </section>;
}
