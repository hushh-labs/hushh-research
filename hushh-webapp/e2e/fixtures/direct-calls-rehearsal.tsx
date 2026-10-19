import { createRoot } from "react-dom/client";
import { connectAuthEmulator, inMemoryPersistence, setPersistence, signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import { DirectCallControl } from "@/components/direct-messages/direct-call-control";

declare global {
  interface Window {
    callingRehearsalSignIn: (owner: "alice" | "bob", password: string) => Promise<void>;
  }
}

const endpoint = document.body.dataset.authEmulator;
if (!endpoint?.startsWith("http://127.0.0.1:")) throw new Error("An isolated Auth emulator is required.");
connectAuthEmulator(auth, endpoint, { disableWarnings: true });
await setPersistence(auth, inMemoryPersistence);
const root = createRoot(document.getElementById("root")!);
window.callingRehearsalSignIn = async (owner, password) => {
  const { user } = await signInWithEmailAndPassword(auth, `${owner}@calling.invalid`, password);
  if (user.uid !== owner) throw new Error("Synthetic owner mismatch.");
  root.render(<main>
    <h1>Calling rehearsal: {owner}</h1>
    <p>Disposable accounts, real encrypted signaling and relay audio.</p>
    <DirectCallControl ownerId={user.uid} getIdToken={() => user.getIdToken()}
      conversationId="00000000-0000-4000-8000-000000000001" canCall
      peerName={owner === "alice" ? "Synthetic Bob" : "Synthetic Alice"} className="calling-trigger" />
  </main>);
};
