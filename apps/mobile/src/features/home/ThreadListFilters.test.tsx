import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Chip", () => ({
  Chip: (props: { label: string; onPress: () => void }) => (
    <button type="button" onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../workspace/ListFilterMenu", () => ({
  ListFilterMenu: (props: { label: string }) => <span>{props.label}</span>,
}));

import { ThreadListFilters } from "./ThreadListFilters";

const ENVIRONMENT = "env-1" as EnvironmentId;

function render(selection: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
}) {
  const onEnvironmentChange = vi.fn();
  const onProjectChange = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThreadListFilters
        activeOnly
        gutter={0}
        environments={[{ environmentId: ENVIRONMENT, label: "pc" }]}
        projects={[{ key: "cars", label: "cars" }]}
        onEnvironmentChange={onEnvironmentChange}
        onProjectChange={onProjectChange}
        {...selection}
      />,
    ),
  );
  return { container, onEnvironmentChange, onProjectChange, root };
}

it("takes no space while the list is unfiltered", () => {
  const { container, root } = render({ selectedEnvironmentId: null, selectedProjectKey: null });
  expect(container.textContent).toBe("");
  act(() => root.unmount());
});

it("names only the active filter and clears every filter in one tap", () => {
  const { container, onEnvironmentChange, onProjectChange, root } = render({
    selectedEnvironmentId: null,
    selectedProjectKey: "cars",
  });
  expect(container.textContent).toBe("carsShow all threads");
  act(() => container.querySelector("button")?.click());
  expect(onEnvironmentChange).toHaveBeenCalledWith(null);
  expect(onProjectChange).toHaveBeenCalledWith(null);
  act(() => root.unmount());
});
