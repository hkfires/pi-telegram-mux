import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Compatibility validation against Pi Extension API contract.
 */
export interface PiCompatibilityReport {
  compatible: boolean;
  checks: {
    name: string;
    passed: boolean;
    error?: string;
  }[];
}

/**
 * Verify that ExtensionAPI and ExtensionContext implement expected contracts.
 */
export function checkPiCompatibility(pi: ExtensionAPI, ctx: ExtensionContext): PiCompatibilityReport {
  const checks: { name: string; passed: boolean; error?: string }[] = [];

  // Check 1: pi.appendEntry exists and is a function
  try {
    const isFn = typeof pi.appendEntry === "function";
    checks.push({ name: "pi.appendEntry is function", passed: isFn });
  } catch (err: unknown) {
    checks.push({ name: "pi.appendEntry is function", passed: false, error: String(err) });
  }

  // Check 2: pi.sendUserMessage exists and is a function
  try {
    const isFn = typeof pi.sendUserMessage === "function";
    checks.push({ name: "pi.sendUserMessage is function", passed: isFn });
  } catch (err: unknown) {
    checks.push({ name: "pi.sendUserMessage is function", passed: false, error: String(err) });
  }

  // Check 3: pi.registerCommand exists and is a function
  try {
    const isFn = typeof pi.registerCommand === "function";
    checks.push({ name: "pi.registerCommand is function", passed: isFn });
  } catch (err: unknown) {
    checks.push({ name: "pi.registerCommand is function", passed: false, error: String(err) });
  }

  // Check 4: pi.on exists and is a function
  try {
    const isFn = typeof pi.on === "function";
    checks.push({ name: "pi.on is function", passed: isFn });
  } catch (err: unknown) {
    checks.push({ name: "pi.on is function", passed: false, error: String(err) });
  }

  // Check 5: ctx.sessionManager exists
  try {
    const sm = ctx.sessionManager;
    const passed =
      sm !== null &&
      typeof sm === "object" &&
      typeof sm.getSessionId === "function" &&
      typeof sm.getEntries === "function";
    checks.push({ name: "ctx.sessionManager contract", passed });
  } catch (err: unknown) {
    checks.push({ name: "ctx.sessionManager contract", passed: false, error: String(err) });
  }

  // Check 6: ctx.mode is defined
  try {
    const hasMode = typeof ctx.mode === "string";
    checks.push({ name: "ctx.mode is string", passed: hasMode });
  } catch (err: unknown) {
    checks.push({ name: "ctx.mode is string", passed: false, error: String(err) });
  }

  const compatible = checks.every((c) => c.passed);
  return { compatible, checks };
}
