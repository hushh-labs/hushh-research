import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";

describe("Avatar", () => {
  it("renders root with data-slot='avatar'", () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>,
    );

    expect(container.querySelector('[data-slot="avatar"]')).toBeTruthy();
  });

  it("defaults root to data-size='default'", () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>,
    );

    const avatar = container.querySelector('[data-slot="avatar"]');

    expect(avatar?.getAttribute("data-size")).toBe("default");
  });

  it("propagates size='lg' as data-size='lg'", () => {
    const { container } = render(
      <Avatar size="lg">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>,
    );

    const avatar = container.querySelector('[data-slot="avatar"]');

    expect(avatar?.getAttribute("data-size")).toBe("lg");
  });

  it("renders fallback with data-slot='avatar-fallback'", () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>,
    );

    expect(
      container.querySelector('[data-slot="avatar-fallback"]'),
    ).toBeTruthy();
  });

  it("renders badge with data-slot='avatar-badge'", () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
        <AvatarBadge />
      </Avatar>,
    );

    expect(
      container.querySelector('[data-slot="avatar-badge"]'),
    ).toBeTruthy();
  });

  it("renders group with data-slot='avatar-group'", () => {
    const { container } = render(
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      </AvatarGroup>,
    );

    expect(
      container.querySelector('[data-slot="avatar-group"]'),
    ).toBeTruthy();
  });

  it("renders group count with data-slot='avatar-group-count'", () => {
    const { container } = render(
      <AvatarGroup>
        <AvatarGroupCount>+3</AvatarGroupCount>
      </AvatarGroup>,
    );

    expect(
      container.querySelector('[data-slot="avatar-group-count"]'),
    ).toBeTruthy();
  });
});