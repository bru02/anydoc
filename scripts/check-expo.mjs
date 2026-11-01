import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const platform = process.argv[2];
if (!["ios", "android"].includes(platform)) throw new Error("Expected ios or android");
const sample = path.join(root, "native/expo-check");
await mkdir(sample, { recursive: true });
await writeFile(path.join(sample, "package.json"), JSON.stringify({
  name: "anydoc-expo-check", version: "1.0.0", private: true,
  main: "node_modules/expo/AppEntry.js",
  dependencies: { expo: "~58.0.22", react: "19.3.1", "react-native": "0.88.1", "@bru02/anydoc": "file:../.." },
}));
await writeFile(path.join(sample, "app.json"), JSON.stringify({ expo: {
  name: "AnyDocCheck", slug: "anydoc-check", ios: { bundleIdentifier: "app.anydoc.check", deploymentTarget: "17.0" },
  android: { package: "app.anydoc.check" },
} }));
await writeFile(path.join(sample, "App.js"), "import { isAvailable } from '@bru02/anydoc/expo';\nexport default function App() { isAvailable(); return null; }\n");
function run(command, args, cwd = sample) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "1", ANYDOC_SKIP_NATIVE_DOWNLOAD: "1" } });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
if (platform === "ios") {
  await cp(path.join(root, "native/dist/ios"), path.join(root, "ios/Frameworks"), { recursive: true });
} else {
  await cp(path.join(root, "native/dist/android/jniLibs"), path.join(root, "android/src/main/jniLibs"), { recursive: true });
}
run("bun", ["install", "--ignore-scripts"]);
run("bun", ["x", "expo", "prebuild", "--platform", platform, "--no-install", "--no-clean"]);
if (platform === "ios") {
  run("pod", ["install"], path.join(sample, "ios"));
  run("xcodebuild", ["-workspace", "AnyDocCheck.xcworkspace", "-scheme", "AnyDocCheck", "-configuration", "Release", "-sdk", "iphoneos", "-destination", "generic/platform=iOS", "CODE_SIGNING_ALLOWED=NO"], path.join(sample, "ios"));
} else {
  // Artifact files were supplied by this job; no release download is needed.
  run("./gradlew", [":app:assembleRelease", "-x", "prepareAnyDocNative", "--no-daemon"], path.join(sample, "android"));
}
