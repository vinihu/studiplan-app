import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderResult } from "@shared/providers";
import type { TaskProgress } from "@shared/tasks";
import { createSettingsStore } from "../settings";
import type { SettingsStore } from "../settings";
import { createTaskRegistry } from "../tasks";
import type { TaskRegistry } from "../tasks";
import { failure } from "./errors";
import type { GenerateRequest, Provider } from "./provider";
import { createProviderRegistry } from "./registry";
import { createProviderService } from "./service";
import type { ProviderService } from "./service";

let directory: string;
let settings: SettingsStore;
let tasks: TaskRegistry;
let service: ProviderService;
let requests: GenerateRequest[];
let progress: TaskProgress[];
let logged: string[];
let answer: (request: GenerateRequest) => Promise<string>;

const ID = "request-0001";

/** A provider that waits until it is aborted, the way a real child process is killed. */
function untilAborted(request: GenerateRequest): Promise<string> {
  return new Promise((_, reject) => {
    const stop = (): void => reject(failure("cancelled", "Claude Code"));
    if (request.signal.aborted) stop();
    else request.signal.addEventListener("abort", stop, { once: true });
  });
}

function build(testTimeoutMs?: number): ProviderService {
  const provider: Provider = {
    id: "claude-code",
    label: "Claude Code",
    suggestedModels: [{ id: "sonnet", label: "Sonnet" }],
    detect: async () => ({ available: true, status: "ready", detail: "Claude Code 2.1.0 is installed and signed in.", version: "2.1.0" }),
    generate: (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return createProviderService({
    registry: createProviderRegistry([provider]),
    settings,
    tasks,
    progress: (report) => progress.push(report),
    log: (message) => logged.push(message),
    ...(testTimeoutMs === undefined ? {} : { testTimeoutMs }),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "studiplan-ai-"));
  settings = createSettingsStore(directory);
  tasks = createTaskRegistry();
  requests = [];
  progress = [];
  logged = [];
  answer = async () => "Ready to help you study.\nA second line that is not shown.";
  service = build();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function code<T>(result: ProviderResult<T>): string {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  expect(result.error.message.length).toBeGreaterThan(10);
  return result.error.code;
}

describe("listing and detecting", () => {
  it("lists the providers of this version with their models, and detects them", async () => {
    expect(service.list()).toEqual([
      { id: "claude-code", label: "Claude Code", suggestedModels: [{ id: "sonnet", label: "Sonnet" }] },
    ]);
    expect(await service.detectAll()).toEqual([
      {
        id: "claude-code",
        detection: { available: true, status: "ready", detail: "Claude Code 2.1.0 is installed and signed in.", version: "2.1.0" },
      },
    ]);
    // Detecting never spends a request.
    expect(requests).toEqual([]);
  });
});

describe("the chosen provider and model", () => {
  it("starts with nothing chosen", async () => {
    expect(await service.getSettings()).toEqual({ defaultProvider: null, models: {} });
  });

  it("saves the default provider and the model, and reads them back from disk", async () => {
    expect(value(await service.setDefault("claude-code"))).toEqual({ defaultProvider: "claude-code", models: {} });
    expect(value(await service.setModel("claude-code", "  opus "))).toEqual({
      defaultProvider: "claude-code",
      models: { "claude-code": "opus" },
    });
    expect(JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "claude-code",
      models: { "claude-code": "opus" },
    });
    expect(await build().getSettings()).toEqual({ defaultProvider: "claude-code", models: { "claude-code": "opus" } });

    expect(value(await service.setModel("claude-code", null))).toEqual({ defaultProvider: "claude-code", models: {} });
    expect(value(await service.setDefault(null))).toEqual({ defaultProvider: null, models: {} });
  });

  it("leaves the other settings alone", async () => {
    const root = path.join(directory, "library");
    await settings.update({ libraryRoot: root });
    await service.setDefault("claude-code");
    await service.setModel("claude-code", "haiku");
    expect(await settings.read()).toEqual({ libraryRoot: root, defaultProvider: "claude-code", models: { "claude-code": "haiku" } });
  });

  it("keeps both when two changes are made at the same moment", async () => {
    await Promise.all([service.setModel("claude-code", "opus"), service.setDefault("claude-code")]);
    expect(await service.getSettings()).toEqual({ defaultProvider: "claude-code", models: { "claude-code": "opus" } });
  });

  it("refuses a provider this version does not have, and what is not a provider at all", async () => {
    // Known to the app, arriving later: a sentence, not a crash, and nothing is stored.
    const later = await service.setDefault("ollama");
    expect(code(later)).toBe("failed");
    expect(code(await service.setModel("codex", "gpt-5"))).toBe("failed");
    for (const bad of [undefined, 5, "", "gpt", {}, ["claude-code"]]) {
      expect(code(await service.setDefault(bad)), String(bad)).toBe("invalid-request");
      expect(code(await service.setModel(bad, "sonnet")), String(bad)).toBe("invalid-request");
    }
    expect(await settings.read()).toEqual({});
  });

  it("refuses a model name that is not one", async () => {
    for (const bad of ["", "   ", "two words", "--dangerously", "a;b", "x".repeat(101), "bad\nname"]) {
      const result = await service.setModel("claude-code", bad);
      expect(code(result), JSON.stringify(bad)).toBe("model-unavailable");
    }
    for (const bad of [undefined, 5, {}, ["sonnet"]]) {
      expect(code(await service.setModel("claude-code", bad)), String(bad)).toBe("invalid-request");
    }
    expect(await settings.read()).toEqual({});
  });

  it("hides a stored provider this version does not have, without deleting it", async () => {
    await writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({ defaultProvider: "ollama", models: { ollama: "llama3.2:3b", "claude-code": "sonnet" } }),
    );
    expect(await service.getSettings()).toEqual({ defaultProvider: null, models: { "claude-code": "sonnet" } });
    await service.setModel("claude-code", "opus");
    expect(await settings.read()).toEqual({ defaultProvider: "ollama", models: { ollama: "llama3.2:3b", "claude-code": "opus" } });
  });
});

describe("the Test button", () => {
  it("returns the first line of a real answer and reports progress", async () => {
    const reply = value(await service.test("claude-code", { requestId: ID }));
    expect(reply.reply).toBe("Ready to help you study.");
    expect(reply.model).toBeNull();
    expect(reply.durationMs).toBeGreaterThanOrEqual(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.parts).toEqual([]);
    expect(requests[0]!.model).toBeUndefined();
    expect(progress).toEqual([{ requestId: ID, message: "Asking Claude Code…", fraction: null }]);
    expect(tasks.size).toBe(0);
  });

  it("uses the saved model, or the one named in the call", async () => {
    await service.setModel("claude-code", "opus");
    expect(value(await service.test("claude-code", { requestId: ID })).model).toBe("opus");
    expect(requests[0]!.model).toBe("opus");
    expect(value(await service.test("claude-code", { requestId: ID, model: " haiku " })).model).toBe("haiku");
    expect(requests[1]!.model).toBe("haiku");
  });

  it("runs one test of an AI at a time", async () => {
    answer = untilAborted;
    const first = service.test("claude-code", { requestId: ID });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A second one, with an id of its own, is turned down and starts nothing.
    const second = await service.test("claude-code", { requestId: "request-0002" });
    expect(code(second)).toBe("busy");
    expect(requests).toHaveLength(1);
    expect(tasks.cancel(ID)).toBe(true);
    expect(code(await first)).toBe("cancelled");
    // And once it is over, the next one runs.
    answer = async () => "Ready.";
    expect(value(await service.test("claude-code", { requestId: "request-0003" })).reply).toBe("Ready.");
  });

  it("can be cancelled while it runs", async () => {
    answer = untilAborted;
    const running = service.test("claude-code", { requestId: ID });
    // No await in between: the cancel arrives right behind the call, as over IPC.
    expect(tasks.cancel(ID)).toBe(true);
    const result = await running;
    expect(code(result)).toBe("cancelled");
    expect(tasks.size).toBe(0);
    expect(tasks.cancel(ID)).toBe(false);
  });

  it("can be cancelled after the request has started", async () => {
    answer = untilAborted;
    const running = service.test("claude-code", { requestId: ID });
    await new Promise((done) => setTimeout(done, 30));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    expect(tasks.cancel(ID)).toBe(true);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(code(await running)).toBe("cancelled");
  });

  it("stops by itself after its time limit, and says so", async () => {
    service = build(40);
    answer = untilAborted;
    const result = await service.test("claude-code", { requestId: ID });
    expect(code(result)).toBe("timed-out");
    expect(!result.ok && result.error.message).toContain("took too long");
    expect(requests[0]!.signal.aborted).toBe(true);
  });

  it("passes on the provider's own sentence", async () => {
    answer = async () => {
      throw failure("not-signed-in", "Claude Code");
    };
    const result = await service.test("claude-code", { requestId: ID });
    expect(result).toEqual({
      ok: false,
      error: { code: "not-signed-in", message: "Claude Code is installed but not signed in. Open Claude Code once, sign in, then try again." },
    });
  });

  it("turns an unexpected error into a sentence and logs no detail of it", async () => {
    answer = async () => {
      throw new Error("C:\\Users\\someone\\secret");
    };
    const result = await service.test("claude-code", { requestId: ID });
    expect(code(result)).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(logged.join(" ")).not.toContain("secret");
  });

  it("refuses malformed arguments without sending a request", async () => {
    for (const options of [undefined, null, "request-0001", {}, { requestId: "short" }, { requestId: 12345678 }]) {
      expect(code(await service.test("claude-code", options)), JSON.stringify(options)).toBe("invalid-request");
    }
    expect(code(await service.test("nope", { requestId: ID }))).toBe("invalid-request");
    expect(code(await service.test("ollama", { requestId: ID }))).toBe("failed");
    expect(code(await service.test("claude-code", { requestId: ID, model: 5 }))).toBe("invalid-request");
    expect(code(await service.test("claude-code", { requestId: ID, model: "two words" }))).toBe("model-unavailable");
    expect(requests).toEqual([]);
    expect(tasks.size).toBe(0);
  });

  it("refuses a second test under an id that is still running", async () => {
    answer = untilAborted;
    const first = service.test("claude-code", { requestId: ID });
    expect(code(await service.test("claude-code", { requestId: ID }))).toBe("invalid-request");
    tasks.cancel(ID);
    expect(code(await first)).toBe("cancelled");
  });
});
