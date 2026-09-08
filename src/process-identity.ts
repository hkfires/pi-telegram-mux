import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
let ownIdentity: Promise<string | undefined> | undefined;

/** A kernel-provided process start identity, independent of the caller's clock. */
export function getProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined);
  if (pid === process.pid && ownIdentity) return ownIdentity;
  const reading = (async () => {
    try {
      let identity: string;
      if (process.platform === "linux") {
        const [stat, bootId] = await Promise.all([
          readFile(`/proc/${pid}/stat`, "utf8"),
          readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        ]);
        const end = stat.lastIndexOf(")");
        if (end < 0 || !stat.startsWith(`${pid} (`)) return undefined;
        const startTicks = stat.slice(end + 2).trim().split(/\s+/)[19];
        if (!/^\d+$/.test(startTicks ?? "") || !/^[a-f\d-]{36}$/i.test(bootId.trim())) return undefined;
        identity = `${bootId.trim()}:${startTicks}`;
      } else if (process.platform === "win32") {
        const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const { stdout } = await execute(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid}).StartTime.ToFileTimeUtc().ToString('x') } catch { exit 1 }`,
        ], { windowsHide: true, timeout: 3000, maxBuffer: 4096 });
        identity = stdout.trim();
        if (!/^[a-f\d]{12,16}$/i.test(identity)) return undefined;
      } else if (process.platform === "darwin") {
        const { stdout } = await execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000, maxBuffer: 4096,
        });
        identity = stdout.trim().replace(/\s+/g, " ");
        if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(identity)) return undefined;
      } else return undefined;
      return createHash("sha256").update(`${process.platform}:${identity}`).digest("hex");
    } catch {
      // Unavailable process information is not evidence that a holder has exited.
      return undefined;
    }
  })();
  if (pid === process.pid) {
    ownIdentity = reading;
    void reading.then(identity => { if (identity === undefined && ownIdentity === reading) ownIdentity = undefined; });
  }
  return reading;
}
