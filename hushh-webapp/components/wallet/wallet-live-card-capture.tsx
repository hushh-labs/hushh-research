"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";

/** Rear-camera capture in the current page, with no new browser tab or upload. */
export function WalletLiveCardCapture({ onPhoto, onCancel }: { onPhoto: (photo: Blob) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null), active = useRef(true);
  const cancel = useRef(onCancel);
  useLayoutEffect(() => { cancel.current = onCancel; }, [onCancel]);
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const stopCapture = () => { active.current = false; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (video.current) video.current.srcObject = null; };
  useEffect(() => {
    active.current = true;
    let disposed = false;
    const stop = () => { disposed = true; active.current = false; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (video.current) video.current.srcObject = null; };
    if (!navigator.mediaDevices?.getUserMedia) setFailed(true);
    else void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).then(value => {
      if (disposed) { value.getTracks().forEach(track => track.stop()); return; }
      stream.current?.getTracks().forEach(track => track.stop()); stream.current = value; if (video.current) video.current.srcObject = value;
    }).catch(() => { if (!disposed) setFailed(true); });
    const hidden = () => { if (document.visibilityState === "hidden") { stop(); cancel.current(); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { stop(); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  return <section aria-label="Photograph your card" className="space-y-3">
    <div className="relative aspect-[1.586] overflow-hidden rounded-2xl bg-black">
      <video ref={video} autoPlay playsInline muted className="h-full w-full object-cover" onLoadedMetadata={() => setReady(true)} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-[8%] rounded-2xl border-2 border-white/90" />
    </div>
    <p role="status" className={TYPOGRAPHY_CLASSNAMES.helperText}>{failed ? "Camera unavailable. Choose a photo or enter your card details." : "Place your card inside the frame."}</p>
    <div className="flex justify-center gap-2"><Button type="button" size="compact" disabled={!ready || failed || busy} onClick={() => {
      const element = video.current; if (!element?.videoWidth || busy) return;
      setBusy(true); const canvas = document.createElement("canvas"), scale = Math.min(1, 2400 / Math.max(element.videoWidth, element.videoHeight));
      canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => { canvas.width = canvas.height = 0; if (!active.current) return; if (blob) { stopCapture(); onPhoto(blob); } else { setFailed(true); setBusy(false); } }, "image/jpeg", .9);
    }}>Take photo</Button><Button type="button" variant="ghost" size="compact" onClick={() => { stopCapture(); onCancel(); }}>Cancel</Button></div>
  </section>;
}
