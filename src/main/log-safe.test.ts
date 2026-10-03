import { describe, expect, it, vi } from "vitest";
import { describeError, redactPaths, withoutPaths } from "./log-safe";
import { certificateChecksAreOff, HttpFailure, postJson } from "./providers/api-key-http";
import { consoleLog } from "./providers/errors";

describe("what reaches the log", () => {
  it("has no path in it", () => {
    for (const [text, expected] of [
      ["error: cannot open C:\\Users\\someone\\AppData\\Local\\Temp\\studiplan-codex-ab12\\schema.json (os error 2)", "error: cannot open [path] (os error 2)"],
      ["ENOENT: no such file or directory, open 'D:/Study/Biology/files/a.pdf'", "ENOENT: no such file or directory, open '[path]'"],
      ["read \\\\server\\share\\x.pdf failed", "read [path] failed"],
      ["at file:///C:/Users/someone/app/out/main/index.js:10:5", "at [path]"],
      ["spawn /home/someone/.local/bin/claude ENOENT", "spawn [path] ENOENT"],
      ["open /Users/someone/Library/x failed", "open [path] failed"],
      ["HTTP 429 from https://api.example.com/v1/messages", "HTTP 429 from https://api.example.com/v1/messages"],
      ["exit code 1, 3/4 done, and/or nothing", "exit code 1, 3/4 done, and/or nothing"],
    ] as const) {
      expect(redactPaths(text)).toBe(expected);
    }
  });

  it("keeps the kind of a file-system error and drops where it happened", () => {
    const error = Object.assign(new Error("EBUSY: resource busy or locked, copyfile 'C:\\Users\\someone\\a.pdf' -> 'D:\\Library\\a.pdf'"), {
      code: "EBUSY",
      syscall: "copyfile",
      path: "C:\\Users\\someone\\a.pdf",
      dest: "D:\\Library\\a.pdf",
    });
    expect(describeError(error)).toEqual({ name: "Error", code: "EBUSY", syscall: "copyfile" });
    expect(JSON.stringify(describeError(error))).not.toMatch(/someone|Library|a\.pdf/);
    expect(describeError(new TypeError("cannot read C:\\Users\\someone\\x of undefined"))).toEqual({ name: "TypeError", message: "cannot read [path] of undefined" });
    expect(describeError("plain C:\\x\\y text")).toEqual({ error: "plain [path] text" });
  });

  it("cleans every string of a log detail, and the provider log does it for all callers", () => {
    expect(withoutPaths({ exitCode: 1, stderr: "failed at C:\\Users\\someone\\x", nested: { list: ["D:/a/b", 3] } })).toEqual({
      exitCode: 1,
      stderr: "failed at [path]",
      nested: { list: ["[path]", 3] },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      consoleLog("codex: request failed", { stderr: "error: C:\\Users\\someone\\AppData\\Local\\Temp\\studiplan-codex-1\\i.md missing" });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("someone");
      expect(JSON.stringify(spy.mock.calls)).toContain("[path] missing");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("certificate checks", () => {
  it("nothing is sent while they are switched off for this process", async () => {
    const send = vi.fn();
    const options = {
      url: "https://api.example.com/v1",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxResponseBytes: 1_000,
      fetch: send as unknown as typeof fetch,
    };
    const error = await postJson({ ...options, env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HttpFailure);
    expect((error as HttpFailure).kind).toBe("insecure");
    expect(send).not.toHaveBeenCalled();

    expect(certificateChecksAreOff({})).toBe(false);
    expect(certificateChecksAreOff({ NODE_TLS_REJECT_UNAUTHORIZED: "1" })).toBe(false);
    send.mockResolvedValue(new Response("{}", { status: 200 }));
    await postJson({ ...options, env: {} });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
