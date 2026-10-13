# Compression

Without `compress`, messages are text frames. permessage-deflate is used if your client supports it (most do).

With `?compress=zlib-stream` or `?compress=zstd-stream`, every message (including `hello`) is a binary frame, from one compression context for the whole connection. Frames can't be decompressed on their own, they all have to go through the same decompressor, in order. Each frame is exactly one message.

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
