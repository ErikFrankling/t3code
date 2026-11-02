import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Chip } from "../../components/ui/Chip";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import type { HomeHeaderProps } from "./HomeHeader.types";

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentId"
    | "selectedProjectKey"
    | "onEnvironmentChange"
    | "onProjectChange"
  > & {
    /** List padding the scroller bleeds through so pills start where row content does. */
    readonly gutter: number;
    /** Android keeps filters in the header menu, so the row appears only to name an active one. */
    readonly activeOnly?: boolean;
  },
) {
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  const filtered = props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  if (props.activeOnly && !filtered) return null;
  const clearFilters = () => {
    props.onEnvironmentChange(null);
    props.onProjectChange(null);
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, marginHorizontal: -props.gutter }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      {props.activeOnly && props.selectedEnvironmentId === null ? null : (
        <ListFilterMenu
          label={selectedEnvironment?.label ?? "All environments"}
          accessibilityLabel="Filter threads by environment"
          active={selectedEnvironment !== undefined}
          actions={[
            {
              id: "all",
              title: "All environments",
              state: props.selectedEnvironmentId === null ? "on" : "off",
            },
            ...props.environments.map((environment) => ({
              id: JSON.stringify(environment.environmentId),
              title: environment.label,
              state:
                environment.environmentId === props.selectedEnvironmentId
                  ? ("on" as const)
                  : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onEnvironmentChange(null);
            else {
              const environment = props.environments.find(
                (candidate) => JSON.stringify(candidate.environmentId) === id,
              );
              if (environment) props.onEnvironmentChange(environment.environmentId);
            }
          }}
        />
      )}
      {props.activeOnly && props.selectedProjectKey === null ? null : (
        <ListFilterMenu
          label={selectedProject?.label ?? "All projects"}
          accessibilityLabel="Filter threads by project"
          active={selectedProject !== undefined}
          actions={[
            {
              id: "all",
              title: "All projects",
              state: props.selectedProjectKey === null ? "on" : "off",
            },
            ...props.projects.map((project) => ({
              id: JSON.stringify(project.key),
              title: project.label,
              state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onProjectChange(null);
            else {
              const project = props.projects.find(
                (candidate) => JSON.stringify(candidate.key) === id,
              );
              if (project) props.onProjectChange(project.key);
            }
          }}
        />
      )}
      {props.activeOnly ? (
        <Chip
          label="Show all threads"
          icon="xmark"
          accessibilityLabel="Reset thread filters"
          onPress={clearFilters}
        />
      ) : filtered ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={clearFilters}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
