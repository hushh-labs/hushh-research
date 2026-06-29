import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";

describe("DrawerTitle", () => {
  it("renders as a heading element", () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>
            Drawer title
          </DrawerTitle>
        </DrawerContent>
      </Drawer>,
    );

    expect(
      screen.getByText("Drawer title").tagName,
    ).toBe("H2");
  });
});