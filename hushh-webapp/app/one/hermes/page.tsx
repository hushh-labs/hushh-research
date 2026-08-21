import { HermesConsoleClient } from "./hermes-console-client";

export const metadata = {
  title: "Hermes",
  description: "Your linked Hussh One Hermes machine.",
};

export default function HermesPage() {
  return <HermesConsoleClient />;
}
