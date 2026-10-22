import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DurationSelector } from "../../components/one-location/redesign/selectors";
import { CHANGE_TIME_DURATION_LADDER, SHARE_DURATION_UNTIL_STOP_VALUE } from "../../components/one-location/redesign/duration-presets";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { CircleInvitePeopleSheet } from "../../components/one-location/redesign/circles/circle-grow-actions";
import { CreateCirclePeopleStep } from "../../components/one-location/redesign/circles/create-circle-people-step";
import { ContactRow } from "../../components/one-location/redesign/contact-picker/atoms";

const people = ["Al", "Divya Rajendran", "Jhumma Kumari", "Priyanka Venkataraman-Sundaram"].map((displayName, index) => ({
  userId: `person-${index}`, displayName, connectedFromContacts: true,
}));
const loadPeople = async () => ({ eligibleConnections: people, pendingInvites: [], remainingCapacity: 9 });
const noop = () => {};
const noopAsync = async () => {};

function Fixture() {
  const current = new URLSearchParams(window.location.search).has("current");
  const [value, setValue] = useState(current ? "0.5" : "2");
  const [selected, setSelected] = useState<string | null>(null);
  const picker = new URLSearchParams(window.location.search).get("people");
  if (picker === "create") {
    return <Dialog modal open><DialogContent className="sm:max-w-2xl [&:has([data-circle-create-step=people])>[data-slot=dialog-header]]:sr-only">
      <DialogHeader><DialogTitle>Create a Circle</DialogTitle></DialogHeader>
      <div data-circle-create-step="people" className="flex min-h-0 flex-1 flex-col"><div className="flex min-h-0 flex-1 flex-col">
      <CreateCirclePeopleStep circleId="new" circleName="Family" active onBack={noop} onSavingChange={noop}
        onLoad={async () => ({ eligibleConnections: Array.from({ length: 45 }, (_, index) => ({ userId: `person-${index}`, connectionId: `connection-${index}`, displayName: `Person ${index}`, connectedFromContacts: true })), pendingInvites: [], remainingCapacity: 99, hasMore: false, page: 1, totalCount: 45 })}
        onAdd={noopAsync} onComplete={noop} /></div></div>
    </DialogContent></Dialog>;
  }
  if (picker === "invite") {
    return <CircleInvitePeopleSheet open onOpenChange={noop} circleId="circle" circleName="SMS Circle"
      onLoadEligibleConnections={loadPeople} onInviteConnections={noopAsync} onCancelMemberInvite={noopAsync} />;
  }
  if (picker === "sms") {
    return <main className="mx-auto w-full max-w-[640px] px-4 py-8">
      {people.map((person, index) => <ContactRow key={person.userId} label={person.displayName}
        subtitle={index % 2 ? "Connected on One" : null} fromContacts selected={selected === person.userId}
        busy={false} ready onAdd={() => setSelected(person.userId)} onRemove={() => setSelected(null)} />)}
    </main>;
  }
  const options = [
    ...(current ? [{ value: "0.5", label: "Current · 30 min" }] : []),
    ...CHANGE_TIME_DURATION_LADDER,
    { value: SHARE_DURATION_UNTIL_STOP_VALUE, label: "Until I stop" },
  ];
  return (
    <Dialog open modal>
      <DialogContent className="max-w-[min(420px,calc(100%-2rem))] gap-4 rounded-[24px] p-4 sm:max-w-[420px]">
        <DialogHeader className="text-left">
          <DialogTitle>Change end time</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <DurationSelector value={value} onChange={setValue} options={options}
            presentation="select" label="New time" hint="Ends 6:13 PM" maxWidthClassName={null} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost">Cancel</Button>
            <Button>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
