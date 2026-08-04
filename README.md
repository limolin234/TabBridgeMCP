# TabBridge MCP

> Cross-platform MCP for user-owned browser tabs, built from a tiny
> Tampermonkey executor and server-side page adapters.

TabBridge connects an agent to an explicitly enabled normal browser tab. The
same userscript runs in Tampermonkey-supported browsers on Linux, macOS, and
Windows; the local Node MCP server works beside it. Tampermonkey executes a
small fixed action protocol inside the tab's existing profile, while adapters
on the MCP side turn pages into compact task-relevant data.

It is intentionally not a browser launcher, profile copier, CDP controller,
or virtual desktop. It never exports authentication data, bypasses access
control, or solves CAPTCHAs. When a page needs sign-in or human verification,
the MCP tool returns a blocked result and the user completes it in that same
ordinary browser tab.

## Install

1. In Tampermonkey, import `tampermonkey/tampermonkey-browser-mcp.user.js`.
   It requests permission for HTTP(S) pages, but is **off by default** in every
   tab. Enable only the tabs that an agent may use.
2. Add this MCP entry to the client configuration:

```toml
[mcp_servers.tampermonkey_browser]
command = "node"
args = ["/absolute/path/to/tabbridge-mcp/mcp-server.js"]
```

3. Restart the MCP client. The MCP server starts a machine-wide local bridge
   on demand. The bridge is a single shared instance (single-process lock on a
   temp directory + port): when multiple MCP processes run concurrently, they
   all converge on the same bridge and hand off instead of spawning private
   copies. No separate daemon, service manager, browser launch, or profile
   setup is required.

## Dedicated-tab workflow

Open a separate normal browser tab for agent work, install the userscript, and
enable only that tab. The MCP requires a `tabId` for every mutating action, so
it cannot silently take over another tab. When a task reports `blocked`, leave
that dedicated tab where it is, complete the login, CAPTCHA, or other required
interaction yourself, then let the agent continue with the same `tabId`.

## Design

- **Install once:** the browser side is a dependency-free userscript with a
  fixed protocol, not a site-specific extension collection.
- **Keep ownership local:** no profile copy, remote display, cookie export, or
  browser daemon. The bridge listens only on `127.0.0.1:18475`.
- **Keep state disposable:** the bridge queue lives only in memory. A bridge
  restart drops unfinished work, and the MCP caller can safely submit it again.
- **Share one bridge across processes:** every MCP process talks to the same
  local bridge. Jobs are claimed per browser tab, so concurrent agents working
  on distinct tabs run in parallel; tasks claimed by a tab that stopped
  polling are returned to the queue so they are not lost.
- **Spend context deliberately:** adapters request small structured fields by
  default; bounded text or HTML is an explicit debugging fallback.
- **Extend server-side:** add or replace adapters without asking users to
  reinstall the browser component.

## Tools And Adapters

The public MCP surface stays fixed: `browser_tabs`, `browser_read`,
`browser_action`, `browser_download`, and debug-only `browser_inspect`.

`browser_read` selects a server-side adapter from the page URL and sends a
declarative DOM extraction plan to the browser. Its `mode` can be `summary`,
`text`, `elements`, `links`, `controls`, or `media`; `selector`, `contains`,
`visible`, `limit`, and `offset` provide bounded filtering without adding a
separate tool for every page shape. The bundled `generic` adapter performs
small browser-side cleanup (hidden/script-like nodes, whitespace, bounded
fields) and returns structured data. It does not send raw page HTML or a full
page dump by default; `browser_inspect` remains the bounded fallback when the
cleaned views are insufficient.

Private adapters can be loaded with `TABBRIDGE_ADAPTERS_DIR`; see
[`adapters/README.md`](adapters/README.md). This keeps organization-specific
and site-specific rules outside the public repository.

## Development

The project has no runtime dependencies. Test the MCP protocol with:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node mcp-server.js
```
