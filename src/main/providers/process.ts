/**
 * Running a command-line tool as a child process, shared by the CLI providers.
 *
 * - Never through a shell: the command is an executable path and the arguments are an array.
 * - The material goes on stdin, never in the arguments. (What a provider puts in its arguments
 *   is its own business: Claude Code is given the app's instructions there.)
 * - Aborting, timing out or producing too much output kills the whole process tree.
 *
 * The spawner and the tree killer are injected so all of this is tested without a real tool.
 */
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

/** The part of Node's `ChildProcess` this module uses. */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnSettings {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  detached: boolean;
  stdio: ["pipe", "pipe", "pipe"];
}

export type SpawnFn = (command: string, args: readonly string[], settings: SpawnSettings) => SpawnedProcess;

/** Kills a process and everything it started. Must not throw. */
export type KillTreeFn = (child: SpawnedProcess) => void;

export type ProcessFailureKind =
  | "aborted"
  | "timed-out"
  | "output-limit" // stdout grew past the cap
  | "not-found" // the executable does not exist
  | "spawn-failed"; // it exists but could not be started

/** Why a run produced no result. Carries no output, no arguments and no paths. */
export class ProcessFailure extends Error {
  readonly kind: ProcessFailureKind;
  /** The operating system's error code (`ENOENT`, `EACCES`, …) when there is one. */
  readonly errno: string | undefined;

  constructor(kind: ProcessFailureKind, errno?: string) {
    super(`process ${kind}`);
    this.name = "ProcessFailure";
    this.kind = kind;
    this.errno = errno;
  }
}

export interface RunOptions {
  /** Absolute path of the executable. */
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Past this many bytes of stdout the run is killed and fails with `output-limit`. */
  maxStdoutBytes?: number;
  /** Past this many bytes, further stderr is dropped (the run continues). */
  maxStderrBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunDeps {
  spawn?: SpawnFn;
  killTree?: KillTreeFn;
  platform?: NodeJS.Platform;
}

export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

const defaultSpawn: SpawnFn = (command, args, settings) => nodeSpawn(command, args, settings);

/**
 * On Windows `child.kill()` ends only the one process; anything it started lives on. `taskkill
 * /T /F` ends the tree. Elsewhere the child is started as the leader of its own process group
 * (`detached`), and the signal goes to the group.
 */
export function createKillTree(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawn: typeof nodeSpawn = nodeSpawn,
  killGroup: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => {
    process.kill(-pid, signal);
  },
): KillTreeFn {
  return (child) => {
    const pid = child.pid;
    try {
      if (pid !== undefined && platform === "win32") {
        const root = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? env["windir"] ?? "C:\\Windows";
        const taskkill = path.win32.join(root, "System32", "taskkill.exe");
        const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        // If taskkill itself cannot run, fall back to ending at least the one process.
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            // Nothing more to try.
          }
        });
        return;
      }
      if (pid !== undefined) {
        killGroup(pid, "SIGTERM");
        const timer = setTimeout(() => {
          try {
            killGroup(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }, 2000);
        timer.unref();
        return;
      }
    } catch {
      // Fall through to the plain kill.
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Runs the command to completion and resolves with what it printed, whatever its exit code.
 * Rejects only with a `ProcessFailure`.
 */
export function runProcess(options: RunOptions, deps: RunDeps = {}): Promise<RunResult> {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultSpawn;
  const killTree = deps.killTree ?? createKillTree(platform);
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const { signal } = options;

  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProcessFailure("aborted"));
      return;
    }

    let child: SpawnedProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const errno = errnoOf(error);
      reject(new ProcessFailure(errno === "ENOENT" ? "not-found" : "spawn-failed", errno));
      return;
    }

    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const cleanUp = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const failWith = (failure: ProcessFailure, kill: boolean): void => {
      if (settled) return;
      settled = true;
      cleanUp();
      if (kill) killTree(child);
      reject(failure);
    };
    const onAbort = (): void => failWith(new ProcessFailure("aborted"), true);
    const timer = setTimeout(() => failWith(new ProcessFailure("timed-out"), true), options.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      const errno = errnoOf(error);
      failWith(new ProcessFailure(errno === "ENOENT" ? "not-found" : "spawn-failed", errno), false);
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stdoutBytes += buffer.length;
      if (stdoutBytes > maxStdout) {
        failWith(new ProcessFailure("output-limit"), true);
        return;
      }
      stdout.push(buffer);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const room = maxStderr - stderrBytes;
      if (room <= 0) return;
      const kept = buffer.length > room ? buffer.subarray(0, room) : buffer;
      stderrBytes += kept.length;
      stderr.push(kept);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanUp();
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    // A tool that exits before reading its input makes the pipe fail; the exit is what matters.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ?? "");
  });
}
