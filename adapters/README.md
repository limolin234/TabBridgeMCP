# Adapter Contract

Adapters run only in the MCP server. They return a declarative extraction plan;
they never execute JavaScript in the browser tab.

An adapter module exports:

```js
module.exports = {
  name: 'short-name',
  matches: (url) => new URL(url).hostname === 'example.invalid',
  plan: (url) => ({ fields: [
    { key: 'title', kind: 'text', selector: 'h1', limit: 300 },
    { key: 'items', kind: 'list', selector: '.item', limit: 20, properties: ['text', 'href'] },
  ] }),
};
```

Supported field kinds are `text`, `attribute`, and `list`. Supported list
properties are `text`, `href`, `tag`, `type`, `name`, `id`, and `placeholder`.
The userscript validates field counts, selectors, and limits before querying the
page.

Set `TABBRIDGE_ADAPTERS_DIR` to a private directory of adapter modules. Those
modules are loaded ahead of the public generic fallback and are never part of
this repository.
