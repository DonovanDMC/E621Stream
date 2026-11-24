import { rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../");
const src = join(root, "src");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await Bun.build({
    entrypoints: [join(src, "index.ts")],
    target: "bun",
    format: "esm",
    packages: "external",
    outdir: dist,
    sourcemap: "inline",
});
