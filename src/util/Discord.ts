import Config from "../Config.ts";

import type { RESTPostAPIWebhookWithTokenJSONBody, RESTPostAPIWebhookWithTokenWaitResult } from "discord-api-types/v10";

const COLORS = {
    GREEN: 0x007F00,
    RED: 0xDD1450,
    ORANGE: 0xFFA500,
};

export async function logDiscord(title: string, description: string, color: (keyof typeof COLORS) | number): Promise<void> {
    if (typeof color === "string") color = COLORS[color];
    await executeWebhook({
        embeds: [
            {
                title,
                description,
                color,
                timestamp: new Date().toISOString(),
            },
        ],
    });
}

export async function executeWebhook(content: RESTPostAPIWebhookWithTokenJSONBody): Promise<RESTPostAPIWebhookWithTokenWaitResult | null> {
    const url = Config.discordNotificationWebhookURL;
    if (!url) return null;
    const match = /\/api\/webhooks\/(\d+)\/(.*)$/.exec(url);
    if (!match) return null;
    const [,id, token] = match;
    const res = await fetch(`${Config.discordWebhookBase}/api/v10/webhooks/${id}/${token}?wait=true`, {
        body: JSON.stringify(content),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(body);
    } catch {} // eslint-disable-line no-empty

    if (!res.ok) {
        console.error(`Failed to send discord webhook: ${JSON.stringify(content)}`);
        return null;
    }

    return parsed as RESTPostAPIWebhookWithTokenWaitResult;
}
