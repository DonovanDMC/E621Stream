# frozen_string_literal: true
# typed: strict

module E621Stream
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
