# frozen_string_literal: true
# typed: strict

module E621Stream
  class Client
    class Options < T::Struct
      const(:subscriptions, T::Array[Subscription])
      # Your e621 username and an api key, from Account > Manage API Access.
      const(:username, T.nilable(String), default: nil)
      const(:api_key, T.nilable(String), default: nil)
      const(:url, String, default: "wss://e621.stream/ws")
      # A name for your client, shown in the server's logs.
      const(:client, T.nilable(String), default: nil)
      # An event id (or a millisecond timestamp) to replay from. After that, reconnecting resumes from the last event.
      const(:cursor, T.nilable(T.any(String, Integer)), default: nil)
      # Reconnects with backoff when the connection drops, unless the server closed it for something retrying won't fix.
      const(:reconnect, T::Boolean, default: true)
    end
  end
end
