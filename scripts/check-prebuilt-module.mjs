import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { root, run, sample } from "./expo-sample.mjs";

const platform = process.argv[2];
if (!["ios", "android"].includes(platform)) throw new Error("Expected ios or android");
const archive = path.join(root, "native/module-dist/anydoc-expo-sdk58.tgz");
const { directory, pkg } = await sample(platform, `module-consumer-${platform}`, `file:${archive}`);
// A binary consumer must not need these source files. Removing them also turns
// accidental source fallback into a real build failure, rather than a green CI.
if (platform === "android") {
  await rm(path.join(pkg, "android/src/main/java"), { recursive: true, force: true });
  const android = path.join(directory, "android");
  const projects = run("./gradlew", ["projects", "--console=plain", "--no-daemon"], android, {}, true);
  if (projects.includes("Project ':bru02-anydoc'")) throw new Error("AnyDoc was autolinked as a source project");
  const dependencies = run("./gradlew", [":app:dependencies", "--configuration", "releaseRuntimeClasspath", "--console=plain", "--no-daemon"], android, {}, true);
  if (!dependencies.includes("app.anydoc:expo.modules.anydoc:0.2.0")) throw new Error("The app did not consume the prebuilt AAR");
  run("./gradlew", [":app:assembleRelease", "--no-daemon"], android);
} else {
  for (const file of ["AnyDocModule.swift", "NativeOCR.swift"]) await rm(path.join(pkg, "ios", file));
  const ios = path.join(directory, "ios");
  if (!existsSync(path.join(ios, "Pods/AnyDoc/AnyDoc.xcframework"))) throw new Error("CocoaPods did not install the precompiled module");
  run("ruby", ["-rxcodeproj", "-e", "p=Xcodeproj::Project.open('Pods/Pods.xcodeproj'); t=p.targets.find{|x|x.name=='AnyDoc'}; abort('AnyDoc Swift sources are still compiled') if t && t.source_build_phase.files.any?"], ios);
  for (const [configuration, sdk, destination] of [["Release", "iphoneos", "generic/platform=iOS"], ["Debug", "iphonesimulator", "generic/platform=iOS Simulator"]]) {
    run("xcodebuild", ["-workspace", "AnyDocCheck.xcworkspace", "-scheme", "AnyDocCheck", "-configuration", configuration, "-sdk", sdk, "-destination", destination, "CODE_SIGNING_ALLOWED=NO"], ios);
  }
}
