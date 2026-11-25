import config from "@uwu-codes/eslint-config/bun";
import { defineConfig } from "eslint/config";

export default defineConfig(config, {
    // the clients have their own lint setup
    ignores: ["clients/**"],
}, {
    files: ["src/db/DB.ts", "src/db/models/APIKeyLogin.ts", "src/util/HMAC.ts"],
    rules: {
        "unicorn/filename-case": "off",
    },
}, {
    rules: {
        "@stylistic/jsx-one-expression-per-line": "off",
    },
});
