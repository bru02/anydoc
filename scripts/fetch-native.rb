# Downloads a pinned release once, verifies SHA-256, then installs atomically.
# No Rust toolchain, PDFium compilation, Node process, or simulator is needed.
require 'json'
require 'digest'
require 'fileutils'
require 'tmpdir'
require 'open-uri'

root = File.expand_path('..', __dir__)
platform = ARGV.fetch(0)
raise 'Expected ios or android' unless %w[ios android].include?(platform)
manifest = JSON.parse(File.read(File.join(root, 'native/artifacts.json')))
entry = manifest.fetch(platform)
raise "Native #{platform} artifact has not been published for #{manifest['tag']}" unless entry
destination = File.join(root, platform == 'ios' ? 'ios/Frameworks' : 'android/src/main/jniLibs')
stamp = File.join(destination, '.anydoc-sha256')
exit if File.file?(stamp) && File.read(stamp).strip == entry.fetch('sha256')

url = "https://github.com/bru02/anydoc/releases/download/#{manifest.fetch('tag')}/anydoc-#{platform}.tar.gz"
FileUtils.mkdir_p(File.dirname(destination))
# Installers for different build variants may run concurrently.
File.open(File.join(File.dirname(destination), '.anydoc-install.lock'), 'w') do |lock|
  lock.flock(File::LOCK_EX)
  exit if File.file?(stamp) && File.read(stamp).strip == entry.fetch('sha256')
  Dir.mktmpdir('anydoc-native-') do |temporary|
    archive = File.join(temporary, 'native.tar.gz')
    URI.open(url) { |input| IO.copy_stream(input, archive) }
    raise 'AnyDoc native artifact checksum mismatch' unless Digest::SHA256.file(archive).hexdigest == entry.fetch('sha256')
    unpacked = File.join(temporary, 'unpacked')
    FileUtils.mkdir_p(unpacked)
    raise 'Cannot unpack AnyDoc native artifact' unless system('tar', '-xzf', archive, '-C', unpacked)
    source = platform == 'ios' ? unpacked : File.join(unpacked, 'jniLibs')
    FileUtils.rm_rf(destination)
    FileUtils.cp_r(source, destination)
    if platform == 'android'
      FileUtils.cp_r(File.join(unpacked, 'Licenses'), File.join(root, 'android/Licenses'))
    end
    File.write(stamp, entry.fetch('sha256'))
  end
end
