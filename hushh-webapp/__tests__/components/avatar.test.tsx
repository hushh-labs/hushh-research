import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

describe("Avatar", () => {
  it("renders with data-slot=avatar", () => {
    const { container } = render(
      <Avatar><AvatarFallback>AB</AvatarFallback></Avatar>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("avatar");
  });

  it("renders with default size data attribute", () => {
    const { container } = render(
      <Avatar><AvatarFallback>AB</AvatarFallback></Avatar>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("default");
  });

  it("renders with sm size data attribute", () => {
    const { container } = render(
      <Avatar size="sm"><AvatarFallback>AB</AvatarFallback></Avatar>
    );
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("sm");
  });
});
