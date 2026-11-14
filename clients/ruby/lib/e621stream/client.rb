# frozen_string_literal: true
# typed: strict

require("async")
require("async/http/endpoint")
require("async/http/internet")
require("async/websocket/client")

module E621Stream
  # A connection to E621Stream. Listeners run inside the client's reactor, between reading messages.
  #
  #   client = E621Stream::Client.new(username: "...", api_key: "...", subscriptions: ["post.create"])
  #   client.on("post.create") { |event| puts(event.data["post"]["id"]) }
  #   client.run
  class Client
    extend(T::Sig)

    Listener = T.type_alias { T.proc.params(arg0: T.untyped).void }
    Snapshots = T.type_alias { T::Hash[Integer, T.nilable(T::Hash[String, T.untyped])] }
    SnapshotCallback = T.type_alias { T.proc.params(snapshots: Snapshots).void }
    # An event type, `<resource>.*`, `*`, or `{ "type" => ..., "filter" => { ... } }`.
    Subscription = T.type_alias { T.any(String, T::Hash[T.any(String, Symbol), T.untyped]) }

    # Tests swap this out.
    class Connector
      extend(T::Sig)

      sig { params(url: String, block: T.proc.params(connection: T.untyped).void).void }
      def connect(url, &block)
        endpoint = Async::HTTP::Endpoint.parse(url, alpn_protocols: Async::HTTP::Protocol::HTTP11.names)
        Async::WebSocket::Client.connect(endpoint, &block)
      end

      # Gets the websocket url from the site's /info, unless it's one already.
      sig { params(url: String).returns(String) }
      def websocket_url(url)
        return url if url.match?(%r{\Awss?://}i)

        info = URI.join(url, "/info").to_s
        internet = Async::HTTP::Internet.new
        response = internet.get(info)
        raise("#{info} returned #{response.status}") unless response.success?

        websocket = JSON.parse(response.read)["websocket"]
        raise("#{info} didn't have a websocket url") unless websocket.is_a?(String)

        URI.join(url, websocket).to_s
      ensure
        response&.close
        internet&.close
      end
    end

    HEARTBEAT_SECONDS = 30
    SILENT_SECONDS = 75
    MAX_DELAY_SECONDS = 60

    sig { returns(Options) }
    attr_reader(:options)

    # The newest event received, which reconnecting resumes from.
    sig { returns(T.nilable(String)) }
    attr_reader(:cursor)

    sig do
      params(
        subscriptions: T::Array[Subscription],
        username:      T.nilable(String),
        api_key:       T.nilable(String),
        token:         T.nilable(String),
        url:           String,
        client:        T.nilable(String),
        cursor:        T.nilable(T.any(String, Integer)),
        reconnect:     T::Boolean,
        connector:     Connector,
      ).void
    end
    def initialize(subscriptions:, username: nil, api_key: nil, token: nil, url: "https://e621.stream", client: nil, cursor: nil, reconnect: true, connector: Connector.new)
      @options = T.let(Options.new(subscriptions: subscriptions, username: username, api_key: api_key, token: token, url: url, client: client, cursor: cursor, reconnect: reconnect), Options)
      @connector = connector
      @cursor = T.let(cursor&.to_s, T.nilable(String))
      @listeners = T.let(Hash.new { |hash, key| hash[key] = [] }, T::Hash[String, T::Array[Listener]])
      @connection = T.let(nil, T.untyped)
      @closing = T.let(false, T::Boolean)
      @attempt = T.let(0, Integer)
      @last_message = T.let(0.0, Float)
      @last_error = T.let(nil, T.nilable(StreamError))
      @ready = T.let(false, T::Boolean)
      @nonce = T.let(0, Integer)
      @pending_snapshots = T.let({}, T::Hash[String, SnapshotCallback])
    end

    # Listens for an event type (like "post.create"), or one of :dispatch (every event), :ready, :replay_complete,
    # :subscribed, :error, :close and :reconnecting.
    sig { params(name: T.any(String, Symbol), block: Listener).returns(T.self_type) }
    def on(name, &block)
      T.must(@listeners[name.to_s]) << block
      self
    end

    # Connects and keeps the connection going until #close is called, or the server closes it for something
    # reconnecting won't fix. Blocks, or runs as a task when called inside a reactor already.
    sig { void }
    def run
      @closing = false
      Sync do
        loop do
          code, reason = connect_once
          error = @last_error
          @last_error = nil
          reconnecting = !closing? && options.reconnect && !CloseCodes::FATAL.include?(code)
          emit("error", error) if error
          emit("close", { code: code, reason: error&.message || reason, reconnecting: reconnecting })
          break unless reconnecting

          @attempt += 1
          delay = code == CloseCodes::RATE_LIMITED ? 30 : [@attempt**2, MAX_DELAY_SECONDS].min
          delay += rand
          emit("reconnecting", { attempt: @attempt, delay: delay })
          sleep(delay)
        end
      end
    end

    # Replaces the current subscriptions, and keeps them for reconnecting.
    sig { params(subscriptions: T::Array[Subscription]).void }
    def subscribe(subscriptions)
      @options = Options.new(**options.serialize.transform_keys(&:to_sym), subscriptions: subscriptions)
      send_message({ op: "subscribe", d: { subscriptions: subscriptions } })
    end

    # Looks up what was last seen of up to 100 records, see https://e621.stream/snapshots/. The block gets them by id,
    # nil for ones that aren't known. It isn't called if the connection closes first.
    #
    #   client.on(:ready) { client.snapshots("post", [1, 2]) { |posts| p(posts[1]&.dig("tags", "general")) } }
    sig { params(resource: String, ids: T::Array[Integer], block: SnapshotCallback).void }
    def snapshots(resource, ids, &block)
      raise("not ready") unless @ready

      nonce = (@nonce += 1).to_s
      @pending_snapshots[nonce] = block
      send_message({ op: "snapshot", d: { resource: resource, ids: ids, nonce: nonce } })
    end

    # Closes the connection for good.
    sig { void }
    def close
      @closing = true
      @connection&.close(1000, "closed by client")
    end

    private

    sig { returns([Integer, String]) }
    def connect_once
      # fetched every time, so it can move
      @connector.connect(@connector.websocket_url(options.url)) do |connection|
        @connection = connection
        @last_message = now
        heartbeat = Async { heartbeat_loop(connection) }
        begin
          while (message = connection.read)
            @last_message = now
            handle(JSON.parse(message.buffer))
          end
        ensure
          heartbeat.stop
          @connection = nil
          @ready = false
          @pending_snapshots.clear
        end
      end
      # anything but a normal close raises out of read
      [1000, ""]
    rescue Protocol::WebSocket::ClosedError => e
      [e.code || 1006, e.message]
    rescue StandardError => e
      return [1000, "closed by client"] if closing?

      emit("error", e)
      [1006, e.message]
    end

    sig { params(connection: T.untyped).void }
    def heartbeat_loop(connection)
      loop do
        sleep(HEARTBEAT_SECONDS)
        if now - @last_message > SILENT_SECONDS
          connection.close(1001, "timed out")
          break
        end
        send_message({ op: "heartbeat" })
      end
    end

    sig { params(message: T::Hash[String, T.untyped]).void }
    def handle(message)
      data = message["d"]
      case message["op"]
      when "hello"
        identify = { subscriptions: options.subscriptions }
        if options.token
          identify[:auth] = { token: options.token }
        elsif options.username && options.api_key
          identify[:auth] = { username: options.username, api_key: options.api_key }
        end
        identify[:client] = options.client if options.client
        identify[:cursor] = @cursor if @cursor
        send_message({ op: "identify", d: identify })
      when "ready"
        @attempt = 0
        @ready = true
        emit("ready", data)
      when "dispatch"
        event = Event.new(id: message["id"], type: message["type"], time: message["time"], data: message["data"], private: message["private"] == true)
        @cursor = event.id unless event.private?
        emit("dispatch", event)
        emit(event.type, event)
      when "replay_complete"
        emit("replay_complete", data)
      when "subscribed"
        emit("subscribed", data["subscriptions"])
      when "snapshot"
        @pending_snapshots.delete(data["nonce"])&.call(data["snapshots"].to_h { |id, snapshot| [id.to_i, snapshot] })
      when "error"
        @last_error = StreamError.new(data["code"], data["message"])
      end
    end

    sig { params(payload: T::Hash[Symbol, T.untyped]).void }
    def send_message(payload)
      connection = @connection
      return unless connection

      connection.write(Protocol::WebSocket::TextMessage.generate(payload))
      connection.flush
    end

    sig { params(name: String, value: T.untyped).void }
    def emit(name, value)
      @listeners[name]&.each { |listener| listener.call(value) }
    end

    # #close changes this from another fiber
    sig { returns(T::Boolean) }
    def closing?
      @closing
    end

    sig { returns(Float) }
    def now
      Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f
    end
  end
end
