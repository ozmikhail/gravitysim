import { spawn } from "node:child_process";

export function run(command, { cwd, timeout = 120000, env = {}, inheritEnv = true, input, onOutput, maxOutput = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", size = 0, problem, finished = false;
    const child = spawn(command[0], command.slice(1), { cwd, env: { ...(inheritEnv ? process.env : {}), NO_COLOR: "1", FORCE_COLOR: "0", ...env }, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const timer = setTimeout(() => stop(`Timed out after ${timeout}ms`), timeout);
    const finish = (code) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(problem ? { error: problem } : {}) });
    };
    const stop = (message) => {
      problem = message;
      if (child.pid) {
        if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill()).unref();
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      finish(null);
    };
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) stream?.setEncoding("utf8").on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxOutput) { stop(`Output exceeded ${maxOutput} bytes`); return; }
      const text = chunk.toString();
      if (name === "stdout") stdout += text; else stderr += text;
      onOutput?.(name, text);
    });
    child.on("error", (error) => { problem = error.message; finish(null); });
    if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    child.on("close", (code) => finish(code));
  });
}

export async function executeSteps(ctx, steps, execute = run) {
  const diagnostics = [], checks = [], versions = {};
  for (const step of steps) {
    const id = step.id ?? step.name;
    if (step.versionCommand) {
      const probe = await execute(step.versionCommand, { cwd: step.cwd, timeout: ctx.config.tools?.timeout ?? 120000, env: step.env, inheritEnv: step.inheritEnv ?? true });
      const version = `${probe.stdout}\n${probe.stderr}`.trim();
      const key = step.tool ?? id;
      if (probe.error || probe.code !== 0) {
        diagnostics.push({ rule: "tools.missing", path: step.path ?? ".", check: id, status: "incomplete", suppressible: false, message: `Cannot run ${key}: ${probe.error ?? version}`, remedy: "Install the configured native toolchain and retry." });
        checks.push({ id, status: "incomplete" }); continue;
      }
      versions[key] ??= version;
      versions[`${key}@${step.path ?? "."}`] = version;
      const expected = ctx.config.tools?.versions?.[key];
      const actual = version.match(/\b\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?\b/i)?.[0] ?? version;
      if (expected && actual !== expected) {
        diagnostics.push({ rule: "tools.version", path: step.path ?? ".", check: id, status: "incomplete", suppressible: false, message: `${key} is ${actual}; policy requires ${expected}.`, remedy: "Install the exact approved tool version." });
        checks.push({ id, status: "incomplete" }); continue;
      }
    }
    const result = await execute(step.command, { cwd: step.cwd, timeout: ctx.config.tools?.timeout ?? 120000, env: step.env, inheritEnv: step.inheritEnv ?? true, input: step.input });
    const status = result.error || result.code === null || result.code > 1 ? "incomplete" : result.code === 0 ? "pass" : "violation";
    checks.push({ id, status });
    if (status !== "pass") diagnostics.push({ rule: step.rule ?? id, path: step.path ?? ".", check: id, status, suppressible: false, message: result.error ?? `${id} exited ${result.code}:\n${`${result.stdout}\n${result.stderr}`.trim().replaceAll(ctx.root, ".")}`, remedy: status === "incomplete" ? "Resolve the tool or configuration error and rerun the complete check." : `Resolve the ${id} diagnostics and rerun plumb check.` });
  }
  return { diagnostics, checks, versions };
}
