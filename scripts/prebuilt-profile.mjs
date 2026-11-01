import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
export function matchesProfile(appRoot) {
  try {
    const profile = JSON.parse(readFileSync(path.join(root, "prebuilds/profile.json"), "utf8"));
    const require = createRequire(path.join(appRoot, "package.json"));
    return ["expo", "expo-modules-core", "react-native"].every(name =>
      require(`${name}/package.json`).version === profile.dependencies[name]);
  } catch {
    return false;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(matchesProfile(process.argv[2] ?? process.cwd()) ? 0 : 1);
