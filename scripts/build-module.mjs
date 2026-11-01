import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { root, run, sample, profile } from "./expo-sample.mjs";

const platform = process.argv[2];
if (!["ios", "android"].includes(platform)) throw new Error("Expected ios or android");
const { directory, pkg } = await sample(platform, `module-build-${platform}`, `file:${root}`, true);
const output = path.join(root, "native/module-dist", platform);
await mkdir(output, { recursive: true });
await profile(directory, path.join(output, "prebuilds"));

if (platform === "android") {
  // The publication task comes from Expo's SDK 58 Gradle plugin. The AAR
  // includes the Kotlin adapter, JNI libraries, consumer rules and ML Kit POM.
  const repository = path.join(output, "local-maven-repo");
  run("./gradlew", [":bru02-anydoc:publishReleasePublicationToNPMPackageRepository", `-Pexpo.precompileAndroid.repository=${repository}`, "-x", "prepareAnyDocNative", "--no-daemon"], path.join(directory, "android"));
  const aar = path.join(repository, "app/anydoc/expo.modules.anydoc/0.2.0/expo.modules.anydoc-0.2.0.aar");
  if (!existsSync(aar)) throw new Error("Publication did not produce the module AAR");
  const members = run("unzip", ["-Z1", aar], root, {}, true);
  for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]) for (const lib of ["anydoc_mobile", "pdfium"]) {
    if (!members.includes(`jni/${abi}/lib${lib}.so`)) throw new Error(`AAR missing ${abi}/${lib}`);
  }
  if (!members.includes("classes.jar")) throw new Error("AAR missing compiled Kotlin adapter");
  const pom = await readFile(aar.replace(/\.aar$/, ".pom"), "utf8");
  if (!pom.includes("text-recognition")) throw new Error("Publication dropped the OCR runtime dependency");
} else {
  // Run Expo's pinned, unmodified prebuild pipeline, including composition and
  // Swift interface verification. Its TypeScript entry runs under Bun; no
  // private Expo release service or monorepo-wide build is needed.
  run("bun", [path.join(root, "scripts/upstream-prebuild.mjs"), directory, pkg], root);
  const built = path.join(root, ".ci/expo/packages/anydoc/.expo-prebuild/output");
  for (const flavor of ["debug", "release"]) {
    const frameworks = path.join(built, flavor, "xcframeworks");
    if (!existsSync(path.join(frameworks, "AnyDoc.xcframework"))) throw new Error(`Missing ${flavor} module`);
    for (const name of ["AnyDocCore.xcframework", "pdfium.xcframework", "Licenses"]) {
      await cp(path.join(pkg, "ios/Frameworks", name), path.join(frameworks, name), { recursive: true });
    }
    await cp(path.join(root, "LICENSE"), path.join(frameworks, "LICENSE"));
    const archives = path.join(output, "prebuilds/output", flavor, "xcframeworks");
    await mkdir(archives, { recursive: true });
    run("tar", ["-czf", path.join(archives, "AnyDoc.tar.gz"), "-C", frameworks, "AnyDoc.xcframework", "AnyDocCore.xcframework", "pdfium.xcframework", "Licenses", "LICENSE"], root);
  }
}
run("tar", ["-czf", path.join(root, `native/module-dist/full-${platform}.tar.gz`), "-C", output, ...(await readdir(output))], root);
