import { describe, expect, it, vi } from "vitest";
import { checkPiCompatibility } from "../src/pi-compat.js";

describe("pi-compat module", () => {
  it("verifies expected ExtensionAPI and ExtensionContext methods", () => {
    const mockPi = {
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as any;

    const mockCtx = {
      mode: "tui",
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [],
      },
    } as any;

    const report = checkPiCompatibility(mockPi, mockCtx);
    expect(report.compatible).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails compatibility check if an API method is missing", () => {
    const mockPi = {
      appendEntry: vi.fn(),
      // missing sendUserMessage
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as any;

    const mockCtx = {
      mode: "tui",
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [],
      },
    } as any;

    const report = checkPiCompatibility(mockPi, mockCtx);
    expect(report.compatible).toBe(false);
    expect(report.checks.some((c) => c.name.includes("sendUserMessage") && !c.passed)).toBe(true);
  });
});
