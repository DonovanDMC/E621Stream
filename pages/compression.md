# Compression

- Without a `compress` parameter, messages are text frames. permessage-deflate is used if your client negotiates it, which most clients do automatically.
- `?compress=zlib-stream` or `?compress=zstd-stream`: every message, including `hello`, is a binary frame from one compression context that lasts the whole connection and is flushed after each message. Frames can't be decompressed on their own. Feed them all, in order, into a single streaming decompressor (zlib `inflate`, or a zstd streaming decompressor). Each flushed frame decodes to exactly one JSON message.

```js
import zlib from "node:zlib";
const inflate = zlib.createInflate(); // or zlib.createZstdDecompress()
let text = "";
inflate.on("data", chunk => { text += chunk; });
ws.binaryType = "arraybuffer";
ws.onmessage = ({ data }) => {
    inflate.write(Buffer.from(data));
    inflate.flush(() => {
        const msg = JSON.parse(text);
        text = "";
        handle(msg);
    });
};
```
