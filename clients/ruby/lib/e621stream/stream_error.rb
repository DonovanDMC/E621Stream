# frozen_string_literal: true
# typed: strict

module E621Stream
  # Sent by the server right before it closes the connection, `code` is one of CloseCodes.
  class StreamError < StandardError
    extend(T::Sig)

    sig { returns(Integer) }
    attr_reader(:code)

    sig { params(code: Integer, message: String).void }
    def initialize(code, message)
      super(message)
      @code = code
    end
  end
end
