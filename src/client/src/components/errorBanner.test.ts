// @vitest-environment happy-dom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorBanner } from "./errorBanner";

afterEach(() => {
  document.body.replaceChildren();
});

function renderBanner(
  error: string,
  onDismiss = vi.fn(),
  action?: { label: string; onClick: () => void },
): { host: HTMLElement; onDismiss: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  render(errorBanner(error, onDismiss, action), host);
  return { host, onDismiss };
}

describe("errorBanner", () => {
  it("renders nothing when there is no error", () => {
    const { host } = renderBanner("");

    expect(host.querySelector(".error")).toBeNull();
  });

  it("announces the message and dismisses it on request", () => {
    const { host, onDismiss } = renderBanner("Failed to start workspace removal: HTTP request cancelled");

    const banner = host.querySelector(".error");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Failed to start workspace removal: HTTP request cancelled");

    const dismiss = host.querySelector<HTMLButtonElement>(".error-dismiss");
    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss error");
    dismiss?.click();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders an explicit action button that does not dismiss the banner", () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    const { host } = renderBanner("Session expired. Sign in again to continue.", onDismiss, {
      label: "Reauthenticate",
      onClick,
    });

    const action = host.querySelector<HTMLButtonElement>(".error-action");
    expect(action?.textContent).toBe("Reauthenticate");
    action?.click();

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(host.querySelector(".error")?.textContent).toContain("Session expired");
  });

  it("omits the dismiss control when onDismiss is omitted (auth-required persistence)", () => {
    const onClick = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    render(
      errorBanner("Session expired. Sign in again to continue.", undefined, {
        label: "Reauthenticate",
        onClick,
      }),
      host,
    );

    expect(host.querySelector(".error-dismiss")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".error-action")?.textContent).toBe("Reauthenticate");
  });
});
