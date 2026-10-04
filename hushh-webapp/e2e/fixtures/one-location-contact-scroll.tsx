import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ContactRow } from "../../components/one-location/redesign/contact-picker/atoms";
import { VirtualContactList } from "../../components/one-location/redesign/contact-picker/virtual-list";
import { usePageEnterAnimation } from "../../lib/morphy-ux/hooks/use-page-enter";

const people = Array.from({ length: 120 }, (_, index) => ({
  id: String(index),
  name: `Person ${String(index).padStart(3, "0")}`,
}));

// Keep the production animation, virtualizer and row measurement together.
// A list rendered alone cannot reproduce the page observer clearing offsets.
function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const presentation = document.body.dataset.presentation === "cards"
    ? "cards"
    : "grouped";
  usePageEnterAnimation(ref, { key: open ? "ask" : "hub" });
  const toggle = (id: string) => setSelected((current) =>
    current.includes(id) ? current.filter((key) => key !== id) : [...current, id],
  );

  return (
    <div ref={ref} className="space-y-3 p-4">
      {open ? (
        <section className="space-y-3">
          <h1>Ask for location</h1>
          <p data-testid="selected-count">{selected.length} selected</p>
          <input aria-label="Search people" value={search}
            onChange={(event) => setSearch(event.target.value)} />
          <VirtualContactList
            items={people.filter((person) => person.name.includes(search))}
            getKey={(person) => person.id}
            testId="scroll-roster"
            ariaLabel="People you can ask"
            presentation={presentation}
            maxHeightClassName="max-h-[52vh]"
            scrollClassName="max-h-[52vh]"
            renderItem={(person) => (
              <>
                <ContactRow label={person.name} fromContacts
                  selected={selected.includes(person.id)} busy={false} ready
                  onAdd={() => toggle(person.id)} onRemove={() => toggle(person.id)} />
                {person.id === "0" && expanded ? (
                  <div className="h-[92px]">Extra details</div>
                ) : null}
              </>
            )}
          />
          <button onClick={() => setExpanded((current) => !current)}>
            Toggle details
          </button>
        </section>
      ) : <button onClick={() => setOpen(true)}>Ask for location</button>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
