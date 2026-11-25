import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LegacyTodoPage from "@/app/one/todos/page";

const nav = vi.hoisted(() => ({ redirect: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: nav.redirect, useRouter: () => ({ replace: nav.replace }) }));

afterEach(() => vi.unstubAllEnvs());

it("sends old web links directly to the canonical Tasks route", () => {
  vi.stubEnv("CAPACITOR_BUILD", "false");
  LegacyTodoPage();
  expect(nav.redirect).toHaveBeenCalledWith("/one/tasks");
});

it("replaces the old link in the static native app without leaving a redirect in Back history", () => {
  vi.stubEnv("CAPACITOR_BUILD", "true");
  render(<LegacyTodoPage />);
  expect(nav.replace).toHaveBeenCalledWith("/one/tasks");
});
