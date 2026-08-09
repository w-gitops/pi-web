// @vitest-environment happy-dom

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { PiWebApp } from "./PiWebApp";

describe("PiWebApp error banner", () => {
  it("lets the user dismiss a persistent ambiguous-delivery warning without reloading", async () => {
    const app = new PiWebApp();
    const warning = "Prompt delivery may be unknown because the connection failed. TypeError: Load failed";
    Reflect.set(app, "state", { ...initialAppState(), error: warning });
    const container = document.createElement("div");
    render(app.render(), container);

    const banner = container.querySelector<HTMLElement>(".app-error");
    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]');
    expect(banner?.textContent).toContain(warning);
    expect(dismiss).not.toBeNull();

    dismiss?.click();
    await Promise.resolve();
    const state: unknown = Reflect.get(app, "state");
    expect(state).toMatchObject({ error: "" });
  });
});
