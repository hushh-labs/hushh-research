import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionMenu } from "../../components/app-ui/action-menu";
import { FilesMoveDialog } from "../../components/files/files-workspace-dialogs";
import type { FileEdit } from "../../components/files/files-entry-row";
import { file } from "./files-move-boundaries";

function Fixture() {
  const [edit, setEdit] = useState<FileEdit | null>(null);
  const [loading, setLoading] = useState(false);
  const [signal] = useState(() => new AbortController().signal);
  const [saved, setSaved] = useState("");
  return <>
    <ActionMenu label="File actions" items={[{ id: "move", label: "Move", onSelect: () => setEdit({ entry: file, operation: "move", value: "root" }) }]} />
    <FilesMoveDialog edit={edit} busy={false} loading={loading} signal={signal}
      onCancel={() => setEdit(null)} onLoadingChange={setLoading}
      onDestinationChange={value => setEdit(previous => previous ? { ...previous, value } : null)}
      onSave={() => { setSaved(edit?.value ?? ""); setEdit(null); }} />
    <output data-testid="saved-destination">{saved}</output>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
