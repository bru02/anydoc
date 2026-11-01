import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { root, run } from "./expo-sample.mjs";

// Expo's composer folds internal binary targets into the product and rewrites
// their interface imports. Keep that build input out of consumer distributions.
for (const flavor of ["debug", "release"]) {
  const archive = path.join(root, "prebuilds/output", flavor, "xcframeworks/AnyDoc.tar.gz");
  const staging = await mkdtemp(path.join(tmpdir(), "anydoc-package-"));
  try {
    run("tar", ["-xzf", archive, "-C", staging], root);
    const interfaces = path.join(staging, "AnyDoc.xcframework");
    let count = 0;
    async function check(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await check(file);
        else if (entry.name.endsWith(".swiftinterface")) {
          count++;
          if (/\bimport\s+AnyDocCore\b/.test(await readFile(file, "utf8"))) throw new Error("AnyDoc exposes a build-only Rust module");
        }
      }
    }
    await check(interfaces);
    if (!count) throw new Error("Missing distribution Swift interfaces");
    await rm(path.join(staging, "AnyDocCore.xcframework"), { recursive: true, force: true });
    run("tar", ["-czf", archive, "-C", staging, "AnyDoc.xcframework", "pdfium.xcframework", "Licenses", "LICENSE"], root);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
