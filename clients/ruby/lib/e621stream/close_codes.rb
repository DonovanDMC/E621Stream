# frozen_string_literal: true
# typed: strict

module E621Stream
  # Why the server closed the connection, see https://e621.stream/close-codes/
  module CloseCodes
    UNKNOWN_ERROR = 4000
    UNKNOWN_OP = 4001
    DECODE_ERROR = 4002
    NOT_IDENTIFIED = 4003
    AUTHENTICATION_FAILED = 4004
    ALREADY_IDENTIFIED = 4005
    INVALID_SUBSCRIPTION = 4006
    INVALID_CURSOR = 4007
    RATE_LIMITED = 4008
    SLOW_CONSUMER = 4009
    TOO_MANY_CONNECTIONS = 4010
    AUTHENTICATION_EXPIRED = 4011
    DISCONNECTED = 4012
    BANNED = 4013

    # Closing for any of these again would just get the same result, so they aren't reconnected from.
    FATAL = T.let([UNKNOWN_OP, DECODE_ERROR, AUTHENTICATION_FAILED, ALREADY_IDENTIFIED, INVALID_SUBSCRIPTION, INVALID_CURSOR, AUTHENTICATION_EXPIRED, DISCONNECTED, BANNED].freeze, T::Array[Integer])
  end
end
