# frozen_string_literal: true

require("minitest/autorun")
require("e621stream")

# Plays the server's end of the connection from a script.
class FakeConnection
  attr_reader(:sent)

  Message = Struct.new(:buffer)

  def initialize(script)
    @script = script
    @sent = []
  end

  def read
    step = @script.shift
    case step
    when nil then nil
    when Exception then raise(step)
    else Message.new(JSON.generate(step))
    end
  end

  def write(message)
    @sent << JSON.parse(message.buffer)
  end

  def flush; end

  def close(*); end
end

class FakeConnector < E621Stream::Client::Connector
  attr_reader(:connections)

  def initialize(*scripts)
    super()
    @scripts = scripts
    @connections = []
  end

  def connect(_url)
    connection = FakeConnection.new(@scripts.shift || [Protocol::WebSocket::ClosedError.new("done", E621Stream::CloseCodes::AUTHENTICATION_FAILED)])
    @connections << connection
    yield(connection)
  end
end

class ClientTest < Minitest::Test
  HELLO = { op: "hello", d: { version: 1 } }.freeze

  def dispatch(id, type = "post.create", extra = {})
    { op: "dispatch", id: id, type: type, time: "2026-11-09T00:00:00Z", data: { post: { id: 1 } }, **extra }
  end

  def fatal(code = E621Stream::CloseCodes::AUTHENTICATION_FAILED, message = "invalid credentials")
    [{ op: "error", d: { code: code, message: message } }, Protocol::WebSocket::ClosedError.new(message, code)]
  end

  def client(connector, **options)
    E621Stream::Client.new(username: "someone", api_key: "key", subscriptions: ["post.create"], connector: connector, **options)
  end

  def test_identifies_with_its_credentials_and_subscriptions
    connector = FakeConnector.new([HELLO, *fatal])
    client(connector, client: "tests").run
    assert_equal({ "op" => "identify", "d" => { "subscriptions" => ["post.create"], "auth" => { "username" => "someone", "api_key" => "key" }, "client" => "tests" } }, connector.connections[0].sent[0])
  end

  def test_sends_events_to_dispatch_and_their_types_listeners
    connector = FakeConnector.new([HELLO, dispatch("1-0"), dispatch("2-0", "comment.create"), *fatal])
    all = []
    posts = []
    stream = client(connector)
    stream.on(:dispatch) { |event| all << event.id }.on("post.create") { |event| posts << event.data["post"]["id"] }
    stream.run
    assert_equal(%w[1-0 2-0], all)
    assert_equal([1], posts)
    assert_equal("2-0", stream.cursor)
  end

  def test_private_events_dont_move_the_cursor
    connector = FakeConnector.new([HELLO, dispatch("1-0"), dispatch("dmail.create:5", "dmail.create", private: true), *fatal])
    stream = client(connector)
    private_events = []
    stream.on("dmail.create") { |event| private_events << event.private? }
    stream.run
    assert_equal([true], private_events)
    assert_equal("1-0", stream.cursor)
  end

  def test_reconnects_and_resumes_from_the_last_event
    connector = FakeConnector.new([HELLO, dispatch("7-0"), IOError.new("connection reset")], [HELLO, *fatal])
    reconnecting = []
    stream = client(connector)
    stream.on(:reconnecting) { |info| reconnecting << info[:attempt] }
    stream.run
    assert_equal([1], reconnecting)
    assert_equal(2, connector.connections.size)
    assert_equal("7-0", connector.connections[1].sent[0]["d"]["cursor"])
  end

  def test_doesnt_reconnect_after_a_close_retrying_wont_fix
    connector = FakeConnector.new([HELLO, *fatal])
    errors = []
    closes = []
    stream = client(connector)
    stream.on(:error) { |error| errors << error.code }.on(:close) { |info| closes << info[:reconnecting] }
    stream.run
    assert_equal([E621Stream::CloseCodes::AUTHENTICATION_FAILED], errors)
    assert_equal([false], closes)
    assert_equal(1, connector.connections.size)
  end

  def test_event_types_match_the_server
    assert_includes(E621Stream::Events::EVENT_TYPES, "post.create")
    assert_equal(%w[dmail.create private_post_set.add_posts private_post_set.remove_posts], E621Stream::Events::PRIVATE_EVENT_TYPES)
  end
end
