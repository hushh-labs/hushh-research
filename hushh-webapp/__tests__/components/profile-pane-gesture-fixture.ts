import { fireEvent } from "@testing-library/react";

export function pull(type: string, target: Element, x: number, y: number, time: number) {
  const point = { identifier: 1, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: [point] },
    timeStamp: { value: time },
  });
  fireEvent(target, event);
}
