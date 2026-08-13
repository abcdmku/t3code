import { createT3Client } from "@t3tools/sdk";

const baseUrl = process.env.T3_BASE_URL;
const token = process.env.T3_TOKEN;

if (!baseUrl || !token) {
  throw new Error("Set T3_BASE_URL and T3_TOKEN.");
}

const client = createT3Client({
  baseUrl,
  auth: { type: "bearer", token },
});

try {
  const descriptor = await client.descriptor();
  const shell = await client.shell();
  console.log(
    `${descriptor.label}: ${shell.projects.length} projects, ${shell.threads.length} threads`,
  );
} finally {
  await client.close();
}
