import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import Config from "../config/Config.ts";

const VERSION = 2;
const KEY = scryptSync(Config.encryptionKey, Config.encryptionSalt, 32);
export function encrypt(content: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, iv);
    const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
    return `${VERSION}:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(content: string): string {
    const version = Number(content.split(":")[0]!);
    switch (version) {
        case 1: {
            const [, iv, encrypted] = content.split(":") as [string, string, string];
            const decipher = createDecipheriv("aes256", KEY, Buffer.from(iv, "hex"));
            const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]);
            return decrypted.toString();
        }

        case 2: {
            const [, iv, tag, encrypted] = content.split(":") as [string, string, string, string];
            const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "hex"), { authTagLength: 16 });
            decipher.setAuthTag(Buffer.from(tag, "hex"));
            return Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]).toString("utf8");
        }

        default: throw new Error(`Unsure how to handle encryption version: ${version}`);
    }
}
