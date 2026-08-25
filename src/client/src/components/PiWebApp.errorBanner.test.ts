// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { PiWebApp, validatedSameOriginReturnUrl } from "./PiWebApp";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

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

  it("enters auth-required once, shows non-dismissible Reauthenticate, and navigates only on click", () => {
    const app = new PiWebApp();
    const recoveryStop = vi.fn();
    Reflect.set(app, "browserConnectionRecovery", { stop: recoveryStop, start: vi.fn(), isRecovering: () => false });
    Reflect.set(app, "state", {
      ...initialAppState(),
      error: "",
    });

    enterAuthenticationRequired(app);
    enterAuthenticationRequired(app);
    expect(Reflect.get(app, "authenticationRequired")).toBe(true);
    expect(recoveryStop).toHaveBeenCalledOnce();
    expect(Reflect.get(app, "state")).toMatchObject({
      error: "Session expired. Sign in again to continue. Your draft was kept.",
    });

    const container = document.createElement("div");
    render(app.render(), container);
    const action = container.querySelector<HTMLButtonElement>(".error-action");
    expect(action?.textContent).toBe("Reauthenticate");
    expect(container.querySelector(".error-dismiss")).toBeNull();

    const assign = vi.fn();
    const origin = "https://pi.example.test";
    const href = `${origin}/workspaces/demo?session=abc&secret-token=leak-me#fragment-secret`;
    vi.stubGlobal("location", {
      get href() { return href; },
      get origin() { return origin; },
      assign,
    });
    action?.click();
    expect(assign).toHaveBeenCalledOnce();
    const navigated = String(assign.mock.calls[0]?.[0]);
    const expectedRd = encodeURIComponent(`${origin}/workspaces/demo`);
    expect(navigated).toBe(`${origin}/outpost.goauthentik.io/start?rd=${expectedRd}`);
    expect(navigated).not.toContain("secret-token");
    expect(navigated).not.toContain("leak-me");
    expect(navigated).not.toContain("fragment-secret");
    expect(navigated).not.toContain("session=abc");
  });

  it("keeps Reauthenticate available because the auth banner has no dismiss control", () => {
    const app = new PiWebApp();
    Reflect.set(app, "browserConnectionRecovery", { stop: vi.fn(), start: vi.fn(), isRecovering: () => false });
    Reflect.set(app, "state", { ...initialAppState(), error: "" });
    enterAuthenticationRequired(app);

    const container = document.createElement("div");
    render(app.render(), container);
    expect(Reflect.get(app, "authenticationRequired")).toBe(true);
    expect(container.querySelector(".error-dismiss")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".error-action")?.textContent).toBe("Reauthenticate");
    expect(container.querySelector(".app-error")?.textContent).toContain("Session expired");
  });
});

type EnterAuthenticationRequired = (this: PiWebApp) => void;

function enterAuthenticationRequired(app: PiWebApp): void {
  const method: unknown = Reflect.get(app, "enterAuthenticationRequired");
  if (!isEnterAuthenticationRequired(method)) throw new Error("PiWebApp.enterAuthenticationRequired was unavailable");
  Reflect.apply(method, app, []);
}

function isEnterAuthenticationRequired(value: unknown): value is EnterAuthenticationRequired {
  return typeof value === "function";
}

describe("validatedSameOriginReturnUrl", () => {
  it("returns only origin+pathname and strips secret query and fragment", () => {
    expect(
      validatedSameOriginReturnUrl(
        "https://pi.example.test/workspaces/demo?session=abc&secret-token=leak-me#fragment-secret",
        "https://pi.example.test",
      ),
    ).toBe("https://pi.example.test/workspaces/demo");
    expect(validatedSameOriginReturnUrl("https://pi.example.test/a?b=1#c", "https://pi.example.test")).toBe(
      "https://pi.example.test/a",
    );
    const stripped = validatedSameOriginReturnUrl(
      "https://pi.example.test/path?secret-token=value#fragment-secret",
      "https://pi.example.test",
    );
    expect(stripped).toBe("https://pi.example.test/path");
    expect(stripped).not.toContain("secret-token");
    expect(stripped).not.toContain("fragment-secret");
    expect(stripped).not.toContain("?");
    expect(stripped).not.toContain("#");
  });

  it("rejects cross-origin or credentialed URLs", () => {
    expect(validatedSameOriginReturnUrl("https://evil.example/a", "https://pi.example.test")).toBeUndefined();
    expect(validatedSameOriginReturnUrl("https://user:pass@pi.example.test/a", "https://pi.example.test")).toBeUndefined();
  });
});
