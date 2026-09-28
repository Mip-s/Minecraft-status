import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage, parseLine, cleanLine } from "../worker/parse.js";

const m = (content, embeds = []) => ({ id: "1", timestamp: "2026-09-28T10:00:00Z", content, embeds });

test("SDLink default join/leave", () => {
  assert.deepEqual(parseLine("Tenez10 has joined the server!"), { kind: "join", username: "Tenez10" });
  assert.deepEqual(parseLine("Tenez10 has left the server!"), { kind: "leave", username: "Tenez10" });
});
test("markdown + embeds", () => {
  assert.equal(parseMessage(m("*Tenez10 has joined the server!*"))[0].username, "Tenez10");
  assert.equal(parseMessage(m("**Steve_2** has left the server!"))[0].kind, "leave");
  assert.equal(parseMessage(m("", [{ description: "Alex has joined the server!" }]))[0].username, "Alex");
  assert.equal(parseMessage(m("", [{ author: { name: "Alex has left the server!" } }]))[0].kind, "leave");
});
test("vanilla wording + bedrock names", () => {
  assert.equal(parseLine("Notch joined the game").kind, "join");
  assert.equal(parseLine(".BedrockGuy has joined the server!").username, ".BedrockGuy");
});
test("server lifecycle", () => {
  assert.equal(parseLine(cleanLine("*Server has stopped...*")).kind, "server_stop");
  assert.equal(parseLine(cleanLine("*Server has started. Enjoy!*")).kind, "server_start");
  assert.equal(parseLine(cleanLine("*Server is starting...*")), null);
});
test("ignores chat and other lines", () => {
  for (const s of ["Tenez10: hi guys", "Tenez10: Steve has joined the server!", "Tenez10 was slain by Zombie",
    "Tenez10 has made the advancement [Stone Age]", "I have joined the server!", "a b has joined the server!"])
    assert.equal(parseMessage(m(s)).length, 0, s);
});
