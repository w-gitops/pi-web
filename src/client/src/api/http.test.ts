import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, AuthRequiredError, isProxyAuthRequiredResponse, request, type ApiRequestTelemetry } from "./http";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instrumented API request transport", () => {
  it("adds only an opaque request id and never retries an application request", async () => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    const failure = new Error("prompt body /home/user?token=Bearer-secret");
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);
    const finish = vi.fn();
    const telemetry: ApiRequestTelemetry = {
      begin: () => ({ requestId: "1234567890abcdef1234567890abcdef", operation: "session.prompt", method: "POST", startedAt: 0 }),
      finish,
    };

    await expect(apiRequest("api/private/session/prompt", "session.prompt", { method: "POST", body: "private prompt" }, () => Promise.resolve(undefined), telemetry)).rejects.toBe(failure);

    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-pi-web-request-id")).toBe("1234567890abcdef1234567890abcdef");
    expect([...headers.keys()].sort()).toEqual(["content-type", "x-pi-web-request-id"]);
    expect(finish).toHaveBeenCalledWith(expect.any(Object), "network", undefined);
    expect(JSON.stringify(finish.mock.calls)).not.toContain("Bearer-secret");
    expect(JSON.stringify(finish.mock.calls)).not.toContain("/home/user");
  });

  it("classifies successful-response parsing failures without recording the thrown text", async () => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    vi.stubGlobal("fetch", vi.fn<FetchLike>().mockResolvedValue(new Response("not-json", { status: 200 })));
    const finish = vi.fn();
    const telemetry: ApiRequestTelemetry = { begin: () => undefined, finish };

    await expect(apiRequest("api/status", "pi-web.status", undefined, async (response) => {
      const value: unknown = await response.json();
      return value;
    }, telemetry)).rejects.toBeDefined();

    expect(finish).toHaveBeenCalledWith(undefined, "parse", 200);
  });
});

describe("proxy auth response classification", () => {
  it("detects the explicit X-PI-Web-Reauth header and throws AuthRequiredError without leaking response details", async () => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    const body = "<html>login secret-token=/home/user</html>";
    const response = new Response(body, {
      status: 401,
      headers: { "content-type": "text/html", "X-PI-Web-Reauth": "1" },
    });
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const finish = vi.fn();
    const telemetry: ApiRequestTelemetry = { begin: () => undefined, finish };
    const handle = vi.fn();

    await expect(apiRequest("api/machines/local/health", "api.unknown", undefined, handle, telemetry)).rejects.toBeInstanceOf(AuthRequiredError);
    expect(handle).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(finish.mock.calls);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("/home/user");
    expect(serialized).not.toContain(body);
  });

  it("detects a followed redirect whose final URL is under /outpost.goauthentik.io", async () => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    const response = responseWithUrl(
      new Response("<html>authentik</html>", { status: 200, headers: { "content-type": "text/html" } }),
      "https://pi.example.test/outpost.goauthentik.io/start?rd=https%3A%2F%2Fpi.example.test%2F",
      true,
    );
    vi.stubGlobal("fetch", vi.fn<FetchLike>().mockResolvedValue(response));
    const handle = vi.fn();

    const error = await apiRequest("api/status", "pi-web.status", undefined, handle).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(String(error)).toBe("AuthRequiredError: Authentication required");
    expect(String(error)).not.toContain("outpost.goauthentik.io");
    expect(String(error)).not.toContain("rd=");
    expect(handle).not.toHaveBeenCalled();
  });

  it("does not treat ordinary 401/403 or TypeError transport failures as proxy auth", async () => {
    expect(isProxyAuthRequiredResponse(new Response("{}", { status: 401, headers: { "content-type": "application/json" } }))).toBe(false);
    expect(isProxyAuthRequiredResponse(new Response("{}", { status: 403, headers: { "content-type": "application/json" } }))).toBe(false);
    expect(isProxyAuthRequiredResponse(new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }))).toBe(false);

    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    vi.stubGlobal("fetch", vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })));
    await expect(request("api/machines/local/health", () => ({}), undefined, "api.unknown")).rejects.toThrow("nope");
    await expect(request("api/machines/local/health", () => ({}), undefined, "api.unknown")).rejects.not.toBeInstanceOf(AuthRequiredError);

    // Transport TypeError never becomes AuthRequiredError. Callers report
    // delivery-unknown for the prompt POST; a later same-origin health probe
    // can still throw AuthRequiredError when the proxy returns X-PI-Web-Reauth.
    const fetchMock = vi.fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(new Response("{}", {
        status: 401,
        headers: { "content-type": "application/json", "X-PI-Web-Reauth": "1" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest("api/prompt", "session.prompt", { method: "POST" }, () => Promise.resolve(undefined))).rejects.toBeInstanceOf(TypeError);
    await expect(apiRequest("api/machines/local/health", "api.unknown", undefined, () => Promise.resolve(undefined))).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function responseWithUrl(response: Response, url: string, redirected: boolean): Response {
  Object.defineProperty(response, "url", { configurable: true, value: url });
  Object.defineProperty(response, "redirected", { configurable: true, value: redirected });
  return response;
}
