import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'htmlparser2';
import { displayWidth, replyContent } from '../src/message-format.js';

function balanced(html: string) {
  const stack: string[] = [];
  const parser = new Parser({
    onopentag(name) { if (!['br', 'hr'].includes(name)) stack.push(name); },
    onclosetag(name, implied) {
      if (['br', 'hr'].includes(name)) return;
      assert.equal(implied, false, `Implicit closing tag: ${name}`);
      assert.equal(stack.pop(), name);
    },
  });
  parser.end(html);
  assert.deepEqual(stack, []);
}

test('Element X receives native bold and fenced code, plus readable plain text', () => {
  const [result] = replyContent('Example **demo — example**.\n\n```text\nexample/project\n```', true);
  assert.equal(result.format, 'org.matrix.custom.html');
  assert.match(result.formatted_body!, /<strong>demo — example<\/strong>/);
  assert.match(result.formatted_body!, /<pre><code class="language-text">example\/project\n<\/code><\/pre>/);
  assert.match(result.body, /demo — example/);
  assert.doesNotMatch(result.body, /\*\*|```/);
  balanced(result.formatted_body!);
});

test('links, lists, inline code and newlines have HTML and plain fallbacks', () => {
  const [result] = replyContent('# Title\n\n3. *one*\n4. `two`\n\n[site](https://example.com/?a=1&b=2)\nnext', true);
  assert.match(result.formatted_body!, /<h1>Title<\/h1>/);
  assert.match(result.formatted_body!, /<ol start="3">/);
  assert.match(result.formatted_body!, /<em>one<\/em>/);
  assert.match(result.formatted_body!, /<code>two<\/code>/);
  assert.match(result.formatted_body!, /<br>/);
  assert.match(result.body, /3\. one\n4\. two/);
  assert.match(result.body, /site \(https:\/\/example.com\/\?a=1&b=2\)/);
  balanced(result.formatted_body!);
});

test('untrusted HTML, unsafe links and remote images cannot become active content', () => {
  const html = replyContent('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert) [y](data:text/html,evil) [z](//example.com) ![photo](https://example.com/photo.png)', true)
    .map(part => part.formatted_body).join('');
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript:|data:|\/\/)/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example.com\/photo.png">photo<\/a>/);
  balanced(html);
});

test('tables are drawn as box tables in a code block, with bold headers and plain cells', () => {
  const [result] = replyContent('Result:\n\n| Name | Meaning |\n| --- | --- |\n| **one** | one |\n| link | [docs](https://example.com) |\n\nEnd.', true);
  const rows = [
    '┌──────┬────────────────────────────┐',
    '│ {Name} │ {Meaning}                    │',
    '├──────┼────────────────────────────┤',
    '│ one  │ one                        │',
    '│ link │ docs (https://example.com) │',
    '└──────┴────────────────────────────┘',
  ];
  // Element X drops <table> markup but keeps <pre> and bold text inside it.
  assert.equal(result.formatted_body, `<p>Result:</p><pre><code>${rows.join('\n').replace(/\{(\w+)\}/g, '<strong>$1</strong>')}</code></pre><p>End.</p>`);
  assert.equal(result.body, `Result:\n${rows.join('\n').replace(/[{}]/g, '')}\nEnd.\n`);
  balanced(result.formatted_body!);
});

test('numeric columns are right-aligned and explicit Markdown alignment wins', () => {
  const [result] = replyContent('| Item | Cost | Amount | SKU |\n|:---|---|:---:|---|\n| Apples | 120.50 € | 3 | A1 |\n| Pears | 99 € | 12 | 7 |', true);
  assert.equal(result.body.trim(), [
    '┌────────┬──────────┬────────┬─────┐',
    '│ Item   │     Cost │ Amount │ SKU │',
    '├────────┼──────────┼────────┼─────┤',
    '│ Apples │ 120.50 € │   3    │ A1  │',
    '│ Pears  │     99 € │   12   │ 7   │',
    '└────────┴──────────┴────────┴─────┘',
  ].join('\n'));
});

test('numeric alignment accepts Unicode units, currencies and decimal digits', () => {
  for (const value of ['15.1%/h', '15,1%/ч', '15%/時', '12秒', '12мс', '12μs', '12मि', '12e\u0301', '₹12', '99 ₽', '١٢', '１２']) {
    const [result] = replyContent(`| Measurement |\n| --- |\n| ${value} |`, true);
    const row = result.body.split('\n').find(line => line.includes(value))!;
    assert.ok(row.endsWith(`${value} │`), value);
    assert.ok(row.startsWith('│  '), value);
    const [explicit] = replyContent(`| Measurement |\n| :--- |\n| ${value} |`, true);
    assert.ok(explicit.body.split('\n').some(line => line.startsWith(`│ ${value}  `)), value);
  }
  for (const value of ['A1', '12 items available', '12🚀']) {
    const [result] = replyContent(`| Measurement description |\n| --- |\n| ${value} |`, true);
    assert.ok(result.body.split('\n').some(line => line.startsWith(`│ ${value}  `)), value);
  }
});

test('wide characters take two monospace cells', () => {
  assert.equal(displayWidth('Привет'), 6);
  assert.equal(displayWidth('🚀 go'), 5);
  assert.equal(displayWidth('漢字'), 4);
  assert.equal(displayWidth('é'), 1);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(displayWidth('かな'), 4);
  assert.equal(displayWidth('한글'), 4);
  assert.equal(displayWidth('مساعد'), 5);
  const [result] = replyContent('| a | b |\n| --- | --- |\n| 🚀 | 漢字 |', true);
  assert.match(result.body, /│ 🚀 │ 漢字 │\n/);
  assert.match(result.body, /├────┼──────┤/);
});

test('table cells keep raw HTML escaped', () => {
  const [result] = replyContent('| a | b |\n| --- | --- |\n| <td onclick="x">cell</td> | <img src=x> |', true);
  assert.doesNotMatch(result.formatted_body!, /<(?:t[a-z]*|img)[\s>]/);
  assert.match(result.formatted_body!, /&lt;td onclick=&quot;x&quot;&gt;cell&lt;\/td&gt;/);
  assert.match(result.body, /│ <td onclick="x">cell<\/td> │ <img src=x> │/);
  balanced(result.formatted_body!);
});

test('a large table stays readable when it has to be split', () => {
  const rows = Array.from({ length: 400 }, (_, i) => `| row ${i} | ${'content '.repeat(3)} |`).join('\n');
  const parts = replyContent('| name | value |\n| --- | --- |\n' + rows, true);
  for (const part of parts) if (part.formatted_body) balanced(part.formatted_body);
  assert.match(parts.map(part => part.body).join('\n'), /│ row 399 │ content content content │/);
});

test('long Unicode code blocks preserve content and balanced formatting across chunks', () => {
  const code = '😀 <tag> & "quoted" sample Пример 例 مثال e\u0301\n'.repeat(900);
  const parts = replyContent('```js\n' + code + '```', true);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => part.body).join('').trimEnd(), code.trimEnd());
  for (const part of parts) {
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 36_000);
    assert.match(part.formatted_body!, /<pre><code class="language-js">/);
    balanced(part.formatted_body!);
    assert.doesNotMatch(part.body, /\uFFFD/);
  }
});

test('long nested lists and links remain balanced, including plain URL split at end', () => {
  const url = 'https://example.com/' + 'x'.repeat(1900);
  const parts = replyContent('1. **' + 'word '.repeat(420) + '**\n2. [' + 'label'.repeat(390) + '](' + url + ')', true);
  assert.ok(parts.length > 2);
  assert.ok(parts.map(part => part.body).join('').includes(` (${url})`));
  for (const part of parts) balanced(part.formatted_body!);
});

for (const length of [390, 400]) test(`plain fallback URLs stay with labels (${length * 5} characters)`, () => {
  const url = 'https://example.com/' + 'x'.repeat(1900);
  const parts = replyContent('[' + 'label'.repeat(length) + '](' + url + ')', true);
  assert.equal(parts.length, 1);
  assert.ok(parts[0].body.trimEnd().endsWith(` (${url})`));
  balanced(parts[0].formatted_body!);
});

test('operational messages remain literal, and oversized replies are truncated safely', () => {
  const literal = '**Confirm**: echo `pwd`\n!approve';
  assert.deepEqual(replyContent(literal), [{ msgtype: 'm.notice', body: literal }]);
  assert.deepEqual(replyContent(literal, false, true, 'm.text'), [{ msgtype: 'm.text', body: literal }]);
  const parts = replyContent('😀'.repeat(100_001), true, true, 'm.text');
  assert.ok(parts.every(part => part.msgtype === 'm.text'));
  assert.match(parts.at(-1)!.body, /truncated/);
  assert.equal(parts.slice(0, -1).map(part => part.body).join('').trim().length, 200_000);
});
