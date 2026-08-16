import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist/web"), { recursive: true });
await cp(resolve(root, "web/index.html"), resolve(root, "dist/web/index.html"));
await cp(resolve(root, "web/styles.css"), resolve(root, "dist/web/styles.css"));
