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

## Quickstart

You need Node.js 18 or newer, a Tampermonkey-supported browser, and an MCP
client such as Codex.

1. Clone the repository and keep it at a stable path:

```sh
git clone https://github.com/limolin234/TabBridgeMCP.git
cd TabBridgeMCP
```

2. Open the Tampermonkey dashboard, choose **Utilities > Import from file**, and
   import `tampermonkey/tampermonkey-browser-mcp.user.js`. Confirm that the
   script is enabled. The script has access to HTTP(S) pages, but Browser MCP is
   **off by default in every tab**.

3. Register the local MCP server. For Codex, run this from the repository:

```sh
codex mcp add tampermonkey_browser -- node "$PWD/mcp-server.js"
codex mcp list
```

For another MCP client, add the equivalent stdio configuration with an
absolute path:

```toml
[mcp_servers.tampermonkey_browser]
command = "node"
args = ["/absolute/path/to/TabBridgeMCP/mcp-server.js"]
```

4. Fully restart the MCP client so it reloads the tool schemas.

5. Open a normal browser tab for the agent. Click the fixed **Browser MCP: off**
   button in the bottom-right corner; it changes to **Browser MCP: ready**. If a
   site temporarily removes the button during SPA navigation, the script mounts
   it again. The Tampermonkey menu command **Toggle Browser MCP for this tab** is
   the fallback.

6. Ask the agent to call `browser_tabs`, select the enabled tab, and start with
   `browser_read` in `summary` mode. Use one dedicated enabled tab per agent.

The MCP server starts a machine-wide local bridge on demand. Concurrent MCP
processes share that bridge on `127.0.0.1:18475`; no daemon, service manager,
browser launch, or profile setup is required.

### Updating

```sh
git pull --ff-only
```

Re-import the userscript in Tampermonkey when its `@version` changes. Fully
restart the MCP client when `mcp-server.js` or its tool schemas change. Updating
the checkout alone does not replace Tampermonkey's installed copy or an already
running MCP process.

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

The public MCP surface includes `browser_tabs`, `browser_read`,
`browser_action`, `browser_download`, `browser_job_status`, and debug-only
`browser_inspect`.

| Tool | Use |
| --- | --- |
| `browser_tabs` | List tabs whose Browser MCP button is enabled. |
| `browser_read` | Read a bounded, cleaned page view. Start with `summary`. |
| `browser_action` | Navigate, click, or fill a selected tab. |
| `browser_download` | Ask the normal browser session to follow or click a download. |
| `browser_job_status` | Read the status and byte progress of a background browser job. |
| `browser_inspect` | Return bounded text or HTML when cleaned reads are insufficient. |

`browser_read` selects a server-side adapter from the page URL and sends a
declarative DOM extraction plan to the browser. Its `mode` can be `summary`,
`text`, `elements`, `links`, `controls`, or `media`; `selector`, `contains`,
`visible`, `limit`, and `offset` provide bounded filtering without adding a
separate tool for every page shape. The bundled `generic` adapter performs
small browser-side cleanup (hidden/script-like nodes, whitespace, bounded
fields) and returns structured data. It does not send raw page HTML or a full
page dump by default; `browser_inspect` remains the bounded fallback when the
cleaned views are insufficient.

`browser_read` waits for the page to be ready before extracting: SPA pages
(e.g. IEEE Xplore search) render content asynchronously after navigation, so a
read issued too early would see an empty shell. Pass a content selector (e.g.
`a[href*='/document/']` on IEEE) to wait until that content appears, or omit it
to wait for the document load; `force: true` reads the current view immediately.

Typical reads use one tool with different levels rather than many specialized
tools:

```json
{"tabId":"TAB_ID","mode":"summary"}
{"tabId":"TAB_ID","mode":"text","selector":"main","limit":4000}
{"tabId":"TAB_ID","mode":"elements","selector":"a, button, input","visible":true,"limit":50}
{"tabId":"TAB_ID","mode":"links","contains":"PDF","visible":true,"limit":10}
```

`browser_download` returns a background `jobId` immediately. Use
`browser_job_status` to monitor `queued`, `claimed`, `completed`, or `error`;
forced same-origin downloads also report received and total bytes (the latter
may be `null`). Normal downloads still follow site and browser behavior and
cannot report a final filesystem path; sign-in, purchase gates, pop-up
blocking, and site handlers still apply.

For a direct same-origin file URL that the browser would preview inline, pass
`force: true` (and optionally `filename`). The userscript fetches it with the
current page session and triggers a Blob download. Cross-origin URLs or failed
fetches fall back to the browser's normal navigation; selector downloads always
keep the site's native click behavior.

```json
{"tabId":"TAB_ID","url":"https://example.com/paper.pdf","force":true,"filename":"paper.pdf"}
```

Some publishers expose a PDF through an HTML wrapper page (IEEE `stamp.jsp`).
When the requested URL is a known wrapper, the server resolves it to the real
file URL, loads that file in the tab first (this warms the publisher's access
check), and fetches it from that warm context. If the access check bounces the
navigation back, the download fails with an explicit sign-in-required error
instead of saving a challenge page.

Private adapters can be loaded with `TABBRIDGE_ADAPTERS_DIR`; see
[`adapters/README.md`](adapters/README.md). This keeps organization-specific
and site-specific rules outside the public repository.

## Development

The project has no runtime dependencies. Run the unit tests with:

```sh
node --test "tests/*.test.js"
```

Optional environment variables:

| Variable | Effect | Default |
| --- | --- | --- |
| `TABBRIDGE_DEBUG=1` | Write server-side dispatch and binding-verify logs to stderr | off |
| `TPMONKEY_MCP_SNAPSHOT_MAX_AGE_MS` | Reject an index-based click when the interact snapshot is older than this (ms); re-read interact first | `60000` |
| `TPMONKEY_MCP_TAB_HEARTBEAT_MS` | Drop a tab from `browser_tabs` when its last poll is older than this (ms). Browsers throttle hidden-tab timers to ~1/min, so keep this far above the poll cadence or live tabs intermittently disappear | `300000` |
| `TPMONKEY_MCP_PORT` / `TPMONKEY_MCP_TIMEOUT_MS` | bridge port / default request timeout | `18475` / `30000` |

Test the MCP protocol with:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node mcp-server.js
```
