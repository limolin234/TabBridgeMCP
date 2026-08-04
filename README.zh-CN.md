# TabBridge MCP

TabBridge 是一个面向用户自有浏览器标签页的跨平台 MCP 桥接。它由
Tampermonkey userscript 和本机 Node MCP server 组成，适用于 Linux、macOS
和 Windows。

它不是浏览器启动器、CDP 控制器、远程桌面或账号数据导出器。页面登录、
验证码和购买确认仍由用户在普通浏览器标签页中完成。

## Quickstart

需要 Node.js 18 或更高版本、支持 Tampermonkey 的浏览器，以及 Codex 等 MCP
客户端。

### 1. 获取项目

```sh
git clone https://github.com/limolin234/TabBridgeMCP.git
cd TabBridgeMCP
```

请把项目保存在稳定路径，因为 MCP 配置会引用 `mcp-server.js` 的绝对路径。

### 2. 安装浏览器脚本

在 Tampermonkey 控制面板选择 **Utilities > Import from file**，导入：

```text
tampermonkey/tampermonkey-browser-mcp.user.js
```

确认脚本已启用。脚本匹配 HTTP(S) 页面，但 **每个标签页默认关闭 Browser
MCP**，只有点击页面右下角的 `Browser MCP: off` 后才会变成 `ready`。

如果站点是 SPA 并暂时移除了按钮，脚本会自动重新挂载；Tampermonkey 菜单
里的 **Toggle Browser MCP for this tab** 也可以作为备用开关。

### 3. 配置 MCP

在项目目录执行：

```sh
codex mcp add tampermonkey_browser -- node "$PWD/mcp-server.js"
codex mcp list
```

其他 MCP 客户端可以使用等价的 stdio 配置：

```toml
[mcp_servers.tampermonkey_browser]
command = "node"
args = ["/absolute/path/to/TabBridgeMCP/mcp-server.js"]
```

### 4. 重启并验证

完整重启 MCP 客户端，让它重新读取 tool schema。打开一个专门给 agent 使用
的普通浏览器标签页，启用 Browser MCP，然后让 agent 依次调用：

```text
browser_tabs
browser_read(tabId, mode="summary")
```

每个 agent 使用自己的 dedicated tab。当前所有修改操作都要求 `tabId`，因此
不会静默接管其他标签页。

## 更新

```sh
git pull --ff-only
```

当 userscript 的 `@version` 变化时，需要在 Tampermonkey 中重新导入脚本；
当 `mcp-server.js` 或工具 schema 变化时，需要完整重启 MCP 客户端。只更新
仓库目录不会自动替换 Tampermonkey 已安装的副本，也不会更新已经运行的 MCP
进程。

## 工具

| 工具 | 作用 |
| --- | --- |
| `browser_tabs` | 列出已启用 Browser MCP 的标签页。 |
| `browser_read` | 分层读取并清洗页面元素。 |
| `browser_action` | 在指定标签页中跳转、点击或填写。 |
| `browser_download` | 让当前浏览器跟随 URL 或点击下载控件。 |
| `browser_job_status` | 查询后台浏览器任务状态和下载字节进度。 |
| `browser_inspect` | 清洗结果不足时，返回有限的文本或 HTML 调试信息。 |

`browser_read` 通过一个工具提供多个层次，不额外增加大量专用工具：

```json
{"tabId":"TAB_ID","mode":"summary"}
{"tabId":"TAB_ID","mode":"text","selector":"main","limit":4000}
{"tabId":"TAB_ID","mode":"elements","selector":"a, button, input","visible":true,"limit":50}
{"tabId":"TAB_ID","mode":"links","contains":"PDF","visible":true,"limit":10}
```

支持的 `mode` 有：

- `summary`：标题、正文、标题列表、链接和控件；
- `text`：指定区域的清洗后文本；
- `elements`：元素标签、属性、可见性相关筛选和有限文本；
- `links`：链接文字、URL 和标签；
- `controls`：输入框、选择框和按钮；
- `media`：图片、音视频等媒体元数据。

`selector`、`contains`、`visible`、`limit` 和 `offset` 用于限制结果。浏览器
侧会移除 script/style 等节点、过滤隐藏元素、合并空白并限制返回大小。
`browser_inspect` 是有限的原始回退，不应作为默认读取方式。

## 下载语义

`browser_download` 会立即返回后台 `jobId`，不会等待大文件完成。用
`browser_job_status` 查询 `queued`、`claimed`、`completed` 或 `error`，强制下载
模式还会返回已接收字节数和总字节数（服务器未提供长度时为 `null`）。默认模式
仍保持站点和浏览器行为；文件若被浏览器判定为下载，则进入浏览器配置的默认下载目录，
工具无法报告最终文件系统路径。

对于同源且会被 inline 预览的直接文件 URL，可以使用：

```json
{
  "tabId":"TAB_ID",
  "url":"https://example.com/paper.pdf",
  "force":true,
  "filename":"paper.pdf"
}
```

userscript 会使用当前页面的登录态请求文件，转成 Blob，再触发浏览器保存。
跨域或请求失败时回退为浏览器原生导航。selector 下载始终保持站点的原生
点击行为。项目不会把文件上传到 MCP，也不会覆盖用户指定的本地路径。

## 网络与安全边界

- bridge 只监听 `127.0.0.1:18475`；
- 浏览器侧请求可以继承浏览器 Cookie、代理和页面网络环境；
- Node MCP server 不会自动继承浏览器代理插件配置；
- 不导出 Cookie、认证资料或浏览器 profile；
- 不绕过访问控制，不解决 CAPTCHA；
- bridge 队列只在内存中，重启会丢弃未完成任务；
- 同一机器上的 MCP 进程共享一个 bridge，不同 dedicated tab 可以并行。

## 开发

项目没有运行时依赖。可以用以下命令测试 MCP 协议和工具列表：

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp-server.js
```

适配器只在 MCP server 侧运行，详情见
[`adapters/README.md`](adapters/README.md)。

英文文档见 [`README.md`](README.md)。
