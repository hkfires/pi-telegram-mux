import { beforeEach, afterEach, vi } from "vitest";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Never contact Telegram or another external service in tests. Local HTTP fixtures
  // still exercise the real HTTP client, including cancellation and response parsing.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return originalFetch(input, init);
    if (url.hostname === "api.telegram.org" && url.pathname.endsWith("/getMe")) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: "Fixture", username: "fixture_bot" } })));
    }
    if (url.hostname === "api.telegram.org" && url.pathname.endsWith("/getUpdates")) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error("Aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
    }
    return Promise.reject(new Error("Unexpected external request in test"));
  });
});

afterEach(() => { vi.unstubAllGlobals(); });
