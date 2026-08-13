# Custom project surfaces

Custom project surfaces add links from a repository's `t3.json` to web apps used with that repository. T3 Code opens each link in its desktop preview.

The app at that URL stays separate from T3 Code. T3 Code does not load plugin code, inject a JavaScript bridge, or grant the page access to thread data.

## Add a surface

Add a `surfaces` array to `t3.json` at the repository root.

```jsonc
{
  "$schema": "https://t3.codes/schema/t3.json",
  "surfaces": [
    {
      "name": "Dev app",
      "icon": "play",
      "url": "http://127.0.0.1:5173/?project={projectId}",
      "threadUrl": "http://127.0.0.1:5173/threads/{threadId}",
    },
    {
      "name": "API status",
      "url": "https://status.example.test/environments/{environmentId}",
    },
  ],
}
```

Each entry requires `name` and `url`. `threadUrl` adds a launcher to the thread preview rail. The optional `icon` accepts `play`, `test`, `lint`, `configure`, `build`, or `debug`. Any other value uses an app icon.

T3 Code keeps entries with duplicate names separate. It supports up to 20 entries and limits each URL template to 2,048 characters.

Here is a project-level link for a local Storybook server.

```jsonc
{
  "surfaces": [
    {
      "name": "Storybook",
      "url": "http://localhost:6006/",
    },
  ],
}
```

Here is a thread-level link that lets the app select a record for the active thread.

```jsonc
{
  "surfaces": [
    {
      "name": "Task board",
      "url": "https://board.example.test/projects/{projectId}",
      "threadUrl": "https://board.example.test/projects/{projectId}/threads/{threadId}",
    },
  ],
}
```

## Open a surface

Custom project surfaces require the T3 Code desktop app and an existing thread in the same physical project.

- The default sidebar lists entries after you filter the sidebar to one project.
- The legacy sidebar lists entries for the expanded project that owns the active thread.
- The command palette lists the active project's entries. Search for the entry name or "surface."
- A `threadUrl` entry appears in the active thread's preview rail.

T3 Code opens a normal preview tab. If the same resolved URL is already open in that thread, T3 Code focuses it instead of adding another tab.

## URL placeholders

T3 Code replaces these values when you open an entry.

| Placeholder       | Value                                                             |
| ----------------- | ----------------------------------------------------------------- |
| `{environmentId}` | Environment that owns the project                                 |
| `{projectId}`     | Project that owns `t3.json`                                       |
| `{threadId}`      | Host thread ID. Use it only in `threadUrl`                        |
| `{serverUrl}`     | Connected T3 server URL with credentials, query, and hash removed |

T3 Code percent-encodes IDs before inserting them. It rejects unresolved placeholders and URLs outside HTTP or HTTPS.

Do not put passwords, API keys, pairing tokens, or session tokens in `url` or `threadUrl`. Preview URLs can appear in local history and logs.

## Local and remote URLs

| Connection                         | Loopback URL behavior                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| Local environment                  | Opens on the desktop machine                                        |
| Private LAN or tailnet environment | Rewrites loopback to that environment's private host                |
| Public relay or tunnel             | Refuses the URL until an authenticated preview gateway is available |

For a remote project, the web app must listen on an address reachable from the desktop client. A loopback URL behind a public relay never falls back to the desktop machine's localhost.

## Update or remove an entry

Edit or remove the entry in `t3.json`. The client caches file reads and does not watch external edits. Reload T3 Code to force a fresh read. Existing preview tabs remain open because they are normal browser tabs.

## Troubleshooting

If an entry does not appear, check these points.

- Open the desktop app. Web and mobile clients cannot host preview tabs.
- Create a thread in the physical project that contains `t3.json`.
- Confirm that `t3.json` parses as JSONC and that the entry has non-empty `name` and `url` fields.
- Reload T3 Code after editing the file outside the app.
- Start the web app named by the URL.
- For remote projects, confirm that the desktop can reach the environment host and port.
- Remove any placeholder that T3 Code does not support.
