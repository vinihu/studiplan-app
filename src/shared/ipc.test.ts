import { describe, expect, it } from "vitest";
import { channelName, ipcContract, listChannels } from "./ipc";

describe("ipc contract", () => {
  it("derives a namespaced channel name", () => {
    expect(channelName("app", "getInfo")).toBe("studiplan:app:getInfo");
  });

  it("lists every call of the contract exactly once", () => {
    const channels = listChannels();
    const expected = Object.values(ipcContract).reduce(
      (count, methods) => count + Object.keys(methods).length,
      0,
    );

    expect(channels).toContainEqual(["app", "getInfo"]);
    expect(channels).toHaveLength(expected);

    const names = channels.map(([namespace, method]) => channelName(namespace, method));
    expect(new Set(names).size).toBe(names.length);
  });
});
