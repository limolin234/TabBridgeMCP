'use strict';

module.exports = {
  name: 'generic',
  matches: () => true,
  plan: () => ({
    fields: [
      { key: 'title', kind: 'text', selector: 'title', limit: 500 },
      { key: 'mainText', kind: 'text', selector: 'main, article, [role="main"], body', limit: 4000 },
      { key: 'headings', kind: 'list', selector: 'h1, h2, h3', limit: 20, properties: ['text'] },
      { key: 'links', kind: 'list', selector: 'a[href]', limit: 30, properties: ['text', 'href'] },
      { key: 'controls', kind: 'list', selector: 'input, textarea, select, button', limit: 30, properties: ['tag', 'type', 'name', 'id', 'placeholder', 'text'] },
    ],
  }),
};
