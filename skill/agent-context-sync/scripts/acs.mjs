// src/main.ts
import { pathToFileURL } from "node:url";
async function run(argv, io) {
  const command = argv[0] ?? "help";
  if (command === "help") {
    io.stdout(JSON.stringify({ ok: true, command, data: { commands: [] } }));
    return 0;
  }
  io.stdout(JSON.stringify({
    ok: false,
    command,
    error: { code: "UNKNOWN_COMMAND", message: "Unknown command: " + command }
  }));
  return 2;
}
var isProcessEntry = process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isProcessEntry) {
  const io = {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n")
  };
  process.exitCode = await run(process.argv.slice(2), io);
}
export {
  run
};
