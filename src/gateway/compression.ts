import zlib from "node:zlib";

export const COMPRESSION_TYPES = ["zlib-stream", "zstd-stream"] as const;
export type CompressionType = typeof COMPRESSION_TYPES[number];

export function isCompressionType(value: string): value is CompressionType {
    return (COMPRESSION_TYPES as ReadonlyArray<string>).includes(value);
}

// same idea as discord's zlib-stream, one context per connection, every frame has to go through the same decompressor
export class StreamCompressor {
    private chain: Promise<unknown> = Promise.resolve();
    private chunks: Array<Buffer> = [];
    private flushFlag: number;
    private stream: zlib.Deflate | zlib.ZstdCompress;
    pending = 0;

    constructor(type: CompressionType) {
        if (type === "zlib-stream") {
            this.stream = zlib.createDeflate();
            this.flushFlag = zlib.constants.Z_SYNC_FLUSH;
        } else {
            this.stream = zlib.createZstdCompress();
            this.flushFlag = zlib.constants.ZSTD_e_flush;
        }
        this.stream.on("data", (chunk: Buffer) => this.chunks.push(chunk));
    }

    close(): void {
        this.stream.destroy();
    }

    compress(data: string): Promise<Buffer> {
        this.pending += data.length;
        const run = this.chain.then(() => new Promise<Buffer>((resolve) => {
            this.stream.write(data);
            this.stream.flush(this.flushFlag, () => {
                this.pending -= data.length;
                resolve(Buffer.concat(this.chunks.splice(0)));
            });
        }));
        this.chain = run;
        return run;
    }
}
