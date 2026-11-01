# frozen_string_literal: true

require("json")
require("zeitwerk")
require("sorbet-runtime")

# required here since the gemspec loads version.rb before zeitwerk is set up
require_relative("e621stream/version")

loader = Zeitwerk::Loader.for_gem
loader.inflector.inflect({ "e621stream" => "E621Stream" })
loader.ignore("#{__dir__}/e621stream/version.rb")
loader.setup

# A client for E621Stream, a live WebSocket stream of e621 activity. See https://e621.stream
module E621Stream
end
