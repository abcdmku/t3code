# Plugins

A plugin is a page your own app serves. T3 opens it in a panel beside your thread and hands it a one-time code, and the page then talks to your environment directly.

Nothing is injected into the page. T3 does not run code inside it, and it does not run code inside T3.

## Adding one

Open the panel picker, choose **Add plugin**, and paste an `http` or `https` URL. T3 fetches the page once to show its title, description, and icon. If the app is not running yet, you can still add it.

Give it a name using lowercase letters, digits, and hyphens. Agents see the plugin's tools under that name, so `my-plugin` becomes `mcp__my-plugin__*`.

The URL can carry placeholders, substituted each time the panel opens:

| Placeholder       | Becomes                                    |
| ----------------- | ------------------------------------------ |
| `{threadId}`      | The thread the panel opened beside         |
| `{projectId}`     | The project the plugin is registered under |
| `{environmentId}` | The environment you are connected to       |
| `{serverUrl}`     | The base URL of that environment           |

`{threadId}` is left alone when there is no thread, so the same entry also works for a project-level open. The host itself cannot be a placeholder, because the origin is what you are agreeing to trust.

## What you are agreeing to

Adding a plugin hands a third party a token that acts as you, so T3 asks first. The consent screen covers two separate grants:

**This page may call T3 as you.** By default that is read access to your projects, threads, and turn state. A plugin can ask for more, and what it asked for is listed in plain words before you agree.

**Agents may use this plugin's tools.** Shown only when the entry declares an MCP URL, and off unless you tick it. Letting agents call a plugin's tools is a different decision from letting its page act as you, so agreeing to one never implies the other.

Both grants are keyed to the origin, not to the name. A page's title and icon are self-reported and can change at any time, so renaming a plugin or changing what it displays cannot inherit another origin's grant. Widening scopes, or turning on tool access later, asks again.

A grant is remembered until you revoke it. It shows up in `t3 auth session list` and dies with `t3 auth session revoke`.

## What a plugin can and cannot do

| Can                                           | Cannot                                    |
| --------------------------------------------- | ----------------------------------------- |
| Read projects, threads, and turn state        | Bring a thread into view in the T3 client |
| Create threads, start turns, answer approvals | Open, close, or navigate T3's own panels  |
| Follow events live, resuming after a drop     | Run code in the T3 client or server       |
| Render as a panel, one instance per thread    | Put UI anywhere but its own panel         |
| Offer tools to agents over MCP                | React in place when you switch threads    |

Each thread opens its own instance of a plugin, with its own thread id and its own code.

## Offering tools to agents

An entry can declare an MCP URL. Once you approve that grant, agents working in that project can call it, alongside T3's own tools.

The MCP URL has to be on the same origin as the page, so a plugin cannot point tool access somewhere you did not agree to. T3 sends no headers to it, which means your plugin's secrets stay with your plugin. A plugin that already serves a page can serve `/mcp` from the same process.

## Codes and tokens

The one-time code is minted per open and lives for a minute. It rides the URL fragment, which browsers do not send to web servers, so it stays out of your plugin's access logs. The page exchanges it for a short-lived token.

A long-lived token is never placed in a URL. If a grant is revoked, the next open simply fails rather than loading the panel unauthenticated.
