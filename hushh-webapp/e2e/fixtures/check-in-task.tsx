import React from "react";
import { createRoot } from "react-dom/client";
import { Sheet, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Dialog, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Drawer, DrawerHeader, DrawerTitle } from "../../components/ui/drawer";
import { AdaptiveSheetContent, TaskDialogContent, TaskDrawerContent, TaskSurfaceBody } from "../../lib/morphy-ux/ui/task-surfaces";
import { NearbyCheckInSheet } from "../../components/one-location/nearby-check-in/nearby-check-in-sheet";
const captureCurrentPosition = async () => ({ latitude: 37.4275, longitude: -122.1697, accuracyM: 9, capturedAt: new Date().toISOString(), sourcePlatform: "web" as const });
const scene = document.body.dataset.scene;
const closeScene = scene === "sheet" ? (
  <Sheet defaultOpen modal><AdaptiveSheetContent><SheetHeader><SheetTitle>Invite code</SheetTitle></SheetHeader>
    <TaskSurfaceBody><p>EXAMPLE-CODE</p></TaskSurfaceBody>
  </AdaptiveSheetContent></Sheet>
) : scene === "dialog" ? (
  <Dialog defaultOpen modal><TaskDialogContent><DialogHeader><DialogTitle>Invite code</DialogTitle></DialogHeader>
    <TaskSurfaceBody><p>EXAMPLE-CODE</p></TaskSurfaceBody>
  </TaskDialogContent></Dialog>
) : scene === "drawer" ? (
  <Drawer defaultOpen><TaskDrawerContent showCloseButton><DrawerHeader><DrawerTitle>Invite code</DrawerTitle></DrawerHeader>
    <TaskSurfaceBody><p>EXAMPLE-CODE</p></TaskSurfaceBody>
  </TaskDrawerContent></Drawer>
) : null;
createRoot(document.getElementById("root")!).render(closeScene ?? (
  <NearbyCheckInSheet open ownerId="fixture-owner" vaultOwnerToken="fixture-owner-token"
    captureCurrentPosition={captureCurrentPosition} onOpenChange={() => undefined} />
));
