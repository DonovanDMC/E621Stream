import * as sass from "sass-embedded";

const dir = Bun.fileURLToPath(new URL("./styles/", import.meta.url));
const styles = new Map<string, string>();

// relative to the styles folder, without the extension
for await (const name of new Bun.Glob("**/[!_]*.scss").scan(dir)) {
    const path = `${dir}${name}`;
    const { css } = await sass.compileAsync(path, {
        style: Bun.env.NODE_ENV === "production" ? "compressed" : "expanded",
        loadPaths: [dir],
        importers: [new sass.NodePackageImporter()],
        // bootstrap's deprecation warnings
        quietDeps: true,
    });
    styles.set(name.replace(/\.scss$/, ""), css);
}

export function style(name: string): Response | null {
    const css = styles.get(name);
    if (css === undefined) return null;
    return new Response(css, {
        headers: { "Content-Type": "text/css; charset=utf-8" },
    });
}
