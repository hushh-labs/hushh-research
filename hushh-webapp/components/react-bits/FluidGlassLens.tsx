/*
 * FluidGlassLens — derived from React Bits `FluidGlass` (reactbits.dev),
 * ts-tailwind variant, `lens` mode only.
 * Source: https://github.com/DavidHDev/react-bits — MIT + Commons Clause.
 * Copyright (c) 2026 David Haz. See THIRD_PARTY_NOTICES.md.
 *
 * The upstream component owns an entire page: it wraps everything in
 * `ScrollControls` and renders its own demo `Typography`, `Images` and
 * `NavItems` inside the WebGL scene, with the host page portaled in through
 * `<Scroll html>`. That is not usable here — the welcome screen's copy has to
 * stay real DOM, because the voice surface, the a11y tree, and the SEO
 * markup all read it.
 *
 * So this keeps the part that matters and drops the demo shell:
 *   - the same `lens.glb` geometry, the same pointer damping (`easing.damp3`
 *     at 0.15), and the same `MeshTransmissionMaterial` parameters upstream
 *     uses for `lens` mode (ior 1.15, thickness 5, chromaticAberration 0.1);
 *   - an FBO scene it can actually refract. A transmission material bends
 *     whatever is in its buffer, so with an empty scene the lens is invisible
 *     — hence the aurora planes portaled in below. They are never drawn to
 *     the screen; they exist only to be the thing the glass distorts.
 *
 * The canvas itself stays transparent and non-interactive: the DOM aurora and
 * the page copy show through it untouched, and only the lens is painted.
 */

"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, createPortal, useFrame } from "@react-three/fiber";
import { useFBO, useGLTF, Preload } from "@react-three/drei";
import { MeshTransmissionMaterial } from "@react-three/drei";
import { easing } from "maath";
import * as THREE from "three";

const LENS_GLB = "/assets/3d/lens.glb";

/** Reads a CSS custom property off <html>, with a literal fallback. */
function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * A soft radial falloff as a texture. This is the WebGL equivalent of the
 * blurred blobs in LandingAurora — same idea, but inside the scene so the
 * lens has colour to bend. Drawn once into a 128px canvas: it is only ever
 * sampled through a heavy refraction, so resolution beyond that is wasted.
 */
function useBlobTexture(color: string) {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const gradient = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2
    );
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.45, color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, [color]);
}

function Blob({
  color,
  position,
  scale,
  opacity,
}: {
  color: string;
  position: [number, number, number];
  scale: number;
  opacity: number;
}) {
  const texture = useBlobTexture(color);
  if (!texture) return null;

  return (
    <mesh position={position} scale={scale}>
      <planeGeometry />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

/** The offscreen backdrop. Never rendered to the screen — only into the FBO
 *  the transmission material samples. */
function AuroraScene() {
  const accent = cssVar("--app-accent", "#007aff");
  const bright = cssVar("--app-accent-bright", "#4a9eff");
  const deep = cssVar("--app-accent-hero-from", "#0a2f5e");

  return (
    <>
      <Blob color={accent} position={[-1.6, 1.1, 0]} scale={3.4} opacity={0.9} />
      <Blob color={bright} position={[1.7, 0.6, 0]} scale={3.8} opacity={0.75} />
      <Blob color={deep} position={[0.2, -1.6, 0]} scale={4.2} opacity={0.7} />
    </>
  );
}

function Lens() {
  const ref = useRef<THREE.Mesh>(null!);
  const { nodes } = useGLTF(LENS_GLB);
  const buffer = useFBO();
  const [scene] = useState<THREE.Scene>(() => new THREE.Scene());
  const geoWidthRef = useRef<number>(1);

  const baseColor = useMemo(
    () => new THREE.Color(cssVar("--landing-canvas", "#0b0b0d")),
    []
  );

  useEffect(() => {
    const geo = (nodes.Cylinder as THREE.Mesh | undefined)?.geometry;
    if (!geo) return;
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    geoWidthRef.current = box ? box.max.x - box.min.x || 1 : 1;
  }, [nodes]);

  useFrame((state, delta) => {
    const { gl, viewport, pointer, camera } = state;
    const v = viewport.getCurrentViewport(camera, [0, 0, 15]);

    // Same damping constant upstream uses, so the lens trails the pointer
    // with the same weight it has on reactbits.dev.
    easing.damp3(
      ref.current.position,
      [(pointer.x * v.width) / 2, (pointer.y * v.height) / 2, 15],
      0.15,
      delta
    );

    const desired = (v.width * 0.9) / geoWidthRef.current;
    ref.current.scale.setScalar(Math.min(0.15, desired));

    // Render the aurora into the FBO the transmission material refracts.
    // An opaque clear here gives the glass a body to distort; the main pass
    // is then cleared back to fully transparent so the canvas never paints
    // over the DOM behind it.
    gl.setRenderTarget(buffer);
    gl.setClearColor(baseColor, 1);
    gl.clear();
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    gl.setClearColor(0x000000, 0);
  });

  return (
    <>
      {createPortal(<AuroraScene />, scene)}
      <mesh
        ref={ref}
        scale={0.15}
        rotation-x={Math.PI / 2}
        geometry={(nodes.Cylinder as THREE.Mesh | undefined)?.geometry}
      >
        <MeshTransmissionMaterial
          buffer={buffer.texture}
          ior={1.15}
          thickness={5}
          anisotropy={0.01}
          chromaticAberration={0.1}
        />
      </mesh>
    </>
  );
}

/**
 * Mounts the lens over the page. Absent entirely on touch devices (nothing to
 * follow) and under reduced motion (the effect *is* the motion) — decided
 * once, before the canvas is created, so no WebGL context is allocated on a
 * device that will not use it.
 */
export default function FluidGlassLens() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    setEnabled(finePointer.matches && !reducedMotion.matches);
  }, []);

  if (!enabled) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[5]"
      data-fluid-glass-lens
    >
      <Canvas camera={{ position: [0, 0, 20], fov: 15 }} gl={{ alpha: true }}>
        <Suspense fallback={null}>
          <Lens />
          <Preload all />
        </Suspense>
      </Canvas>
    </div>
  );
}

useGLTF.preload(LENS_GLB);
