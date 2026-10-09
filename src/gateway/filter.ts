import { EVENT_TYPES, isEventType, type EventType, type StreamEvent } from "../events.ts";

export interface Subscription {
    type: string;
}

export interface CompiledSubscription {
    source: Subscription;
    types: Set<EventType>;
}

export class FilterError extends Error {}

function resolveTypes(type: string): Set<EventType> {
    if (type === "*") return new Set(EVENT_TYPES);
    if (type.endsWith(".*")) {
        const prefix = type.slice(0, -1);
        const types = EVENT_TYPES.filter(t => t.startsWith(prefix));
        if (types.length === 0) throw new FilterError(`unknown event type "${type}"`);
        return new Set(types);
    }
    if (!isEventType(type)) throw new FilterError(`unknown event type "${type}"`);
    return new Set([type]);
}

export function compile(input: unknown): CompiledSubscription {
    const sub = (typeof input === "string" ? { type: input } : input ?? {}) as Subscription;
    if (typeof sub !== "object" || typeof sub.type !== "string") throw new FilterError("invalid subscription");
    return { source: { type: sub.type }, types: resolveTypes(sub.type) };
}

export function matches(sub: CompiledSubscription, event: StreamEvent): boolean {
    return sub.types.has(event.type);
}
