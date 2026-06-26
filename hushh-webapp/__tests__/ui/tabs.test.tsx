import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

describe("Tabs", () => {
  it("renders root with data-slot='tabs'", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1">
        <TabsList>
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    expect(container.querySelector('[data-slot="tabs"]')).toBeTruthy();
  });

  it("renders TabsList with data-slot='tabs-list'", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1">
        <TabsList>
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    expect(container.querySelector('[data-slot="tabs-list"]')).toBeTruthy();
  });

  it("renders TabsTrigger with data-slot='tabs-trigger'", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1">
        <TabsList>
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    expect(container.querySelector('[data-slot="tabs-trigger"]')).toBeTruthy();
  });

  it("renders TabsContent with data-slot='tabs-content'", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1">
        <TabsList>
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    expect(container.querySelector('[data-slot="tabs-content"]')).toBeTruthy();
  });

  it("passes orientation through as data-orientation on the root", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1" orientation="vertical">
        <TabsList>
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    const root = container.querySelector('[data-slot="tabs"]');
    expect(root?.getAttribute("data-orientation")).toBe("vertical");
  });

  it("propagates variant as data-variant on TabsList", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1">
        <TabsList variant="line">
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    const list = container.querySelector('[data-slot="tabs-list"]');
    expect(list?.getAttribute("data-variant")).toBe("line");
  });

  it("renders disabled TabsTrigger with data-disabled attribute", () => {
    const { container } = render(
      <Tabs defaultValue="tab-1">
        <TabsList>
          <TabsTrigger value="tab-1" disabled>
            Tab 1
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Content 1</TabsContent>
      </Tabs>,
    );

    const trigger = container.querySelector('[data-slot="tabs-trigger"]');

    expect(trigger?.getAttribute("data-disabled")).toBe("");
  });

});