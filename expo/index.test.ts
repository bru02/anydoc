import { expect, mock, test } from "bun:test";

const calls: unknown[][] = [];
mock.module("expo", () => ({
  requireOptionalNativeModule: () => ({
    extractFile: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "ok", text: "Native text" };
    },
  }),
}));

const { extractFile, isAvailable } = await import("./index.js");

test("only paths and bounded limits cross the native bridge", async () => {
  expect(isAvailable()).toBe(true);
  expect(await extractFile("file:///cache/deck.pptx", "deck.pptx")).toEqual({ status: "ok", text: "Native text" });
  expect(calls.at(-1)).toEqual(["file:///cache/deck.pptx", "deck.pptx", 67108864, 1000000, 1000]);
});

test("rejects invalid limits and NUL paths before native conversion", async () => {
  for (const limit of [-1, 0, 1.2, NaN, Infinity, 2 ** 32]) {
    await expect(extractFile("/cache/a.pdf", "a.pdf", { maxChars: limit })).rejects.toThrow(RangeError);
  }
  await expect(extractFile("/cache/a\0.pdf", "a.pdf")).rejects.toThrow(TypeError);
});
