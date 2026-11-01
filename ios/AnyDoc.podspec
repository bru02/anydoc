require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
# Development pods skip prepare_command. Resolve verified prebuilt artifacts at
# podspec evaluation too, so file:/git:/tarball dependencies behave identically.
unless ENV['ANYDOC_SKIP_NATIVE_DOWNLOAD'] == '1'
  raise 'Cannot prepare AnyDoc native artifacts' unless system('ruby', File.join(__dir__, '../scripts/fetch-native.rb'), 'ios')
end

Pod::Spec.new do |s|
  s.name = 'AnyDoc'
  s.version = '0.1.0'
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
  s.source_files = 'AnyDocModule.swift'
  s.vendored_frameworks = 'Frameworks/AnyDocCore.xcframework', 'Frameworks/pdfium.xcframework'
  s.preserve_paths = 'Frameworks/Licenses/**/*'
  s.libraries = 'c++', 'iconv', 'resolv'
  s.frameworks = 'Security', 'SystemConfiguration'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
