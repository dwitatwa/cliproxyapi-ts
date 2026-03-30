#!/usr/bin/env node

import process from "node:process";
import { WebSocket } from "ws";

const targetUrl = process.argv[2] || "ws://127.0.0.1:8317/v1/responses";
const model = process.argv[3] || "gpt-5";

const ws = new WebSocket(targetUrl);
let turn = 0;

ws.on("open", () => {
  console.log(`connected: ${targetUrl}`);
  ws.send(JSON.stringify({
    type: "response.create",
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Reply with only: one" }
        ]
      }
    ]
  }));
});

ws.on("message", (data) => {
  const text = data.toString();
  const payload = JSON.parse(text);

  console.log(text);

  if (payload.type === "error") {
    ws.close();
    return;
  }

  if (payload.type !== "response.completed") {
    return;
  }

  if (turn === 0) {
    turn = 1;
    ws.send(JSON.stringify({
      type: "response.append",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Now reply with only: two" }
          ]
        }
      ]
    }));
    return;
  }

  ws.close();
});

ws.on("close", () => {
  console.log("closed");
});

ws.on("error", (error) => {
  console.error(String(error));
  process.exitCode = 1;
});
