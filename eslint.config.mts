import config from "@uwu-codes/eslint-config";
import { defineConfig } from "eslint/config";

// the clients have their own config, tsconfig and dependencies
export default defineConfig([{ ignores: ["clients/**"] }, ...config]);
