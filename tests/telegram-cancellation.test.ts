import { afterEach, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram.js";

afterEach(() => { vi.useRealTimers(); });

it.each([
  ["reload", "timeout", "TELEGRAM_RELOADING"],
  ["reload", "caller", "TELEGRAM_RELOADING"],
  ["caller", "reload", "TELEGRAM_ABORTED"],
  ["caller", "timeout", "TELEGRAM_ABORTED"],
  ["timeout", "reload", "TELEGRAM_TIMEOUT"],
  ["shutdown", "reload", "TELEGRAM_ABORTED"],
])("preserves the first cancellation cause: %s before %s", async (first, second, expected) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let requestSignal!: AbortSignal;
  let rejectFetch!: (reason: unknown) => void;
  vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    requestSignal = init.signal!;
    rejectFetch = reject;
  }));
  const client = new TelegramClient({ botToken: "cancellation-test-token" });
  const caller = new AbortController();
  const result = client.callApi("getMe", undefined, 30, caller.signal).catch(error => error);
  // Keep fetch unwinding deferred so both cancellation sources have fired.
  for (const event of [first, second]) {
    if (event === "reload") client.abortAll("reload");
    else if (event === "shutdown") client.abortAll();
    else if (event === "caller") caller.abort();
    else await vi.advanceTimersByTimeAsync(31);
  }
  rejectFetch(requestSignal.reason);
  expect(await result).toMatchObject({ code: expected });
});
