# TabBridge — 油猴脚本冻结契约 (v0.7.0)

> 本文档记录 Tampermonkey userscript 的**冻结接口**。v0.7.0 之后**不再修改油猴脚本**;
> 所有智能(交互对象分析、selector 合成、索引、绑定校验、优先级)都在本地
> `publish/analyzer.js` 与 `publish/mcp-server.js` 侧演进。

## 分层哲学

| 层 | 职责 | 可否改 |
| --- | --- | --- |
| `tampermonkey/tampermonkey-browser-mcp.user.js` (v1.0.1) | **采集物理量 + 执行底层动作 + 汇报**,不判断 | 冻结;v1.0.1 起仅允许低层时序等待 |
| `bridge.js` | 单实例本地队列,任务源真相(pending 计数) | 最小改动 |
| `analyzer.js` + `mcp-server.js` + `adapters/` | **全部智能**:交互清单、selector、索引、绑定守卫、优先级 | 自由演进 |

## 油猴采集的物理量(property 虚拟属性)

| 属性 | 含义 | 类型 |
| --- | --- | --- |
| `rect` | `getBoundingClientRect()` → `{x,y,w,h}` | 浏览器独占几何 |
| `isDisplayed` | computed display/visibility + getClientRects | 浏览器独占可见性 |
| `disabled` / `checked` / `value` / `type` / `role` | 原始表单/ARIA 状态 | 原始属性 |
| `path` | 扁平父链 `[{tag,id,class,nth}]` 深度≤8 | 机械采集,无判断 |
| `text` / `href` / `tag` | 文本/链接/标签 | 原始 |

**油猴不做**:判断可交互性、去重、排优先级、算 inViewport、合成 CSS selector、生成 point。
这些全部由本地 `analyzeInteract()` 从 `rect`/`path` 计算。

## 油猴执行的底层动作(job types)

| type | 入参 | 说明 |
| --- | --- | --- |
| `navigate` / `extract` / `inspect` / `click` / `fill` | 原有 | 兼容 v0.6 |
| `scroll` | `selector` 或 `x,y` 或 `dx,dy` | scrollIntoView center / 绝对 / 相对 |
| `focus` | `selector` | el.focus() |
| `hover` | `selector` | dispatch pointerover/mouseover/mouseenter/mousemove |
| `key` | `key`, `code` | dispatch keydown/keypress/keyup |
| `clickPoint` | `x,y` | elementFromPoint → closest 可点祖先 → click |
| `verifyPoint` | `x,y` | elementFromPoint 反查 → `{tag,text,href,rect}`(绑定守卫用) |
| `download` | `url`, `filename`, `force` | 无 force 且 GM_download 可用 → 后台 GM_download |

## 冻结约束

1. **不新增判断逻辑**到油猴(点击/优先级/可见性都算判断)。
2. **不新增几何派生**(inViewport/point/selector 全本地)。
3. GM_download 是浏览器级后台下载,无字节进度 —— `job_status` 报 phase(`downloading`→`completed`);`force:true` 走 fetch→blob 字节进度。
4. 自适应轮询:完成任务 60ms / 有 pending 150ms / 空闲 1200ms。bridge `/poll` 返回 `pending` 计数。
5. 未来视觉/截图能力(多模态)落在**本地**,基于油猴已报的 `rect` 坐标作为锚点,不需改油猴。
6. 已知限制(冻结期内不解决):Shadow DOM 不穿透;纯 CSS `:hover` 菜单不展开;React 受控输入建议用 `clickPoint`+`key` 而非 `fill`。
7. **例外(v1.0.1)**: 新增低层就绪等待 `waitForReady` —— 有 selector 时轮询 `querySelector` 命中,否则等 `document.readyState === 'complete'`;`force:true` 跳过。这是时序采集而非判断,不涉及交互对象分析/selector 合成/优先级,是唯一允许的油猴演进。
