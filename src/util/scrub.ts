export function scrub<T>(value: T, sensitiveKeys: Array<string>): T {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => scrub(v, sensitiveKeys) as never) as T;
    const copy = structuredClone(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(copy)) {
        if (!sensitiveKeys.includes(k)) out[k] = scrub(v, sensitiveKeys);
    }
    return out as T;
}
