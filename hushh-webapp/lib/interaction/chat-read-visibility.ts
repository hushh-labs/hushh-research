import { getVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

/** Check the existing authored/Radix layer owners without observing the body. */
export function chatReadIsBlocked(element: HTMLElement): boolean {
  return Boolean(getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions
    || document.body.style.pointerEvents === "none"
    || element.closest('[inert], [hidden], [aria-hidden="true"]'));
}

export function subscribeChatLayerChanges(listener: () => void): () => void {
  let frame = 0;
  const afterLayerCommit = () => {
    cancelAnimationFrame(frame);
    // Radix emits during registration/cleanup; read after its modal lock settles.
    frame = requestAnimationFrame(listener);
  };
  document.addEventListener("dismissableLayer.update", afterLayerCommit);
  document.addEventListener("focusin", afterLayerCommit);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("dismissableLayer.update", afterLayerCommit);
    document.removeEventListener("focusin", afterLayerCommit);
  };
}
