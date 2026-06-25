import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

describe("AlertDialogContent", () => {
  
  it("renders with data-slot='alert-dialog-content'", () => {
    const { baseElement } = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Test</AlertDialogTitle>
          <AlertDialogDescription>Description</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(
      baseElement.querySelector('[data-slot="alert-dialog-content"]'),
    ).toBeTruthy();
  });

  it("renders the cancel button", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  it("renders the action button", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
  });
});
describe("AlertDialogHeader", () => {
  it("renders with data-slot='alert-dialog-header'", () => {
    const { container } = render(
      <AlertDialogHeader>Header content</AlertDialogHeader>,
    );

    expect(
      container.querySelector('[data-slot="alert-dialog-header"]'),
    ).toBeTruthy();
  });
});

describe("AlertDialogFooter", () => {
  it("renders with data-slot='alert-dialog-footer'", () => {
    const { container } = render(
      <AlertDialogFooter>Footer content</AlertDialogFooter>,
    );

    expect(
      container.querySelector('[data-slot="alert-dialog-footer"]'),
    ).toBeTruthy();
  });
});