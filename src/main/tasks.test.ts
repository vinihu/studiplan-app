import { describe, expect, it } from "vitest";
import { isRequestId, newRequestId } from "@shared/tasks";
import { createTaskRegistry } from "./tasks";

const ID = "request-0001";

describe("request ids", () => {
  it("accepts a UUID and refuses everything that is not a short plain token", () => {
    expect(isRequestId(newRequestId())).toBe(true);
    expect(newRequestId()).not.toBe(newRequestId());
    expect(isRequestId("abcDEF_1-2")).toBe(true);
    for (const bad of ["", "short", "has space 12", "a".repeat(65), "semi;colon12", 12345678, null, undefined, {}]) {
      expect(isRequestId(bad), String(bad)).toBe(false);
    }
  });
});

describe("the task registry", () => {
  it("cancels a running call through its signal and forgets it when it ends", async () => {
    const tasks = createTaskRegistry();
    let seen: AbortSignal | undefined;
    const running = tasks.run(
      ID,
      (signal) =>
        new Promise<string>((resolve) => {
          seen = signal;
          signal.addEventListener("abort", () => resolve("stopped"));
        }),
      () => "refused",
    );
    expect(tasks.size).toBe(1);
    expect(seen?.aborted).toBe(false);

    expect(tasks.cancel(ID)).toBe(true);
    expect(seen?.aborted).toBe(true);
    expect(await running).toBe("stopped");
    expect(tasks.size).toBe(0);
    // Finished: there is nothing left to cancel, and that is not an error.
    expect(tasks.cancel(ID)).toBe(false);
  });

  it("registers before the work first waits, so a cancel right behind the call finds it", async () => {
    const tasks = createTaskRegistry();
    const running = tasks.run(
      ID,
      async (signal) => {
        await Promise.resolve();
        return signal.aborted;
      },
      () => false,
    );
    // No await in between: the same order two IPC messages arrive in.
    expect(tasks.cancel(ID)).toBe(true);
    expect(await running).toBe(true);
  });

  it("forgets a call that throws", async () => {
    const tasks = createTaskRegistry();
    await expect(
      tasks.run(
        ID,
        async () => Promise.reject(new Error("boom")),
        () => null,
      ),
    ).rejects.toThrow("boom");
    expect(tasks.size).toBe(0);
  });

  it("refuses an unusable id and an id that is already running", async () => {
    const tasks = createTaskRegistry();
    for (const bad of [undefined, null, 7, "", "short", "with space 123", "x".repeat(65)]) {
      expect(
        await tasks.run<string>(
          bad,
          async () => "ran",
          (reason) => reason,
        ),
      ).toBe("invalid-id");
    }

    let release: () => void = () => {};
    const first = tasks.run<string>(
      ID,
      () => new Promise<string>((resolve) => (release = () => resolve("first"))),
      (reason) => reason,
    );
    expect(
      await tasks.run<string>(
        ID,
        async () => "second",
        (reason) => reason,
      ),
    ).toBe("already-running");
    // The refused twin did not take the first one's place or end it.
    expect(tasks.size).toBe(1);
    release();
    expect(await first).toBe("first");
    // Free again once it has ended.
    expect(
      await tasks.run<string>(
        ID,
        async () => "third",
        (reason) => reason,
      ),
    ).toBe("third");
  });

  it("does not let an old call's end remove a newer call with the same id", () => {
    const tasks = createTaskRegistry();
    const first = tasks.start(ID);
    if (!first.ok) throw new Error("expected to start");
    first.finish();
    const second = tasks.start(ID);
    if (!second.ok) throw new Error("expected to start");
    first.finish();
    expect(tasks.size).toBe(1);
    expect(tasks.cancel(ID)).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });

  it("only cancels the call it is asked to, and everything on cancelAll", () => {
    const tasks = createTaskRegistry();
    const a = tasks.start("request-aaaa");
    const b = tasks.start("request-bbbb");
    if (!a.ok || !b.ok) throw new Error("expected to start");
    expect(tasks.cancel("request-cccc")).toBe(false);
    expect(tasks.cancel({})).toBe(false);
    expect(tasks.cancel("request-aaaa")).toBe(true);
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, false]);
    expect(tasks.cancelAll()).toBe(2);
    expect(b.signal.aborted).toBe(true);
  });
});
