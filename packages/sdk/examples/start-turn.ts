import { createT3Client } from "@t3tools/sdk";

const baseUrl = process.env.T3_BASE_URL;
const token = process.env.T3_TOKEN;
const projectId = process.env.T3_PROJECT_ID;
const providerInstanceId = process.env.T3_PROVIDER_INSTANCE_ID;

if (!baseUrl || !token || !projectId || !providerInstanceId) {
  throw new Error("Set T3_BASE_URL, T3_TOKEN, T3_PROJECT_ID, and T3_PROVIDER_INSTANCE_ID.");
}

const client = createT3Client({
  baseUrl,
  auth: { type: "bearer", token },
});
const threadId = crypto.randomUUID();

try {
  await client.createThread({
    threadId,
    projectId,
    title: "SDK example",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  await client.startTurn({
    threadId,
    message: { text: "Summarize this project in five sentences." },
  });
  console.log(threadId);
} finally {
  await client.close();
}
