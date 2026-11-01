require 'json'
require 'open3'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
# Development pods skip prepare_command. Resolve verified prebuilt artifacts at
# podspec evaluation too, so file:/git:/tarball dependencies behave identically.
precompiled = ENV['ANYDOC_BUILD_MODULE'] != '1' && defined?(Expo::PrecompiledModules) && Expo::PrecompiledModules.has_prebuilt_xcframework?('AnyDoc')
if precompiled
  app_root = Pod::Config.instance.installation_root.parent.to_s
  _, status = Open3.capture2('node', File.join(__dir__, '../scripts/prebuilt-profile.mjs'), app_root)
  raise 'AnyDoc prebuilt SDK profile does not match this app. Add @bru02/anydoc to expo.autolinking.ios.buildFromSource or install a matching prebuilt package.' unless status.success?
end
unless precompiled || ENV['ANYDOC_SKIP_NATIVE_DOWNLOAD'] == '1'
  raise 'Cannot prepare AnyDoc native artifacts' unless system('ruby', File.join(__dir__, '../scripts/fetch-native.rb'), 'ios')
end

Pod::Spec.new do |s|
  s.name = 'AnyDoc'
  s.version = '0.2.0'
  s.summary = package['description']
  s.description = 'File-backed AnyDoc and LiteParse extraction, off the JavaScript thread.'
  s.license = { :type => 'MIT', :file => '../LICENSE' }
  s.author = 'Bruno Toldy'
  s.homepage = 'https://github.com/bru02/anydoc'
  s.source = { :git => 'https://github.com/bru02/anydoc.git' }
  s.platforms = { :ios => '17.0' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  if precompiled && Expo::PrecompiledModules.try_link_with_prebuilt_xcframework(s)
    s.vendored_frameworks = ['AnyDoc.xcframework', 'pdfium.xcframework']
    s.license = { :type => 'MIT', :file => 'LICENSE' }
    s.preserve_paths = ['Licenses/**/*', 'artifacts/**/*']
  else
    s.source_files = '*.swift'
    s.vendored_frameworks = 'Frameworks/AnyDocCore.xcframework', 'Frameworks/pdfium.xcframework'
    s.preserve_paths = 'Frameworks/Licenses/**/*'
  end
  s.libraries = 'c++', 'iconv', 'resolv'
  s.frameworks = 'Security', 'SystemConfiguration', 'Vision', 'CoreGraphics'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
