const dir = Bun.fileURLToPath(new URL("./scripts/", import.meta.url));
const scripts = new Map<string, string>();

const entrypoints = await Array.fromAsync(new Bun.Glob("**/[!_]*.ts").scan({ cwd: dir, absolute: true }));
const result = await Bun.build({
    entrypoints,
    // keeps subfolders in the output names
    root: dir,
    target: "browser",
    minify: Bun.env.NODE_ENV === "production",
    sourcemap: Bun.env.NODE_ENV === "production" ? "none" : "inline",
});
if (!result.success) throw new AggregateError(result.logs, "Failed to build scripts");

for (const output of result.outputs) {
    const name = output.path.replace(/^\.\//, "").replace(/\.js$/, "");
    scripts.set(name, await output.text());
}

export function script(name: string): Response | null {
    const js = scripts.get(name);
    if (js === undefined) return null;
    return new Response(js, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
}
