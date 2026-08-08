import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, type ApiRequestTelemetry } from "./http";

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
