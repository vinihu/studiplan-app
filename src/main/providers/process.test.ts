import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createKillTree,
  ProcessFailure,
  runProcess,
  type RunOptions,
  type SpawnedProcess,
  type SpawnSettings,
} from "./process";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString("utf8");
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  finish(code: number, stdout = "", stderr = ""): void {
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.emit("close", code));
  }
}

interface Harness {
  child: FakeChild;
  calls: Array<{ command: string; args: readonly string[]; settings: SpawnSettings }>;
  killTree: ReturnType<typeof vi.fn<(child: SpawnedProcess) => void>>;
  run(overrides?: Partial<RunOptions>): Promise<unknown>;
}

function harness(platform: NodeJS.Platform = "win32"): Harness {
  const child = new FakeChild();
  const calls: Harness["calls"] = [];
  const killTree = vi.fn<(child: SpawnedProcess) => void>();
  return {
    child,
    calls,
    killTree,
    run: (overrides = {}) =>
      runProcess(
        { command: "C:\\bin\\tool.exe", args: ["--flag", "value"], cwd: "C:\\work", timeoutMs: 5000, ...overrides },
        {
          platform,
          killTree,
          spawn: (command, args, settings) => {
            calls.push({ command, args, settings });
            return child;
          },
        },
      ),
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ProcessFailure> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProcessFailure);
  return error as ProcessFailure;
}

describe("runProcess", () => {
  it("starts the executable without a shell, writes stdin, and returns the output", async () => {
    const h = harness();
    const pending = h.run({ stdin: "the prompt" });
    h.child.finish(3, "out", "err");
    await expect(pending).resolves.toEqual({ exitCode: 3, stdout: "out", stderr: "err" });

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.command).toBe("C:\\bin\\tool.exe");
    expect(h.calls[0]?.args).toEqual(["--flag", "value"]);
    expect(h.calls[0]?.settings).toMatchObject({ cwd: "C:\\work", shell: false, windowsHide: true, detached: false });
    expect(h.child.input).toBe("the prompt");
    expect(h.killTree).not.toHaveBeenCalled();
  });

  it("makes the child a process-group leader off Windows, so the group can be killed", async () => {
    const h = harness("linux");
    const pending = h.run();
    h.child.finish(0);
    await pending;
    expect(h.calls[0]?.settings.detached).toBe(true);
  });

  it("kills the process tree when the signal aborts", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.run({ signal: controller.signal });
    controller.abort();
    expect((await failureOf(pending)).kind).toBe("aborted");
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child);
  });

  it("does not start anything when the signal is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect((await failureOf(h.run({ signal: controller.signal }))).kind).toBe("aborted");
    expect(h.calls).toHaveLength(0);
  });

  it("kills the process tree on timeout", async () => {
    const h = harness();
    expect((await failureOf(h.run({ timeoutMs: 10 }))).kind).toBe("timed-out");
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child);
  });

  it("kills the process tree when stdout passes the cap, and keeps nothing more", async () => {
    const h = harness();
    const pending = h.run({ maxStdoutBytes: 10 });
    h.child.stdout.write("12345678");
    h.child.stdout.write("90123");
    expect((await failureOf(pending)).kind).toBe("output-limit");
    expect(h.killTree).toHaveBeenCalledOnce();
  });

  it("drops stderr past its cap without stopping the run", async () => {
    const h = harness();
    const pending = h.run({ maxStderrBytes: 4 });
    h.child.finish(0, "fine", "abcdefgh");
    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "fine", stderr: "abcd" });
    expect(h.killTree).not.toHaveBeenCalled();
  });

  it("reports a missing executable as not-found", async () => {
    const h = harness();
    const pending = h.run();
    h.child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const failure = await failureOf(pending);
    expect(failure.kind).toBe("not-found");
    expect(failure.message).not.toContain("tool.exe");
  });

  it("reports a spawn that throws", async () => {
    const pending = runProcess(
      { command: "x", args: [], cwd: ".", timeoutMs: 1000 },
      {
        killTree: () => {},
        spawn: () => {
          throw Object.assign(new Error("bad"), { code: "EINVAL" });
        },
      },
    );
    const failure = await failureOf(pending);
    expect(failure.kind).toBe("spawn-failed");
    expect(failure.errno).toBe("EINVAL");
  });

  it("survives the child closing its stdin early", async () => {
    const h = harness();
    const pending = h.run({ stdin: "x" });
    h.child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    h.child.finish(1);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
  });
});

describe("createKillTree", () => {
  it("uses taskkill /T /F on Windows, because child.kill() leaves descendants running", () => {
    const killer = new EventEmitter();
    const spawn = vi.fn(() => killer);
    const child = new FakeChild();
    const killTree = createKillTree("win32", { SystemRoot: "C:\\Windows" }, spawn as never);
    killTree(child);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4242", "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    expect(child.killed).toBe(false);

    killer.emit("error", new Error("no taskkill"));
    expect(child.killed).toBe(true);
  });

  it("signals the whole process group elsewhere", () => {
    const killGroup = vi.fn();
    const child = new FakeChild();
    createKillTree("linux", {}, vi.fn() as never, killGroup)(child);
    expect(killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("falls back to child.kill() when there is no pid", () => {
    const child = new FakeChild();
    child.pid = undefined;
    createKillTree("win32", {}, vi.fn() as never)(child);
    expect(child.killed).toBe(true);
  });
});
