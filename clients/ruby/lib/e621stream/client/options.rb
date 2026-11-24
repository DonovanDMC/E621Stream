# frozen_string_literal: true
# typed: strict

module E621Stream
  class Client
    class Options < T::Struct
      const(:subscriptions, T::Array[Subscription])
      const(:username, T.nilable(String), default: nil)
      const(:api_key, T.nilable(String), default: nil)
      const(:token, T.nilable(String), default: nil)
      const(:url, String, default: "https://e621.stream")
      const(:client, T.nilable(String), default: nil)
      const(:cursor, T.nilable(T.any(String, Integer)), default: nil)
      const(:reconnect, T::Boolean, default: true)
    end
  end
end
