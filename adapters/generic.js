'use strict';

module.exports = {
  name: 'generic',
  matches: () => true,
  plan: (url, options = {}) => {
    const mode = options.mode || 'summary';
    if (mode === 'text') return { fields: [{ key: 'text', kind: 'text', selector: options.selector || 'main, article, [role="main"], body', limit: Math.min(Number(options.limit) || 8000, 8000) }] };
    if (mode === 'links') return { fields: [{ key: 'links', kind: 'list', selector: options.selector || 'a[href]', limit: 100, properties: ['text', 'href', 'tag', 'rect', 'isDisplayed'] }] };
    if (mode === 'controls') return { fields: [{ key: 'controls', kind: 'list', selector: options.selector || 'input, textarea, select, button', limit: 100, properties: ['tag', 'type', 'name', 'id', 'placeholder', 'text', 'disabled', 'checked', 'value', 'rect', 'isDisplayed'] }] };
    if (mode === 'elements') return { fields: [{ key: 'elements', kind: 'list', selector: options.selector || 'body *', limit: 100, properties: ['tag', 'id', 'class', 'role', 'aria-label', 'name', 'type', 'placeholder', 'text', 'href', 'src', 'disabled', 'rect', 'isDisplayed'] }] };
    if (mode === 'media') return { fields: [{ key: 'media', kind: 'list', selector: options.selector || 'img, video, audio, source', limit: 100, properties: ['tag', 'src', 'alt', 'title', 'width', 'height', 'text'] }] };
    return {
      fields: [
        { key: 'title', kind: 'text', selector: 'title', limit: 500 },
        { key: 'mainText', kind: 'text', selector: options.selector || 'main, article, [role="main"], body', limit: 4000 },
        { key: 'headings', kind: 'list', selector: 'h1, h2, h3', limit: 20, properties: ['text'] },
        { key: 'links', kind: 'list', selector: 'a[href]', limit: 30, properties: ['text', 'href'] },
        { key: 'controls', kind: 'list', selector: 'input, textarea, select, button', limit: 30, properties: ['tag', 'type', 'name', 'id', 'placeholder', 'text'] },
      ],
    };
  },
};
