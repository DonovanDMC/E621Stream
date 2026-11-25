// swaps in the newest page every so often, instead of reloading it, so the scroll position stays
const REFRESH_MS = 15_000;
let timer: ReturnType<typeof setTimeout> | undefined;

async function refresh(): Promise<void> {
    clearTimeout(timer);
    try {
        const res = await fetch(location.pathname, { cache: "no-store" });
        if (res.ok) {
            const next = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("#status");
            if (next) document.querySelector("#status")?.replaceWith(next);
        }
    } catch {
        // tried again next time
    }
    if (!document.hidden) timer = setTimeout(() => void refresh(), REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else void refresh();
});
timer = setTimeout(() => void refresh(), REFRESH_MS);
