import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = fileURLToPath(new URL("../", import.meta.url));
export function run(command, args, cwd, extra = {}, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", env: { ...process.env, CI: "1", ANYDOC_SKIP_NATIVE_DOWNLOAD: "1", ...extra } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.status}`);
  return result.stdout;
}
export async function sample(platform, name, dependency, source = false) {
  const directory = path.join(root, "native", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name, version: "1.0.0", private: true, main: "node_modules/expo/AppEntry.js",
    dependencies: { expo: "58.0.22", "expo-modules-core": "58.0.29", react: "19.3.1", "react-native": "0.88.1", "@bru02/anydoc": dependency },
    ...(source ? { expo: { autolinking: { ios: { buildFromSource: ["@bru02/anydoc"] }, android: { buildFromSource: ["bru02-anydoc"] } } } } : {}),
  }));
  await writeFile(path.join(directory, "app.json"), JSON.stringify({ expo: { name: "AnyDocCheck", slug: "anydoc-check", ios: { bundleIdentifier: "app.anydoc.check", deploymentTarget: "17.0" }, android: { package: "app.anydoc.check" } } }));
  await writeFile(path.join(directory, "App.js"), "import { isAvailable } from '@bru02/anydoc/expo';\nexport default function App() { isAvailable(); return null; }\n");
  run("bun", ["install", "--ignore-scripts"], directory);
  const pkg = path.join(directory, "node_modules/@bru02/anydoc");
  if (source) {
    if (platform === "ios") await cp(path.join(root, "native/dist/ios"), path.join(pkg, "ios/Frameworks"), { recursive: true });
    else await cp(path.join(root, "native/dist/android/jniLibs"), path.join(pkg, "android/src/main/jniLibs"), { recursive: true });
  }
  run("bun", ["x", "expo", "prebuild", "--platform", platform, "--no-install", "--no-clean"], directory);
  if (platform === "ios") run("pod", ["install"], path.join(directory, "ios"), source ? { ANYDOC_BUILD_MODULE: "1" } : {});
  return { directory, pkg };
}
export async function profile(directory, destination) {
  const dependencies = {};
  for (const name of ["expo", "expo-modules-core", "react-native"]) dependencies[name] = JSON.parse(await readFile(path.join(directory, "node_modules", name, "package.json"), "utf8")).version;
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "profile.json"), JSON.stringify({ dependencies, moduleVersion: "0.2.0" }, null, 2) + "\n");
}
