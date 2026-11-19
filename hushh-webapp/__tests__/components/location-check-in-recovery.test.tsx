import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import { useLocationRequestReviews } from "@/lib/one-location/use-request-reviews";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";
import type { CheckInOperation } from "@/lib/one-location/check-in-operations";

vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: () => {}, canonicalActionBinding: JSON.stringify }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/observability/location-events", () => ({ trackLocationShareConfirmed: vi.fn() }));
vi.mock("@/components/one-location/redesign/contact-picker/check-in-contact-row", () => ({ ContactRow: ({ label, checked }: {label:string;checked:boolean}) => <span data-selected={checked}>{label}</span> }));

it("resumes the immutable operation with only remaining recipients through a new review", async () => {
  const person = (userId:string) => ({ userId, displayName:userId, keyId:`key-${userId}`, canReceiveLocation:true });
  const pending = ["Maya", "Circle-only"];
  const operation = { id:"operation",clientOperationId:"original-check-in",state:"partial",sourceCircleId:"circle",durationHours:2,
    targets:[{userId:"Already-sent",grantId:"saved",status:"active"}, ...pending.map(userId=>({userId,grantId:null,status:"pending"}))] } as CheckInOperation;
  const onCheckIn=vi.fn().mockResolvedValue({succeededRecipientIds:[],failedRecipientIds:pending});
  const vm={ userId:"owner", busy:null,circles:[],sosRecipients:[person("Unrelated"),person("Maya"),person("Already-sent")],activeOwnerGrants:[],
    recipientLabel:(value:{userId:string})=>value.userId,isRecipientShareReady:()=>true,
    myLocationPoint:{latitude:0,longitude:0,capturedAt:new Date().toISOString()},myLocationError:null,
    renderMapPreview:()=>null,onCheckIn,onDiscardPrivateCheckInOperation:vi.fn(),formatDateTime:()=>"Today",
    onResolveNamedCircleRecipients:vi.fn().mockResolvedValue({circle:{id:"circle"},ready:[{recipient:person("Circle-only")},{recipient:person("Unrelated")}],excluded:[]}),
  } as unknown as LocationHubViewModel;
  render(<CheckInFlow vm={vm} resumeOperation={operation} onClose={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText("Circle-only")).toHaveAttribute("data-selected","true"));
  expect(screen.getByText("Maya")).toHaveAttribute("data-selected","true");
  expect(screen.queryByText("Unrelated")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Check in with 2 people"}));
  await waitFor(()=>expect(onCheckIn).toHaveBeenCalledOnce());
  expect(onCheckIn.mock.calls[0][0]).toMatchObject({recipientIds:pending,clientOperationId:"original-check-in",sourceCircleId:"circle"});
  fireEvent.click(screen.getByRole("button",{name:"Edit and confirm again"}));
  fireEvent.click(screen.getByRole("button",{name:"Check in with 2 people"}));
  await waitFor(()=>expect(onCheckIn).toHaveBeenCalledTimes(2));
  expect(onCheckIn.mock.calls[1][0]).toMatchObject({recipientIds:pending,clientOperationId:"original-check-in"});
});

it("removes a stale approval until its exact reviewed terms have refreshed", () => {
  const request={id:"request",ownerUserId:"owner",status:"pending",requestRevision:1,expiresAt:null,extendsGrantId:"grant",extendsGrantExpiresAt:"2026-11-20T12:00:00Z"} as OneLocationAccessRequest;
  const {result,rerender}=renderHook(({value})=>useLocationRequestReviews([value],"owner",Date.now()),{initialProps:{value:request}});
  expect(result.current.pending).toHaveLength(1); // negative control: the original review was actionable
  act(()=>result.current.invalidate(request));
  rerender({value:{...request}});
  expect(result.current.pending).toHaveLength(0);
  rerender({value:{...request,extendsGrantExpiresAt:"2026-11-20T13:00:00Z"}});
  expect(result.current.pending).toHaveLength(1);
});
