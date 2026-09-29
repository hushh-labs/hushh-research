import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ByocCloudCard } from "@/components/connections/byoc-cloud-card";
import { ApiService } from "@/lib/services/api-service";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    suggestByocProject: vi.fn(async () => ({ projectId: "suggested-project", displayName: "Suggested" })),
    checkByocProject: vi.fn(async () => ({ valid: true, available: false, reason: "Already exists" })),
  },
}));

it("lets the owner authorize an existing project even when its name is taken", async () => {
  const onProjectNamed = vi.fn();
  render(<ByocCloudCard onProjectNamed={onProjectNamed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Use an existing project" }));
  fireEvent.change(screen.getByTestId("byoc-project-id-input"), { target: { value: "existing-project" } });
  await waitFor(() => expect(ApiService.checkByocProject).toHaveBeenCalledWith("existing-project"));
  fireEvent.click(screen.getByRole("button", { name: "Deploy to your cloud" }));
  expect(onProjectNamed).toHaveBeenCalledWith("existing-project");
  expect(screen.queryByText(/gcloud|terminal|copy script/i)).toBeNull();
});
