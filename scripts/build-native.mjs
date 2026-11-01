import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const pdfium = JSON.parse(await readFile("native/pdfium.json", "utf8"));
const output = path.join(root, "native/dist");

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env }, cwd: root });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error ?? args.join(" ")}`);
}

async function download(asset) {
  const directory = path.join(root, "native/vendor", asset);
  if (process.env.ANYDOC_PDFIUM_FROM_CI === "1" && !asset.startsWith("pdfium-mac-")) {
    const source = JSON.parse(await readFile(path.join(directory, "anydoc-source.json"), "utf8"));
    if (source.buildCommit !== pdfium.buildCommit || source.branch !== pdfium.tag) {
      throw new Error(`Unexpected PDFium build provenance: ${asset}`);
    }
    return directory;
  }
  if (!pdfium.assets[asset]) throw new Error(`${asset} must be built by the matching PDFium mobile workflow`);
  await mkdir(directory, { recursive: true });
  const archive = `${directory}.tgz`;
  const response = await fetch(`https://github.com/${pdfium.repository}/releases/download/${pdfium.tag}/${asset}.tgz`);
  if (!response.ok) throw new Error(`PDFium download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pdfium.assets[asset]) throw new Error(`PDFium checksum mismatch: ${asset}`);
  await writeFile(archive, bytes);
  run("tar", ["-xzf", archive, "-C", directory]);
  return directory;
}

async function framework(vendor, destination, simulator) {
  await mkdir(destination, { recursive: true });
  await cp(path.join(vendor, "lib/libpdfium.dylib"), path.join(destination, "pdfium"));
  run("install_name_tool", ["-id", "@rpath/pdfium.framework/pdfium", path.join(destination, "pdfium")]);
  await writeFile(path.join(destination, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>pdfium</string>
<key>CFBundleIdentifier</key><string>app.anydoc.pdfium</string>
<key>CFBundleName</key><string>pdfium</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>158.0.8058</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>${simulator ? "iPhoneSimulator" : "iPhoneOS"}</string></array>
</dict></plist>\n`);
}

async function build(target, asset, options = {}) {
  const vendor = await download(asset);
  run("rustup", ["target", "add", target]);
  // Emit only the binary the platform consumes, rather than linking unused
  // staticlib/cdylib/rlib variants for every architecture.
  const args = ["rustc", "--lib", "--crate-type", options.android ? "cdylib" : "staticlib", "--locked", "--release", "-p", "anydoc-mobile", "--target", target];
  if (options.android) args.push("--features", "android-jni");
  run("cargo", args, {
    PDFIUM_LIB_PATH: path.join(vendor, "lib"),
    PDFIUM_INCLUDE_PATH: path.join(vendor, "include"),
    IPHONEOS_DEPLOYMENT_TARGET: "17.0",
    ...options.env,
  });
  return vendor;
}

async function notices(vendor, destination) {
  await mkdir(destination, { recursive: true });
  await cp(path.join(vendor, "LICENSE"), path.join(destination, "PDFium-LICENSE"));
  await cp(path.join(vendor, "licenses"), path.join(destination, "pdfium"), { recursive: true });
  await cp("LICENSE", path.join(destination, "AnyDoc-LICENSE"));
  await writeFile(path.join(destination, "LiteParse-LICENSE.txt"), "LiteParse is licensed under Apache-2.0.\nhttps://github.com/run-llama/liteparse/blob/wasm-v2.17.0/LICENSE\n");
  // Complete transitive Rust notices are generated from the locked dependency graph.
  run("cargo", ["about", "generate", "-m", "native/Cargo.toml", "scripts/licenses.hbs", "-o", path.join(destination, "rust-licenses.html")]);
}

await mkdir(output, { recursive: true });
const platform = process.argv[2];
if (platform === "host") {
  const vendor = await download(process.arch === "arm64" ? "pdfium-mac-arm64" : "pdfium-mac-x64");
  run("cargo", ["test", "--locked", "-p", "anydoc-mobile"], {
    PDFIUM_LIB_PATH: path.join(vendor, "lib"), PDFIUM_INCLUDE_PATH: path.join(vendor, "include"),
    ANYDOC_TEST_PDFIUM: path.join(vendor, "lib/libpdfium.dylib"),
  });
} else if (platform === "ios") {
  const device = await build("aarch64-apple-ios", "pdfium-ios-device-arm64");
  const sim = await build("aarch64-apple-ios-sim", "pdfium-ios-simulator-arm64");
  const simX64 = await build("x86_64-apple-ios", "pdfium-ios-simulator-x64");
  const destination = path.join(output, "ios");
  await mkdir(destination, { recursive: true });
  // Combine architectures only within the simulator platform.
  run("lipo", ["-create", "target/aarch64-apple-ios-sim/release/libanydoc_mobile.a", "target/x86_64-apple-ios/release/libanydoc_mobile.a", "-output", path.join(destination, "libanydoc_sim.a")]);
  run("xcodebuild", ["-create-xcframework", "-library", path.join(root, "target/aarch64-apple-ios/release/libanydoc_mobile.a"), "-headers", path.join(root, "native/include"), "-library", path.join(destination, "libanydoc_sim.a"), "-headers", path.join(root, "native/include"), "-output", path.join(destination, "AnyDocCore.xcframework")]);
  const simFramework = path.join(destination, "sim/pdfium.framework");
  const deviceFramework = path.join(destination, "device/pdfium.framework");
  await framework(sim, simFramework, true);
  await framework(device, deviceFramework, false);
  run("lipo", ["-create", path.join(sim, "lib/libpdfium.dylib"), path.join(simX64, "lib/libpdfium.dylib"), "-output", path.join(simFramework, "pdfium")]);
  run("install_name_tool", ["-id", "@rpath/pdfium.framework/pdfium", path.join(simFramework, "pdfium")]);
  run("xcodebuild", ["-create-xcframework", "-framework", deviceFramework, "-framework", simFramework, "-output", path.join(destination, "pdfium.xcframework")]);
  await notices(device, path.join(destination, "Licenses"));
  run("tar", ["-czf", path.join(output, "anydoc-ios.tar.gz"), "-C", destination, "AnyDocCore.xcframework", "pdfium.xcframework", "Licenses"]);
} else if (platform === "android") {
  const ndk = process.env.ANDROID_NDK_HOME;
  if (!ndk) throw new Error("Set ANDROID_NDK_HOME to NDK 27 or later");
  const bin = path.join(ndk, "toolchains/llvm/prebuilt/linux-x86_64/bin");
  const targets = [
    ["aarch64-linux-android", "aarch64-linux-android", "arm64-v8a", "arm64"],
    ["armv7-linux-androideabi", "armv7a-linux-androideabi", "armeabi-v7a", "arm"],
    ["x86_64-linux-android", "x86_64-linux-android", "x86_64", "x64"],
    ["i686-linux-android", "i686-linux-android", "x86", "x86"],
  ];
  let vendor;
  const destination = path.join(output, "android");
  for (const [target, clang, abi, arch] of targets) {
    const compiler = path.join(bin, `${clang}24-clang`);
    const env = {
      [`CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_LINKER`]: compiler,
      [`CC_${target.replaceAll("-", "_")}`]: compiler,
      [`AR_${target.replaceAll("-", "_")}`]: path.join(bin, "llvm-ar"),
      // Required on 16 KiB page-size Android devices, including NDK 27 builds.
      [`CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_RUSTFLAGS`]: "-C link-arg=-Wl,-z,max-page-size=16384",
    };
    vendor = await build(target, `pdfium-android-${arch}`, { android: true, env });
    const libs = path.join(destination, "jniLibs", abi);
    await mkdir(libs, { recursive: true });
    await cp(`target/${target}/release/libanydoc_mobile.so`, path.join(libs, "libanydoc_mobile.so"));
    await cp(path.join(vendor, "lib/libpdfium.so"), path.join(libs, "libpdfium.so"));
    for (const lib of ["libanydoc_mobile.so", "libpdfium.so"]) {
      const result = spawnSync(path.join(bin, "llvm-readelf"), ["-lW", path.join(libs, lib)], { encoding: "utf8" });
      // Android's flexible page-size requirement applies to the 64-bit ABIs.
      // https://android.googlesource.com/platform/ndk/+/master/docs/BuildSystemMaintainers.md
      const requiredAlignment = ["arm64-v8a", "x86_64"].includes(abi) ? 16384 : 4096;
      const loads = result.stdout.split("\n").filter(line => line.trim().startsWith("LOAD"));
      if (result.status !== 0 || loads.length === 0 || loads.some(line => Number(line.trim().split(/\s+/).at(-1)) < requiredAlignment)) {
        throw new Error(`${abi}/${lib} does not meet ${requiredAlignment}-byte ELF alignment`);
      }
    }
  }
  await notices(vendor, path.join(destination, "Licenses"));
  run("tar", ["-czf", path.join(output, "anydoc-android.tar.gz"), "-C", destination, "jniLibs", "Licenses"]);
} else {
  throw new Error("Usage: bun scripts/build-native.mjs host|ios|android");
}
