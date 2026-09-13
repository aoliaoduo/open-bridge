import { afterEach, describe, expect, test, vi } from "vitest";
import { api, consoleToken, copyText } from "./api";

function setTokenMeta(content: string | null): void {
  document.head.innerHTML = content === null
    ? ""
    : `<meta name="open-bridge-console-token" content="${content}">`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("consoleToken", () => {
  test("reads the token the server injected into the page", () => {
    setTokenMeta("abc123");
    expect(consoleToken()).toBe("abc123");
  });

  test("returns an empty string when the meta tag is absent", () => {
    setTokenMeta(null);
    expect(consoleToken()).toBe("");
  });
});

describe("GET helpers", () => {
  test("returns the parsed body on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: { state: "running" } })));
    await expect(api.status()).resolves.toMatchObject({ state: "running" });
  });

  test("throws with the status code when the server refuses", async () => {
    // /api/* is loopback-gated: a non-loopback Host is refused with 403, and the
    // client must surface that rather than rendering an empty panel.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(api.status()).rejects.toThrow("GET /api/status → HTTP 403");
  });
});

describe("POST helpers", () => {
  test("attaches the console token header", async () => {
    setTokenMeta("tok-1");
    // Declare the call signature so mock.calls is typed without a cast.
    type FetchArgs = [path: string, init: RequestInit];
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(
      async () => jsonResponse({ status: { state: "running" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.bridgeRotate();

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/bridge/rotate");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-open-bridge-console"]).toBe("tok-1");
  });

  test("surfaces the server's own error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "无法识别的操作。" }, 400)));
    await expect(api.settingsAction({ command: "nope" })).rejects.toThrow("无法识别的操作。");
  });

  test("falls back to a generic message when the body has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(api.bridgeRotate()).rejects.toThrow("POST /api/bridge/rotate → HTTP 500");
  });
});

describe("copyText", () => {
  test("uses the async clipboard when available", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  test("falls back to a textarea when the clipboard API is unavailable", async () => {
    // http://127.0.0.1 is not a secure context in some browsers, so
    // navigator.clipboard can be missing entirely.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    await copyText("fallback");

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
