import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) {
  throw new Error("Expected dev or build.");
}

if (command === "build") {
  for (const directory of ["dist/server", "dist/client"]) {
    rmSync(new URL(`../${directory}`, import.meta.url), {
      recursive: true,
      force: true,
    });
  }
}

const cli = new URL("../node_modules/vite/bin/vite.js", import.meta.url);
process.argv = [
  process.execPath,
  fileURLToPath(cli),
  command,
  ...(command === "dev" ? ["--host", "127.0.0.1", "--port", "3000"] : []),
  ...args,
];
await import(cli.href);
