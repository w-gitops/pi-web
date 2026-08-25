import { describe, expect, it } from "vitest";
import type { ReactiveControllerHost } from "lit";
import {
  defaultNavigationSection,
  expandedNavigationSection,
  INITIAL_DESKTOP_COLLAPSED_NAVIGATION_SECTIONS,
  isNavigationSectionCollapsed,
  NavigationSectionsController,
  toggleCollapsedNavigationSection,
  toggleNavigationSection,
} from "./navigationState";

describe("navigationState", () => {
  it("defaults to the first incomplete selection section", () => {
    expect(defaultNavigationSection({ selectedProject: undefined, selectedWorkspace: undefined })).toBe("projects");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: undefined })).toBe("workspaces");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: {} })).toBe("sessions");
  });

  it("expands the default section until the user explicitly toggles a section", () => {
    const state = { selectedProject: {}, selectedWorkspace: undefined };

    expect(expandedNavigationSection(undefined, state)).toBe("workspaces");
    expect(expandedNavigationSection("sessions", state)).toBe("sessions");
    expect(expandedNavigationSection("none", state)).toBeUndefined();
  });

  it("uses the mobile accordion state on mobile layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: true, expanded: "sessions", state })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: true, expanded: "sessions", state })).toBe(false);
  });

  it("uses independent collapsed sections on desktop layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state })).toBe(false);
    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(false);
  });

  it("toggles the effective mobile section, including the implicit default section", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection(undefined, "projects", { isMobileLayout: true, state })).toBe("none");
    expect(toggleNavigationSection("none", "projects", { isMobileLayout: true, state })).toBe("projects");
    expect(toggleNavigationSection("projects", "workspaces", { isMobileLayout: true, state })).toBe("workspaces");
  });

  it("does not mutate expanded section on desktop layouts", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection("projects", "projects", { isMobileLayout: false, state })).toBe("projects");
  });

  it("toggles desktop sections independently", () => {
    expect(toggleCollapsedNavigationSection([], "projects")).toEqual(["projects"]);
    expect(toggleCollapsedNavigationSection(["machines", "projects"], "projects")).toEqual(["machines"]);
    expect(toggleCollapsedNavigationSection(["sessions"], "machines")).toEqual(["machines", "sessions"]);
  });

  it("starts Projects and Workspaces collapsed on desktop", () => {
    expect(INITIAL_DESKTOP_COLLAPSED_NAVIGATION_SECTIONS).toEqual(["projects", "workspaces"]);

    const controller = createNavigationSectionsController({
      selectedProject: {},
      selectedWorkspace: {},
      isMobileLayout: false,
    });

    expect(controller.isCollapsed("projects")).toBe(true);
    expect(controller.isCollapsed("workspaces")).toBe(true);
    expect(controller.isCollapsed("machines")).toBe(false);
    expect(controller.isCollapsed("sessions")).toBe(false);
  });

  it("lets desktop users expand Projects or Workspaces until the next page load", () => {
    const controller = createNavigationSectionsController({
      selectedProject: {},
      selectedWorkspace: {},
      isMobileLayout: false,
    });

    controller.toggle("projects");

    expect(controller.isCollapsed("projects")).toBe(false);
    expect(controller.isCollapsed("workspaces")).toBe(true);
  });

  it("keeps the mobile accordion independent of the desktop start-collapsed list", () => {
    const nothingSelected = createNavigationSectionsController({
      selectedProject: undefined,
      selectedWorkspace: undefined,
      isMobileLayout: true,
    });
    const bothSelected = createNavigationSectionsController({
      selectedProject: {},
      selectedWorkspace: {},
      isMobileLayout: true,
    });

    expect(nothingSelected.isCollapsed("projects")).toBe(false);
    expect(nothingSelected.isCollapsed("workspaces")).toBe(true);
    expect(bothSelected.isCollapsed("projects")).toBe(true);
    expect(bothSelected.isCollapsed("workspaces")).toBe(true);
    expect(bothSelected.isCollapsed("sessions")).toBe(false);
  });
});

function createNavigationSectionsController(options: {
  selectedProject: object | undefined;
  selectedWorkspace: object | undefined;
  isMobileLayout: boolean;
}): NavigationSectionsController {
  return new NavigationSectionsController(
    fakeReactiveControllerHost(),
    () => ({ selectedProject: options.selectedProject, selectedWorkspace: options.selectedWorkspace }),
    () => options.isMobileLayout,
  );
}

function fakeReactiveControllerHost(): ReactiveControllerHost {
  return {
    addController() {
      return;
    },
    removeController() {
      return;
    },
    requestUpdate() {
      return;
    },
    get updateComplete() {
      return Promise.resolve(true);
    },
  };
}
