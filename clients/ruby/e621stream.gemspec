# frozen_string_literal: true

require_relative("lib/e621stream/version")

Gem::Specification.new do |spec|
  spec.name = "e621stream"
  spec.version = E621Stream::VERSION
  spec.authors = ["Donovan_DMC"]
  spec.email = ["hewwo@yiff.rocks"]

  spec.summary = "A client for E621Stream, a live WebSocket stream of e621 activity."
  spec.description = spec.summary
  spec.homepage = "https://e621.stream"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.4.1"

  spec.metadata["allowed_push_host"] = "https://rubygems.org"
  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/DonovanDMC/E621Stream/tree/master/clients/ruby"
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir.chdir(__dir__) { Dir.glob("{lib,sorbet}/**/*", File::FNM_DOTMATCH).select { |f| File.file?(f) } + %w[README.md LICENSE] }
  spec.require_paths = ["lib"]

  spec.add_dependency("async-websocket", "~> 0.30")
  spec.add_dependency("json", ">= 2.0")
  spec.add_dependency("sorbet-runtime")
  spec.add_dependency("zeitwerk", "~> 2.6")
end
