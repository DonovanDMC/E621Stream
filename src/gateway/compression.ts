import { constants, createDeflate, createZstdCompress, type Deflate, type ZstdCompress } from "zlib";

export const COMPRESSION_TYPES = ["zlib-stream", "zstd-stream"] as const;
export type CompressionType = (typeof COMPRESSION_TYPES)[number];

export class StreamCompressor {
    private chain: Promise<unknown> = Promise.resolve();
    private chunks: Array<Buffer> = [];
    private flushFlag: number;
    private stream: Deflate | ZstdCompress;
    pending = 0;

    constructor(type: CompressionType) {
        if (type === "zlib-stream") {
            this.stream = createDeflate();
            this.flushFlag = constants.Z_SYNC_FLUSH;
        } else {
            this.stream = createZstdCompress();
            this.flushFlag = constants.ZSTD_e_flush;
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
