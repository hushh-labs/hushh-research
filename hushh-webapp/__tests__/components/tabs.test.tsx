import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

describe("Tabs", () => {
  it("renders with data-slot=tabs", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Tab A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
      </Tabs>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("tabs");
  });

  it("renders with horizontal orientation by default", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Tab A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
      </Tabs>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-orientation")).toBe("horizontal");
  });
});
