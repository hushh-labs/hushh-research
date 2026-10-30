import { useEffect, useRef, useState } from "react";

import { assetUrl } from "../content";
import { useMotionEnvironment } from "../hooks/useMotionEnvironment";
import type { MascotState } from "../types";

interface OneMascotProps {
  state: MascotState;
  active?: boolean;
  motion?: boolean;
  assetBaseUrl: string;
  className?: string;
}

/** Original transparent artwork plays one three-second cycle, then rests. */
export function OneMascot({
  state,
  active = true,
  motion = true,
  assetBaseUrl,
  className = "",
}: OneMascotProps) {
  const environmentAllowsMotion = useMotionEnvironment();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const play = active && motion && environmentAllowsMotion && !failed && !finished;

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  function onLoaded() {
    setLoaded(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFinished(true), 3000);
  }

  return (
    <div
      className={`ao-mascot ${className}`}
      aria-hidden="true"
      data-mascot={state}
      data-playing={play && loaded}
    >
      {/* Preserve the supplied transparent PNG and animated WebP bytes. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetUrl(`${state}-poster.png`, assetBaseUrl)}
        width={512}
        height={512}
        alt=""
        draggable={false}
        decoding="async"
        className="ao-mascot__poster"
        style={{ opacity: play && loaded ? 0 : 1 }}
      />
      {play ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={assetUrl(`${state}.webp`, assetBaseUrl)}
          width={512}
          height={512}
          alt=""
          draggable={false}
          decoding="async"
          className="ao-mascot__loop"
          onLoad={onLoaded}
          onError={() => setFailed(true)}
          style={{ opacity: loaded ? 1 : 0 }}
        />
      ) : null}
    </div>
  );
}
