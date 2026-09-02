/* @vitest-environment happy-dom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render } from "lit";
import { errorBanner, type ErrorBannerOption } from "./errorBanner";

afterEach(() => {
  document.body.replaceChildren();
});

function renderBanner(
  error: string,
  onDismiss = vi.fn(),
  option?: ErrorBannerOption,
): { host: HTMLElement; onDismiss: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  render(errorBanner(error, onDismiss, option), host);
  return { host, onDismiss };
}

describe("errorBanner", () => {
  it("renders nothing for an empty error", () => {
    const host = document.createElement("div");
    render(errorBanner("", vi.fn()), host);

    expect(host.innerHTML).toBe("<!---->");
  });

  it("renders a dismissible error banner", () => {
    const { host, onDismiss } = renderBanner("Something failed");

    expect(host.querySelector(".error")?.textContent).toContain("Something failed");
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

  it.each(["info", "warning"] as const)("uses the severity-aware presentation for %s notices", (severity) => {
    const { host } = renderBanner("Server notice", vi.fn(), severity);
    const banner = host.querySelector(".error");

    expect(banner?.classList.contains(severity)).toBe(true);
    expect(banner?.querySelector(".error-dismiss")?.getAttribute("aria-label")).toBe(`Dismiss ${severity}`);
  });
});
