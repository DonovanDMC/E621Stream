# frozen_string_literal: true
# typed: strict

module E621Stream
  class Event < T::Struct
    extend(T::Sig)

    const(:id, String)
    const(:type, String)
    const(:time, String)
    const(:data, T::Hash[String, T.untyped])
    # What the record doesn't say itself, like who made the change.
    const(:context, T.nilable(T::Hash[String, T.untyped]), default: nil)
    const(:private, T::Boolean, default: false)
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
