import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeArgs,
  classifyClaudeError,
  claudeInstallDirectories,
  createClaudeCodeProvider,
  parseEnvelope,
  readClaudeResult,
  type ClaudeCodeOptions,
} from "./claude-code";
import { ProviderFailure, toProviderResult } from "./errors";
import { findExecutable, pathDirectories } from "./locate";
import { ProcessFailure, type RunOptions, type RunResult } from "./process";
import type { GenerateRequest } from "./provider";
import { createProviderRegistry, testProvider } from "./registry";

const EXE = "C:\\Users\\someone\\.local\\bin\\claude.exe";
const MATERIAL = "C:\\Library\\Biology\\Cell division";
const quiet = (): void => {};

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });
}

function ok(stdout: string, exitCode = 0, stderr = ""): RunResult {
  return { exitCode, stdout, stderr };
}

/** A provider on a pretend Windows machine where `claude.exe` exists and `run` is scripted. */
const SYSTEM_FILE = "C:\\Temp\\studiplan-claude-x1\\instructions.md";

function setup(respond: (options: RunOptions) => RunResult | Promise<RunResult>, extra: ClaudeCodeOptions = {}) {
  const runs: RunOptions[] = [];
  /** What was written as the system prompt, and how many of those files are gone again. */
  const system = { written: [] as string[], removed: 0 };
  const log = vi.fn();
  const provider = createClaudeCodeProvider({
    platform: "win32",
    home: "C:\\Users\\someone",
    env: { Path: "C:\\Windows\\System32" },
    isFile: async (file) => file === EXE,
    isDirectory: async () => true,
    emptyDirectory: async () => "C:\\Temp\\empty",
    systemPromptFile: async (text) => {
      system.written.push(text);
      return {
        file: SYSTEM_FILE,
        remove: async () => {
          system.removed += 1;
        },
      };
    },
    log,
    run: async (options) => {
      runs.push(options);
      return respond(options);
    },
    ...extra,
  });
  return { provider, runs, log, system };
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    instructions: "Write a summary of the material.",
    parts: [{ type: "text", text: "SECRET-MATERIAL-TEXT about mitosis" }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderFailure);
  return (error as ProviderFailure).code;
}

describe("buildClaudeArgs", () => {
  const READ_ONLY = [
    "--print",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];

  it.each([
    [{ systemFile: SYSTEM_FILE, readFiles: true }],
    [{ systemFile: SYSTEM_FILE, readFiles: false }],
    [{ systemFile: SYSTEM_FILE, readFiles: true, model: "opus", jsonSchema: { type: "object" } }],
  ])("always carries the read-only flags: %j", (input) => {
    const args = buildClaudeArgs(input);
    for (const flag of READ_ONLY) expect(args).toContain(flag);
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    // The only tool is Read, or none at all. Never a tool that writes, runs or goes online.
    expect(["Read", ""]).toContain(args[args.indexOf("--tools") + 1]);
    expect(args.join(" ")).not.toMatch(/dangerously|bypass|acceptEdits|Bash|Write|Edit|WebFetch|add-dir/);
    // The system prompt is a file's path, never the text itself.
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe(SYSTEM_FILE);
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("gives Read only when there are files to read", () => {
    const tools = (readFiles: boolean): string | undefined => {
      const args = buildClaudeArgs({ systemFile: SYSTEM_FILE, readFiles });
      return args[args.indexOf("--tools") + 1];
    };
    expect(tools(true)).toBe("Read");
    expect(tools(false)).toBe("");
  });

  it("adds the model and the schema only when given", () => {
    const plain = buildClaudeArgs({ systemFile: SYSTEM_FILE, readFiles: false });
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--json-schema");

    const full = buildClaudeArgs({ systemFile: SYSTEM_FILE, readFiles: false, model: "sonnet", jsonSchema: { type: "object" } });
    expect(full[full.indexOf("--model") + 1]).toBe("sonnet");
    expect(full[full.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });
});

describe("generate", () => {
  it("puts the material on stdin, the instructions in a file, and neither in argv", async () => {
    const { provider, runs, system } = setup(() => ok(envelope({ result: "  A summary.  " })));
    const answer = await provider.generate(
      request({
        parts: [
          { type: "text", text: "SECRET-MATERIAL-TEXT about mitosis" },
          { type: "file", path: "files\\chapter-3.pdf" },
          { type: "image", path: `${MATERIAL}\\files\\notes\\page-1.jpg` },
        ],
        workingDirectory: MATERIAL,
        model: "sonnet",
      }),
    );
    expect(answer).toBe("A summary.");

    expect(runs).toHaveLength(1);
    const run = runs[0] as RunOptions;
    expect(run.command).toBe(EXE);
    expect(run.cwd).toBe(MATERIAL);
    const argv = run.args.join("\u0000");
    expect(argv).not.toContain("SECRET-MATERIAL-TEXT");
    expect(argv).not.toContain("chapter-3");
    expect(argv).not.toContain("page-1");
    expect(argv).not.toContain(MATERIAL);
    // What the student typed for "Something else…" is part of the instructions: not in the
    // list of running programs either.
    expect(argv).not.toContain("Write a summary");
    expect(argv).not.toContain("STUDY-MATERIAL");
    expect(run.args[run.args.indexOf("--system-prompt-file") + 1]).toBe(SYSTEM_FILE);
    expect(system.written).toHaveLength(1);
    expect(system.written[0]).toContain("Write a summary of the material.");
    expect(system.written[0]).not.toContain("SECRET-MATERIAL-TEXT");
    // And the file is gone once the tool has finished.
    expect(system.removed).toBe(1);
    expect(run.stdin).toContain("SECRET-MATERIAL-TEXT about mitosis");
    expect(run.stdin).toContain("files/chapter-3.pdf");
    expect(run.stdin).toContain("files/notes/page-1.jpg");
    expect(run.args[run.args.indexOf("--tools") + 1]).toBe("Read");
    expect(run.args[run.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(run.args).toContain("--restricted");
    expect(run.signal).toBeDefined();
    expect(run.timeoutMs).toBe(10 * 60 * 1000);
  });

  it("runs in an empty folder with no tools when there are no files", async () => {
    const { provider, runs } = setup(() => ok(envelope({ result: "ok" })));
    await provider.generate(request());
    expect(runs[0]?.cwd).toBe("C:\\Temp\\empty");
    expect(runs[0]?.args[(runs[0]?.args.indexOf("--tools") ?? 0) + 1]).toBe("");
  });

  it("uses the provider's default model, and lets the request override it", async () => {
    const { provider, runs } = setup(() => ok(envelope({ result: "ok" })), { defaultModel: "haiku" });
    await provider.generate(request());
    await provider.generate(request({ model: "opus" }));
    const modelOf = (run: RunOptions | undefined): string | undefined => run?.args[(run?.args.indexOf("--model") ?? 0) + 1];
    expect(modelOf(runs[0])).toBe("haiku");
    expect(modelOf(runs[1])).toBe("opus");
  });

  it("refuses a model name that is not a plain identifier", async () => {
    const { provider, runs } = setup(() => ok(envelope({ result: "ok" })));
    expect(await codeOf(provider.generate(request({ model: "--dangerously-skip-permissions" })))).toBe("model-unavailable");
    expect(await codeOf(provider.generate(request({ model: "a b" })))).toBe("model-unavailable");
    expect(runs).toHaveLength(0);
  });

  it("refuses a file outside the material folder before starting anything", async () => {
    const { provider, runs } = setup(() => ok(envelope({ result: "ok" })));
    const attempt = provider.generate(
      request({ parts: [{ type: "file", path: "..\\other\\x.pdf" }], workingDirectory: MATERIAL }),
    );
    expect(await codeOf(attempt)).toBe("invalid-request");
    expect(await codeOf(provider.generate(request({ parts: [{ type: "file", path: "x.pdf" }] })))).toBe("invalid-request");
    expect(runs).toHaveLength(0);
  });

  it("says so when the material folder is gone", async () => {
    const { provider, runs } = setup(() => ok(""), { isDirectory: async () => false });
    const error = await provider.generate(request({ workingDirectory: MATERIAL })).catch((reason: unknown) => reason);
    expect((error as ProviderFailure).message).toContain("folder could not be found");
    expect((error as ProviderFailure).message).not.toContain("C:\\");
    expect(runs).toHaveLength(0);
  });

  it("returns JSON text in structured mode, from structured_output", async () => {
    const schema = { type: "object", properties: { cards: { type: "array" } } };
    const { provider, runs } = setup(() =>
      ok(envelope({ result: "ignored prose", structured_output: { cards: [{ front: "a", back: "b" }] } })),
    );
    const answer = await provider.generate(request({ jsonSchema: schema }));
    expect(JSON.parse(answer)).toEqual({ cards: [{ front: "a", back: "b" }] });
    expect(runs[0]?.args[(runs[0]?.args.indexOf("--json-schema") ?? 0) + 1]).toBe(JSON.stringify(schema));
  });

  it("refuses a schema too long for a command line; long instructions are no longer on it", async () => {
    const { provider, runs, system } = setup(() => ok(envelope({ result: "ok", structured_output: { a: 1 } })));
    const huge = { type: "object", description: "x".repeat(31_000) };
    expect(await codeOf(provider.generate(request({ jsonSchema: huge })))).toBe("invalid-request");
    expect(runs).toHaveLength(0);
    // The file written for that request is removed although nothing ran.
    expect(system.removed).toBe(1);

    await provider.generate(request({ instructions: "x".repeat(31_000) }));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args.join(" ").length).toBeLessThan(2_000);
  });

  it("removes the instructions file when the tool fails or is cancelled", async () => {
    const failing = setup(() => {
      throw new ProcessFailure("timed-out");
    });
    expect(await codeOf(failing.provider.generate(request()))).toBe("timed-out");
    expect(failing.system).toMatchObject({ removed: 1 });
    const unwritable = setup(() => ok(envelope({ result: "ok" })), {
      systemPromptFile: async () => {
        throw Object.assign(new Error("ENOSPC: no space left, write 'C:\\Users\\someone\\x'"), { code: "ENOSPC" });
      },
    });
    const error = await unwritable.provider.generate(request()).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "failed" });
    expect((error as ProviderFailure).message).not.toMatch(/someone|ENOSPC/);
    expect(unwritable.runs).toHaveLength(0);
  });

  it("reports not-installed when the executable is nowhere", async () => {
    const { provider } = setup(() => ok(""), { isFile: async () => false });
    const error = await provider.generate(request()).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "not-installed" });
    expect((error as ProviderFailure).message).toMatch(/Install it/);
  });

  it.each([
    ["aborted", "cancelled"],
    ["timed-out", "timed-out"],
    ["output-limit", "too-large"],
    ["not-found", "not-installed"],
    ["spawn-failed", "failed"],
  ] as const)("maps a process failure %s to %s", async (kind, code) => {
    const { provider } = setup(() => {
      throw new ProcessFailure(kind);
    });
    expect(await codeOf(provider.generate(request()))).toBe(code);
  });

  it("reports cancelled when the signal was aborted, whatever the tool printed", async () => {
    const controller = new AbortController();
    const { provider, runs } = setup(() => {
      controller.abort();
      return ok(envelope({ result: "late answer" }));
    });
    expect(await codeOf(provider.generate(request({ signal: controller.signal })))).toBe("cancelled");

    const before = new AbortController();
    before.abort();
    expect(await codeOf(provider.generate(request({ signal: before.signal })))).toBe("cancelled");
    expect(runs).toHaveLength(1);
  });

  it("never logs or shows material, arguments or paths on failure", async () => {
    const { provider, log } = setup(() => ok("garbage that is not json SECRET-MATERIAL-TEXT", 0));
    const error = (await provider
      .generate(request({ workingDirectory: MATERIAL }))
      .catch((reason: unknown) => reason)) as ProviderFailure;
    expect(error.code).toBe("bad-output");
    const shown = error.message;
    const logged = JSON.stringify(log.mock.calls);
    for (const text of [shown, logged]) {
      expect(text).not.toContain("SECRET-MATERIAL-TEXT");
      expect(text).not.toContain("--restricted");
      expect(text).not.toContain("Write a summary");
    }
    expect(shown).not.toMatch(/[A-Z]:\\|\.exe|\bat \w+ \(/);
  });
});

describe("parseEnvelope", () => {
  it("reads the result object", () => {
    expect(parseEnvelope(envelope({ result: "x" }))?.result).toBe("x");
  });

  it("tolerates a stray line before the result", () => {
    expect(parseEnvelope(`warning: something\n${envelope({ result: "x" })}\n`)?.result).toBe("x");
  });

  it.each([[""], ["not json"], ["[1,2]"], ['{"type":"assistant"}'], ["null"]])("rejects %j", (stdout) => {
    expect(parseEnvelope(stdout)).toBeUndefined();
  });
});

describe("readClaudeResult", () => {
  const read = (stdout: string, structured = false, exitCode = 0, stderr = ""): string =>
    readClaudeResult({ exitCode, stdout, stderr }, structured, quiet);
  const codeFrom = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      return (error as ProviderFailure).code;
    }
    throw new Error("expected a failure");
  };

  it("returns trimmed text", () => {
    expect(read(envelope({ result: "\n# Summary\n\nText.\n" }))).toBe("# Summary\n\nText.");
  });

  it("treats an empty answer as bad output", () => {
    expect(codeFrom(() => read(envelope({ result: "  " })))).toBe("bad-output");
    expect(codeFrom(() => read(envelope({})))).toBe("bad-output");
  });

  it("falls back to the result text in structured mode, with or without a code fence", () => {
    expect(read(envelope({ result: '{"a":1}' }), true)).toBe('{"a":1}');
    expect(read(envelope({ result: '```json\n{"a":1}\n```' }), true)).toBe('{"a":1}');
  });

  it("treats non-JSON in structured mode as bad output", () => {
    expect(codeFrom(() => read(envelope({ result: "Here are your cards!" }), true))).toBe("bad-output");
    expect(codeFrom(() => read(envelope({ subtype: "error_max_structured_output_retries", is_error: true }), true))).toBe(
      "bad-output",
    );
  });

  it("still returns the answer when a tool use was denied", () => {
    const log = vi.fn();
    const stdout = envelope({ result: "fine", permission_denials: [{ tool_name: "Read" }] });
    expect(readClaudeResult({ exitCode: 0, stdout, stderr: "" }, false, log)).toBe("fine");
    expect(log).toHaveBeenCalledWith("claude: denied tool use", { count: 1 });
  });

  it("maps the messages the real CLI prints", () => {
    // Seen with a real call against an empty config folder (exit code 1).
    expect(codeFrom(() => read(envelope({ is_error: true, result: "Not logged in · Please run /login" }), false, 1))).toBe(
      "not-signed-in",
    );
    // Seen with a real call and a made-up model name (exit code 1).
    expect(
      codeFrom(() =>
        read(
          envelope({
            is_error: true,
            api_error_status: 404,
            result:
              "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.",
          }),
          false,
          1,
        ),
      ),
    ).toBe("model-unavailable");
  });

  it("classifies a crash with no result object by its exit code and stderr", () => {
    expect(codeFrom(() => read("", false, 1, "Error: Unable to connect to API (ECONNREFUSED)"))).toBe("offline");
    expect(codeFrom(() => read("", false, 1, "boom"))).toBe("failed");
    expect(codeFrom(() => read("hello", false, 0))).toBe("bad-output");
  });
});

describe("classifyClaudeError", () => {
  it.each([
    ["Not logged in · Please run /login", undefined, "not-signed-in"],
    ["API Error: 401 Invalid API key · Please run /login", 401, "not-signed-in"],
    ["OAuth token revoked · Please run /login", 403, "not-signed-in"],
    ["Usage limit reached", undefined, "usage-limit"],
    ["You've hit your session limit · resets 3pm", 429, "usage-limit"],
    ["you have reached your weekly usage limit", undefined, "usage-limit"],
    ["Credit balance is too low", 400, "usage-limit"],
    ["Server is temporarily limiting requests (not your usage limit)", 429, "busy"],
    ["API Error: 529 Overloaded", 529, "busy"],
    ["Internal server error", 500, "busy"],
    ["Prompt is too long", 400, "too-large"],
    ["Check your internet connection and try again.", undefined, "offline"],
    ["something nobody planned for", undefined, "failed"],
  ] as const)("%j (%s) is %s", (text, status, code) => {
    expect(classifyClaudeError(text, status)).toBe(code);
  });
});

describe("detect", () => {
  const version = ok("2.1.287 (Claude Code)\n");

  it("finds the tool in its install folder even when PATH lacks it, and checks sign-in for free", async () => {
    const { provider, runs } = setup((options) =>
      options.args[0] === "--version"
        ? version
        : ok(JSON.stringify({ loggedIn: true, email: "someone@example.com", subscriptionType: "max" })),
    );
    const detection = await provider.detect();
    expect(detection).toEqual({
      available: true,
      status: "ready",
      detail: "Claude Code 2.1.287 is installed and signed in.",
      version: "2.1.287",
    });
    expect(runs.map((run) => run.args)).toEqual([["--version"], ["auth", "status", "--json"]]);
    expect(runs.every((run) => run.command === EXE && run.stdin === undefined)).toBe(true);
    expect(JSON.stringify(detection)).not.toContain("example.com");
  });

  it("reports not-signed-in", async () => {
    const { provider } = setup((options) =>
      options.args[0] === "--version" ? version : ok(JSON.stringify({ loggedIn: false, authMethod: "none" }), 1),
    );
    const detection = await provider.detect();
    expect(detection).toMatchObject({ available: false, status: "not-signed-in", version: "2.1.287" });
    expect(detection.detail).toMatch(/sign in/);
  });

  it("reports not-installed without running anything", async () => {
    const { provider, runs } = setup(() => version, { isFile: async () => false });
    expect(await provider.detect()).toMatchObject({ available: false, status: "not-installed" });
    expect(runs).toHaveLength(0);
  });

  it("stays usable when the sign-in check is not understood", async () => {
    const { provider } = setup((options) => (options.args[0] === "--version" ? version : ok("unknown command", 1)));
    const detection = await provider.detect();
    expect(detection).toMatchObject({ available: true, status: "ready" });
    expect(detection.detail).toMatch(/Press Test/);
  });

  it("never throws", async () => {
    const broken = setup(() => {
      throw new ProcessFailure("timed-out");
    });
    expect(await broken.provider.detect()).toMatchObject({ available: false, status: "error" });

    const odd = setup(() => ok("no version here", 1));
    expect(await odd.provider.detect()).toMatchObject({ available: false, status: "error" });
  });
});

describe("locating the executable", () => {
  it("reads PATH whatever its spelling, and drops relative entries", () => {
    expect(pathDirectories({ Path: 'C:\\a;"C:\\b c";;relative;' }, "win32")).toEqual(["C:\\a", "C:\\b c"]);
    expect(pathDirectories({ PATH: "/usr/bin:/opt/x" }, "linux")).toEqual(["/usr/bin", "/opt/x"]);
    expect(pathDirectories({}, "win32")).toEqual([]);
  });

  it("knows where the installers put Claude Code", () => {
    expect(claudeInstallDirectories({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toEqual([
      "C:\\Users\\u\\.local\\bin",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin",
    ]);
    expect(claudeInstallDirectories({}, "darwin", "/Users/u")).toContain("/Users/u/.local/bin");
  });

  it("returns the first existing candidate, PATH first", async () => {
    const existing = new Set(["C:\\b\\claude.exe", "C:\\c\\claude.exe"]);
    const found = await findExecutable(["claude.exe"], ["C:\\a", "C:\\b", "C:\\c"], "win32", async (file) =>
      existing.has(file),
    );
    expect(found).toBe("C:\\b\\claude.exe");
    expect(await findExecutable(["claude.exe"], ["C:\\a"], "win32", async () => false)).toBeUndefined();
  });
});

describe("registry and bridge helpers", () => {
  it("lists, finds and detects providers", async () => {
    const { provider } = setup((options) =>
      options.args[0] === "--version" ? ok("2.1.287") : ok(JSON.stringify({ loggedIn: true })),
    );
    const registry = createProviderRegistry([provider]);
    expect(registry.info()).toEqual([
      { id: "claude-code", label: "Claude Code", suggestedModels: provider.suggestedModels },
    ]);
    expect(registry.get("claude-code")).toBe(provider);
    expect(registry.get("ollama")).toBeUndefined();
    expect(() => registry.require("ollama")).toThrow(ProviderFailure);
    expect(await registry.detectAll()).toEqual([
      { id: "claude-code", detection: expect.objectContaining({ status: "ready" }) as unknown },
    ]);
    expect(() => createProviderRegistry([provider, provider])).toThrow();
  });

  it("tests a provider with one tiny request and returns one line", async () => {
    const { provider, runs } = setup(() => ok(envelope({ result: "\nReady to help you study!\nSecond line." })));
    const reply = await testProvider(provider, { signal: new AbortController().signal, model: "haiku" });
    expect(reply).toBe("Ready to help you study!");
    expect(runs[0]?.args[(runs[0]?.args.indexOf("--model") ?? 0) + 1]).toBe("haiku");
  });

  it("turns failures into a result the bridge can carry", async () => {
    const { provider } = setup(() => ok(envelope({ is_error: true, result: "Usage limit reached" }), 1));
    const log = vi.fn();
    const failed = await toProviderResult(() => provider.generate(request()), log);
    expect(failed).toEqual({
      ok: false,
      error: { code: "usage-limit", message: expect.stringContaining("usage limit") as unknown },
    });
    expect(await toProviderResult(async () => "fine", log)).toEqual({ ok: true, value: "fine" });

    const unexpected = await toProviderResult(async () => {
      throw new Error("C:\\secret\\path exploded");
    }, log);
    expect(unexpected).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(JSON.stringify([unexpected, log.mock.calls])).not.toContain("secret");
  });
});
