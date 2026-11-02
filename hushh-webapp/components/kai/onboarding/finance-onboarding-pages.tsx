"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./finance-onboarding.module.css";

/** Animate the stage boundary without mounting a second setup/provider subtree. */
export function FinanceOnboardingPages({
  stage,
  children,
}: {
  stage: number;
  children: ReactNode;
}) {
  const current = useRef<HTMLDivElement | null>(null);
  const outgoing = useRef<HTMLDivElement>(null);
  const snapshot = useRef<HTMLElement | null>(null);
  const previousStage = useRef(stage);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transition, setTransition] = useState<{
    stage: number;
    direction: number;
  } | null>(null);
  const captureBoundary = useCallback(
    (node: HTMLDivElement | null) => {
      // Ref detachment runs before the outgoing DOM is removed. Capture only the
      // illustrative demo: never retain imported portfolio or provider UI content.
      if (
        !node &&
        current.current &&
        stage === 0 &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const clone = current.current.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll("[id]")
          .forEach((el) => el.removeAttribute("id"));
        snapshot.current = clone;
      }
      current.current = node;
    },
    [stage],
  );

  useLayoutEffect(() => {
    const previous = previousStage.current;
    previousStage.current = stage;
    if (previous === stage) return;
    if (timer.current !== null) clearTimeout(timer.current);
    outgoing.current?.replaceChildren();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      snapshot.current = null;
      setTransition(null);
      return;
    }
    if (snapshot.current) outgoing.current?.append(snapshot.current);
    snapshot.current = null;
    setTransition({ stage, direction: stage > previous ? 1 : -1 });
    timer.current = setTimeout(() => {
      outgoing.current?.replaceChildren();
      setTransition(null);
    }, 540);
  }, [stage]);
  useLayoutEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      snapshot.current = null;
      outgoing.current?.replaceChildren();
    },
    [],
  );

  return (
    <div className={styles.pages} data-direction={transition?.direction ?? 1}>
      <div
        ref={outgoing}
        className={transition ? styles.leavingPage : styles.emptyPage}
        inert
        aria-hidden="true"
      />
      <div
        ref={captureBoundary}
        key={stage}
        className={
          transition?.stage === stage ? styles.enteringPage : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
