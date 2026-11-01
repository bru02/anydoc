// Expo producer pinned by .github/workflows/prebuilt-module.yml.
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, run } from "./expo-sample.mjs";

const [app, installed] = process.argv.slice(2);
const requireApp = createRequire(path.join(app, "package.json"));
const expo = path.join(root, ".ci/expo");
const tools = path.join(expo, "tools");
const manifestPath = path.join(tools, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const [name, version] of Object.entries(manifest.dependencies)) {
  if (version.startsWith("workspace:")) manifest.dependencies[name] = requireApp(`${name}/package.json`).version;
}
// Only install the producer's runtime dependencies. Published workspace tools
// supply their compiled entrypoints, while Bun executes the upstream TS files.
delete manifest.devDependencies;
delete manifest.scripts;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
run("bun", ["install", "--ignore-scripts"], tools);

const destination = path.join(expo, "packages/anydoc");
await mkdir(destination, { recursive: true });
for (const name of ["package.json", "expo-module.config.json", "spm.config.json", "ios"]) {
  await cp(path.join(installed, name), path.join(destination, name), { recursive: true });
}
await symlink(path.join(app, "node_modules"), path.join(destination, "node_modules"), "dir");
const bare = path.join(expo, "apps/bare-expo/node_modules");
await rm(bare, { recursive: true, force: true });
await symlink(path.join(app, "node_modules"), bare, "dir");

// Compile against the actual installed SDK, rather than Expo main's versions.
// Reuse ExpoModulesCore's published binaries. ExpoModulesJSI has a source-owned
// custom producer and ships its source, so run that producer with the same SDK.
for (const name of ["expo-modules-core", "expo-modules-jsi"]) {
  const source = path.dirname(requireApp.resolve(`${name}/package.json`));
  const target = path.join(expo, "packages", name);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await symlink(path.join(app, "node_modules"), path.join(target, "node_modules"), "dir");
}
for (const flavor of ["debug", "release"]) {
  const source = path.join(expo, "packages/expo-modules-core/prebuilds/output", flavor, "xcframeworks");
  const target = path.join(expo, "packages/expo-modules-core/.expo-prebuild/output", flavor, "xcframeworks");
  await mkdir(target, { recursive: true });
  for (const name of ["ExpoModulesCore", "ExpoModulesWorklets"]) run("tar", ["-xzf", path.join(source, `${name}.tar.gz`), "-C", target], root);
}
const rn = path.dirname(requireApp.resolve("react-native/package.json"));
const properties = await readFile(path.join(rn, "sdks/hermes-engine/version.properties"), "utf8");
const { resolveHermesVersion } = await import(pathToFileURL(path.join(tools, "src/prebuilds/Utils.ts")));
const { ensureSupportedToolchainAsync } = await import(pathToFileURL(path.join(tools, "src/prebuilds/Toolchain.ts")));
const { runPrebuildPackagesAsync } = await import(pathToFileURL(path.join(tools, "src/commands/PrebuildPackages.ts")));
await ensureSupportedToolchainAsync();
const options = {
  reactNativeVersion: requireApp("react-native/package.json").version,
  hermesVersion: resolveHermesVersion(Object.fromEntries(properties.split("\n").filter(line => line.includes("=")).map(line => line.trim().split("=", 2))), {}, process.env),
  concurrency: 1, exactPackage: true, verbose: true,
};
for (const name of ["expo-modules-jsi", "@bru02/anydoc"]) {
  const result = await runPrebuildPackagesAsync([name], options);
  if (result.exitCode) throw new Error(`Expo's producer failed for ${name}`);
}
