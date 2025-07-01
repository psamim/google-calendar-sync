import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("Starting Google Calendar Sync...");

// Start the sync process
const syncProcess = spawn("node", [join(__dirname, "sync.js")], {
  detached: true,
  stdio: "inherit",
});

syncProcess.unref();
