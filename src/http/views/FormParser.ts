import { Readable } from "node:stream";

import Busboy, { type BusboyHeaders, type BusboyInstance } from "@fastify/busboy";

export class FormLimitError extends Error {
    override name = "FormLimitError";
}

export interface ParseFormOptions {
    maxFields?: number;
    maxFieldSize?: number;
    maxFiles?: number;
    maxFileSize?: number;
}

export default async function parseForm(req: Bun.BunRequest, options?: ParseFormOptions): Promise<FormData> {
    const form = new FormData();
    if (!req.body) return form;

    return new Promise<FormData>((resolve, reject) => {
        let bus: BusboyInstance;
        try {
            bus = new Busboy({
                headers: req.headers.toJSON() as BusboyHeaders,
                limits: {
                    fields: options?.maxFields ?? 25,
                    fieldSize: options?.maxFieldSize ?? (64 * 1024),
                    files: options?.maxFiles ?? 0,
                    fileSize: options?.maxFileSize ?? (10 * 1024 * 1024),
                    parts: (options?.maxFields ?? 25) + (options?.maxFiles ?? 0),
                },
            });
        } catch (err) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(err);
            return;
        }

        let complete = false;
        const pending: Array<Promise<void>> = [];
        const source = Readable.fromWeb(req.body!);

        const fail = (err: Error): void => {
            if (complete) return;
            complete = true;
            source.unpipe(bus);
            source.destroy();
            reject(err);
        };

        bus.on("field", (name, value, _nameTruncated, valueTruncated) => {
            if (complete) return;
            if (valueTruncated) {
                fail(new FormLimitError(`Field "${name}" is too large`));
                return;
            }
            form.append(name, value);
        });

        bus.on("file", (field, stream, filename, _encoding, mimeType) => {
            if (complete) return stream.resume();

            pending.push(new Promise((done) => {
                const chunks: Array<Buffer> = [];
                stream.on("data", (chunk: Buffer) => {
                    if (complete) return;
                    chunks.push(chunk);
                });

                stream.on("limit", () => {
                    stream.resume();
                    fail(new FormLimitError(`File "${filename}" exceeds the file size limit.`));
                });

                stream.on("error", fail);

                stream.on("end", () => {
                    if (!complete && (filename || chunks.length)) {
                        form.append(field, new File(chunks, filename, { type: mimeType }));
                    }
                    done();
                });
            }));
        });

        bus.on("fieldsLimit", () => { fail(new FormLimitError("Too many fields")); });
        bus.on("filesLimit", () => { fail(new FormLimitError("Too many files")); });
        bus.on("partsLimit", () => { fail(new FormLimitError("Too many parts")); });
        bus.on("error", fail);
        bus.on("finish", () => { resolve(form); });

        source.on("error", fail);
        source.pipe(bus);
    });
}
