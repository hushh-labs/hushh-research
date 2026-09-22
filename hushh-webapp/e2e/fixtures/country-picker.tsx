import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CountryPicker } from "../../components/auth/country-picker";
import { COUNTRY_PHONE_OPTIONS } from "../../lib/constants/country-phone-options";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(COUNTRY_PHONE_OPTIONS.find((item) => item.value === "US")!);
  return <main style={{ padding: 24 }}>
    <h1>Welcome to One</h1>
    <div style={{ width: 108 }}><CountryPicker open={open} onOpenChange={(value) => { setOpen(value); if (value) setQuery(""); }} query={query} onQueryChange={setQuery} selected={selected} options={COUNTRY_PHONE_OPTIONS.filter((item) => `${item.label} ${item.dialCode} ${item.value}`.toLowerCase().includes(query.toLowerCase()))} onSelect={(value) => { setSelected(COUNTRY_PHONE_OPTIONS.find((item) => item.value === value)!); setOpen(false); }} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
