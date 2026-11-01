import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fixture = await mkdtemp(path.join(tmpdir(), "anydoc-sdk-profile-"));
afterAll(() => rm(fixture, { recursive: true, force: true }));
await mkdir(path.join(fixture, "scripts"));
await mkdir(path.join(fixture, "prebuilds"));
await mkdir(path.join(fixture, "app/android"), { recursive: true });
await writeFile(path.join(fixture, "scripts/prebuilt-profile.mjs"), await readFile(new URL("./prebuilt-profile.mjs", import.meta.url)));
const dependencies = { expo: "58.0.22", "expo-modules-core": "58.0.29", "react-native": "0.88.1" };
const profile = path.join(fixture, "prebuilds/profile.json");
await writeFile(profile, JSON.stringify({ dependencies }));
for (const [name, version] of Object.entries(dependencies)) {
  const location = path.join(fixture, "app/node_modules", name);
  await mkdir(location, { recursive: true });
  await writeFile(path.join(location, "package.json"), JSON.stringify({ name, version }));
}
const status = () => spawnSync(process.execPath, [path.join(fixture, "scripts/prebuilt-profile.mjs"), path.join(fixture, "app/android")]).status;

test("accepts the matching SDK through Android's parent node_modules", () => expect(status()).toBe(0));
test("rejects a different native ABI and a missing profile", async () => {
  await writeFile(profile, JSON.stringify({ dependencies: { ...dependencies, "expo-modules-core": "58.0.30" } }));
  expect(status()).toBe(1);
  await rm(profile);
  expect(status()).toBe(1);
});
