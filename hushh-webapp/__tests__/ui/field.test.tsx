import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";

describe("Field", () => {
  it("renders root with data-slot='field' and role='group'", () => {
    const { container } = render(<Field>content</Field>);

    const field = container.querySelector('[data-slot="field"]');

    expect(field).toBeTruthy();
    expect(field?.getAttribute("role")).toBe("group");
  });

  it("defaults to data-orientation='vertical'", () => {
    const { container } = render(<Field>content</Field>);

    const field = container.querySelector('[data-slot="field"]');

    expect(field?.getAttribute("data-orientation")).toBe("vertical");
  });

  it("renders FieldSet with data-slot='field-set'", () => {
    const { container } = render(<FieldSet>content</FieldSet>);

    expect(container.querySelector('[data-slot="field-set"]')).toBeTruthy();
  });

  it("renders FieldLegend with data-slot='field-legend'", () => {
    const { container } = render(<FieldLegend>Legend</FieldLegend>);

    expect(
      container.querySelector('[data-slot="field-legend"]'),
    ).toBeTruthy();
  });

  it("renders FieldGroup with data-slot='field-group'", () => {
    const { container } = render(<FieldGroup>content</FieldGroup>);

    expect(
      container.querySelector('[data-slot="field-group"]'),
    ).toBeTruthy();
  });

  it("renders FieldContent with data-slot='field-content'", () => {
    const { container } = render(<FieldContent>content</FieldContent>);

    expect(
      container.querySelector('[data-slot="field-content"]'),
    ).toBeTruthy();
  });

  it("renders FieldTitle with data-slot='field-label'", () => {
    const { container } = render(<FieldTitle>Title</FieldTitle>);

    expect(
      container.querySelector('[data-slot="field-label"]'),
    ).toBeTruthy();
  });

  it("renders FieldLabel with data-slot='field-label'", () => {
    const { container } = render(<FieldLabel>Label</FieldLabel>);

    expect(
      container.querySelector('[data-slot="field-label"]'),
    ).toBeTruthy();
  });

  it("renders FieldDescription with data-slot='field-description'", () => {
    const { container } = render(
      <FieldDescription>Description</FieldDescription>,
    );

    expect(
      container.querySelector('[data-slot="field-description"]'),
    ).toBeTruthy();
  });

  it("renders FieldSet as a fieldset element", () => {
    const { container } = render(<FieldSet>content</FieldSet>);

    const fieldSet = container.querySelector('[data-slot="field-set"]');

    expect(fieldSet?.tagName).toBe("FIELDSET");
  });

});
