import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
} from "@/components/ui/drawer";

describe("DrawerDescription", () => {
  it("renders as a paragraph element", () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerDescription>
            Drawer description
          </DrawerDescription>
        </DrawerContent>
      </Drawer>,
    );

    expect(
      screen.getByText("Drawer description").tagName,
    ).toBe("P");
  });
});