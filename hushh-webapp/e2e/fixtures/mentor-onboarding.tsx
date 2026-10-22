import { useState } from "react";
import { createRoot } from "react-dom/client";

import { AgentOneOnboarding } from "../../components/onboarding/mentor-onboarding/AgentOneOnboarding";

function Fixture() {
  const [index, setIndex] = useState(0);
  return <AgentOneOnboarding index={index} onIndexChange={setIndex} onComplete={(reason) => { document.documentElement.dataset.completed = reason; }} />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
