# frozen_string_literal: true
# typed: strict

module E621Stream
  # One event from the stream. `data` is the record as e621's api returns it, or for update events
  # `{ "<resource>" => record, "changes" => ... }`, see https://e621.stream/events/
  class Event < T::Struct
    extend(T::Sig)

    # The event's cursor, pass it as `cursor:` to resume after it. Private events have no cursor.
    const(:id, String)
    const(:type, String)
    # When it happened on e621.
    const(:time, String)
    const(:data, T::Hash[String, T.untyped])
    # Only for private events, which are polled with your own credentials and never stored.
    const(:private, T::Boolean, default: false)
    # Sent late by a recovery, so it's out of order with the rest. See https://e621.stream/replaying/#recoveries
    const(:recovered, T::Boolean, default: false)

    sig { returns(T::Boolean) }
    def private?
      private
    end

    sig { returns(T::Boolean) }
    def recovered?
      recovered
    end
  end
end
