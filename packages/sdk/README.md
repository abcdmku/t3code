# T3 Code SDK

Connect a local app to one T3 Code environment. The default client uses promises and async
iterables. An Effect entry is available for apps that already use Effect.

Install the SDK and its Effect peer:

```sh
pnpm add @t3tools/sdk effect
```

Keep the SDK and T3 server on the same version. Use `@t3tools/sdk/effect` for Effect programs and
`@t3tools/sdk/unstable` only when the stable client does not expose the command you need.

## Read an environment

```ts
import { createT3Client } from "@t3tools/sdk";

const client = createT3Client({
  baseUrl: "http://127.0.0.1:5273",
  auth: { type: "bearer", token: process.env.T3_TOKEN! },
});

try {
  const descriptor = await client.descriptor();
  const shell = await client.shell();

  console.log(descriptor.label);
  console.log(shell.projects.map((project) => project.title));
} finally {
  await client.close();
}
```

`baseUrl` must be an HTTP or HTTPS origin that the app can reach. Localhost, a LAN address, or a
Tailscale address can work. This version does not resolve managed relay URLs.

## Pair once and save the token

A pairing credential is single-use. Save the access token in `onToken`, then start later clients
with the `token` auth type.

```ts
import { createT3Client, type T3AccessToken } from "@t3tools/sdk";

const client = createT3Client({
  baseUrl: process.env.T3_BASE_URL!,
  auth: {
    type: "pairing",
    credential: process.env.T3_PAIRING_CREDENTIAL!,
    scopes: ["orchestration:read", "orchestration:operate"],
  },
  onToken: async (token: T3AccessToken) => {
    await saveToken(token);
  },
});
```

The first authenticated request waits for `onToken`. If saving fails, the request rejects with
`T3TokenPersistenceError`. A later request retries the save without exchanging the credential
again.

## Create a thread and start a turn

Thread creation stays explicit. The caller chooses the IDs and model selection.

```ts
import { createT3Client } from "@t3tools/sdk";

const client = createT3Client({
  baseUrl: process.env.T3_BASE_URL!,
  auth: { type: "bearer", token: process.env.T3_TOKEN! },
});

const threadId = crypto.randomUUID();

try {
  await client.createThread({
    threadId,
    projectId: process.env.T3_PROJECT_ID!,
    title: "Check the release script",
    modelSelection: {
      instanceId: process.env.T3_PROVIDER_INSTANCE_ID!,
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });

  await client.startTurn({
    threadId,
    message: { text: "Find why the dry run skips the SDK package." },
  });
} finally {
  await client.close();
}
```

## Subscribe with resume support

```ts
for await (const item of client.subscribeThread(threadId)) {
  if (item.kind === "event") {
    console.log(item.event.type);
  }
}
```

The client fetches a fresh WebSocket ticket after a dropped connection and resumes after the last
sequence it received. `close()` ends active iterators and releases their sockets.

## Reveal a thread in T3 Code

Servers that advertise `capabilities.uiControl` can ask a connected web or desktop client to open a
thread. The token needs the `ui:operate` scope.

```ts
const result = await client.revealThread(threadId);
if (!result.delivered) {
  console.error(result.error);
}
```

`delivered: false` means that no compatible client handled the request before the broker timeout.
The SDK waits longer than that server timeout so it can return the result instead of failing first.
Older servers fail with `T3CapabilityError` before the invoke request is sent.

## Use Effect

```ts
import { Effect } from "effect";
import { layer, shell } from "@t3tools/sdk/effect";

const program = shell.pipe(
  Effect.tap((snapshot) => Effect.log(`Found ${snapshot.projects.length} projects`)),
  Effect.provide(
    layer({
      baseUrl: process.env.T3_BASE_URL!,
      auth: { type: "bearer", token: process.env.T3_TOKEN! },
    }),
  ),
);

await Effect.runPromise(program);
```

`@t3tools/sdk/unstable` exposes raw dispatch and the narrow subscription RPC client. Code that uses
that entry may need changes before the first release.

## Handle errors

All public errors extend `Error` and have an `_tag` field. Use `instanceof` when one case needs a
different response.

```ts
import { T3AuthError, T3InputError } from "@t3tools/sdk";

try {
  await client.archiveThread({ threadId });
} catch (error) {
  if (error instanceof T3AuthError) {
    console.error(error.reason, error.traceId);
  } else if (error instanceof T3InputError) {
    console.error(error.field, error.message);
  } else {
    throw error;
  }
}
```

See `examples/read-shell.mjs` and `examples/start-turn.ts` for complete scripts.
