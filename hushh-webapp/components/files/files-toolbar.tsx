"use client";
import {
  Upload,
  RefreshCw,
  Settings2,
  ChevronUp,
  ChevronRight,
  Plus,
  MoreHorizontal,
} from "@/components/icons";
import { ActionMenu } from "@/components/app-ui/action-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type FilesToolbarProps = {
  folders: Array<{ id: string; name: string }>;
  trash: boolean;
  query: string;
  loading: boolean;
  locked: boolean;
  blocked: boolean;
  onUp: () => void;
  onFolder: (index: number) => void;
  onTrash: () => void;
  onSettings: () => void;
  onActivity: () => void;
  onRefresh: () => void;
  onUpload: () => void;
  onNewFolder: () => void;
  onQuery: (query: string) => void;
};
export function FilesToolbar({
  folders,
  trash,
  query,
  loading,
  locked,
  blocked,
  onUp,
  onFolder,
  onTrash,
  onSettings,
  onActivity,
  onRefresh,
  onUpload,
  onNewFolder,
  onQuery,
}: FilesToolbarProps) {
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <nav
          className="flex min-w-0 items-center gap-1"
          aria-label="Folder path"
        >
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label="Up one level"
            disabled={locked || (!trash && folders.length === 1)}
            onClick={onUp}
          >
            <ChevronUp className="size-4" />
          </Button>
          <div className="flex min-w-0 items-center overflow-x-auto">
            {folders.map((folder, index) => (
              <span key={folder.id} className="flex shrink-0 items-center">
                {index > 0 ? (
                  <ChevronRight
                    className="size-3 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="compact"
                  className="max-w-40 truncate"
                  disabled={locked}
                  aria-current={
                    !trash && index === folders.length - 1 ? "page" : undefined
                  }
                  onClick={() => onFolder(index)}
                >
                  {index === 0 ? "All files" : folder.name}
                </Button>
              </span>
            ))}
            {trash ? (
              <span className="flex shrink-0 items-center gap-1 text-sm">
                <ChevronRight className="size-3" />
                Trash
              </span>
            ) : null}
          </div>
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label="File settings"
            onClick={onSettings}
            disabled={loading || locked}
          >
            <Settings2 className="size-4" />
          </Button>
          <ActionMenu
            label="Files options"
            title="Files"
            triggerIcon={MoreHorizontal}
            items={[
              {
                id: "activity",
                label: "Activity",
                onSelect: onActivity,
                disabled: locked,
              },
              {
                id: "trash",
                label: trash ? "All files" : "Trash",
                onSelect: onTrash,
                disabled: loading || locked,
              },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search loaded files"
          placeholder="Search this page"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="basis-full sm:flex-1"
        />
        <Button
          variant="ghost"
          size="icon-touch"
          disabled={loading || locked}
          aria-label="Refresh Files"
          onClick={onRefresh}
        >
          <RefreshCw className="size-4" />
        </Button>
        <Button
          disabled={trash || loading || locked || blocked}
          onClick={onUpload}
        >
          <Upload className="mr-2 size-4" />
          Upload
        </Button>
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label="New folder"
          disabled={trash || loading || locked || blocked}
          onClick={onNewFolder}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </>
  );
}
