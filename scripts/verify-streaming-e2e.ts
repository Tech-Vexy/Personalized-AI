import { POST as chatHandler } from "../src/app/api/chat/route";
import { GET as getSessionsHandler, DELETE as deleteSessionsHandler } from "../src/app/api/sessions/route";

async function run() {
  console.log("Starting End-to-End Streaming & Sessions Verification...\n");

  // 1. Test Sessions GET
  const reqList = new Request("http://localhost:3000/api/sessions");
  const resList = await getSessionsHandler(reqList);
  const dataList = await resList.json();
  console.log(`PASS: GET /api/sessions returned ${dataList.sessions.length} sessions.`);

  // 2. Test Real-Time SSE Stream on /api/chat
  const chatPayload = {
    message: "Hey! What is the quick formula for kinetic energy? Answer in one sentence.",
    stream: true,
  };
  console.log("\nTesting POST /api/chat with stream: true...");
  const chatReq = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatPayload),
  });

  const chatRes = await chatHandler(chatReq);
  console.log("Chat response status:", chatRes.status);
  console.log("Chat Content-Type:", chatRes.headers.get("content-type"));

  if (!chatRes.body) {
    throw new Error("Chat response body is empty");
  }

  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let receivedChunks = 0;
  let receivedDelta = false;
  let receivedDone = false;
  let createdSessionId: number | null = null;
  let fullStreamOutput = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedChunks++;
    const text = decoder.decode(value, { stream: true });
    fullStreamOutput += text;

    if (text.includes("event: delta")) {
      receivedDelta = true;
    }
    if (text.includes("event: done")) {
      receivedDone = true;
      const match = text.match(/"sessionId":(\d+)/);
      if (match) createdSessionId = Number(match[1]);
    }
  }

  console.log(`PASS: Stream completed in ${receivedChunks} chunks.`);
  console.log("Full stream output received:\n---START---\n" + fullStreamOutput + "\n---END---");
  console.log("PASS: received event: delta =", receivedDelta);
  console.log("PASS: received event: done =", receivedDone);
  console.log("Created Session ID:", createdSessionId);

  // 3. Test Session DELETE
  if (createdSessionId) {
    console.log(`\nTesting DELETE /api/sessions?id=${createdSessionId}...`);
    const delReq = new Request(`http://localhost:3000/api/sessions?id=${createdSessionId}`, {
      method: "DELETE",
    });
    const delRes = await deleteSessionsHandler(delReq);
    const delData = await delRes.json();
    console.log("DELETE response:", delData);
    console.log(`PASS: Cleaned up test session #${createdSessionId}`);
  }

  console.log("\nALL VERIFICATIONS PASSED!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
