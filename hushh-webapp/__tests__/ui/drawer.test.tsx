import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";

describe("DrawerContent", () => {
  it("renders the close button when showCloseButton is true", () => {
    render(
      <Drawer open>
        <DrawerContent showCloseButton>
          <DrawerTitle>Test drawer</DrawerTitle>
        </DrawerContent>
      </Drawer>,
    );

    expect(
      screen.getByRole("button", { name: /close/i }),
    ).toBeTruthy();
  });

  it("hides the close button when showCloseButton is false", () => {
    render(
      <Drawer open>
        <DrawerContent showCloseButton={false}>
          <DrawerTitle>Test drawer</DrawerTitle>
        </DrawerContent>
      </Drawer>,
    );

    expect(screen.getByText("Test drawer")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /close/i }),
    ).toBeNull();
  });
});