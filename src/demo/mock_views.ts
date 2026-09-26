// HTML views for offline-mode artifacts, so demo links open a realistic Notion page and X post
// instead of dead URLs. Served by the demo server at /mock/notion/:id and /mock/x/:id.
import type { MockPage, MockTweet } from '../swytchcode/mock_executor.ts';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Escapes text and turns URLs (and optionally hashtags) into markup. URLs are never re-scanned for hashtags. */
function richText(text: string, { hashtags = false } = {}): string {
  return text
    .split(URL_RE)
    .map((part, i) => {
      if (i % 2 === 1) return `<a href="${escapeHtml(part)}" target="_blank" rel="noopener">${escapeHtml(part)}</a>`;
      const escaped = escapeHtml(part);
      return hashtags ? escaped.replace(/(^|\s)(#[\p{L}\p{N}_]+)/gu, '$1<span class="tag">$2</span>') : escaped;
    })
    .join('')
    .replace(/\n/g, '<br>');
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' });

function shell(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; -webkit-font-smoothing: antialiased; }
  .mock-banner {
    position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; justify-content: center; align-items: center;
    padding: 8px 16px; font: 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: rgba(255, 149, 0, 0.12); color: #8a4b00; border-bottom: 1px solid rgba(255, 149, 0, 0.25);
    backdrop-filter: blur(12px);
  }
  .mock-banner a { color: #007aff; text-decoration: none; }
  ${css}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------- Notion ----------

type Block = { type?: string } & Record<string, { rich_text?: Array<{ text?: { content?: string }; plain_text?: string }> } | string | undefined>;

const blockText = (block: Block) => {
  const content = block[block.type ?? ''];
  const parts = typeof content === 'object' ? (content.rich_text ?? []) : [];
  return parts.map((p) => p.text?.content ?? p.plain_text ?? '').join('');
};

function renderBlocks(blocks: Block[]): string {
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (const block of blocks) {
    const text = richText(blockText(block));
    const wanted = block.type === 'bulleted_list_item' ? 'ul' : block.type === 'numbered_list_item' ? 'ol' : null;
    if (wanted !== list) {
      closeList();
      if (wanted) html.push(`<${wanted}>`);
      list = wanted;
    }
    switch (block.type) {
      case 'heading_1': html.push(`<h1 class="h1">${text}</h1>`); break;
      case 'heading_2': html.push(`<h2 class="h2">${text}</h2>`); break;
      case 'heading_3': html.push(`<h3 class="h3">${text}</h3>`); break;
      case 'bulleted_list_item':
      case 'numbered_list_item': html.push(`<li class="li">${text}</li>`); break;
      default: html.push(`<p class="p">${text}</p>`);
    }
  }
  closeList();
  return html.join('\n');
}

export function renderNotionPage(page: MockPage): string {
  const blocks = ((page.body as { children?: Block[] })?.children ?? []) as Block[];
  const css = `
  body { background: #fff; color: #37352f; font: 16px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif; }
  .topbar { display: flex; align-items: center; gap: 6px; padding: 10px 16px; font-size: 14px; color: rgba(55, 53, 47, 0.65); }
  .page { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
  .icon { font-size: 64px; line-height: 1; margin-bottom: 12px; }
  .title { font-size: 40px; line-height: 1.2; font-weight: 700; margin: 0 0 12px; letter-spacing: -0.01em; }
  .props { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; font-size: 14px; padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid rgba(55, 53, 47, 0.09); }
  .props dt { color: rgba(55, 53, 47, 0.65); }
  .props dd { margin: 0; }
  .h1 { font-size: 30px; margin: 32px 0 4px; } .h2 { font-size: 24px; margin: 28px 0 4px; font-weight: 600; } .h3 { font-size: 20px; margin: 20px 0 4px; }
  .p { margin: 4px 0; min-height: 1.6em; }
  ul, ol { margin: 4px 0; padding-left: 26px; } .li { margin: 2px 0; }
  a { color: inherit; text-decoration: underline; text-decoration-color: rgba(55, 53, 47, 0.4); }
  @media (max-width: 520px) { .title { font-size: 30px; } .page { padding-top: 24px; } .props { grid-template-columns: 1fr; } }`;
  const body = `
<div class="mock-banner">Mock Notion page · created offline by the Event agent via <code>notion.page.create</code> <a href="/">← Back to demo</a></div>
<div class="topbar">📄 Antigravity Fan Club / Events / ${escapeHtml(page.title)}</div>
<main class="page">
  <div class="icon">🗓️</div>
  <h1 class="title">${escapeHtml(page.title)}</h1>
  <dl class="props">
    <dt>Created by</dt><dd>AI Community Organizer</dd>
    <dt>Created</dt><dd>${escapeHtml(formatDate(page.createdAt))}</dd>
    <dt>Page ID</dt><dd>${escapeHtml(page.id)}</dd>
  </dl>
  ${renderBlocks(blocks)}
</main>`;
  return shell(`${page.title} | Notion (mock)`, css, body);
}

// ---------- X ----------

export function renderTweet(tweet: MockTweet): string {
  const css = `
  body { background: #fff; color: #0f1419; font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, sans-serif; }
  .column { max-width: 600px; margin: 0 auto; min-height: 100vh; border-left: 1px solid #eff3f4; border-right: 1px solid #eff3f4; }
  .header { padding: 12px 16px; font-size: 20px; font-weight: 700; border-bottom: 1px solid #eff3f4; }
  .post { padding: 12px 16px; }
  .author { display: flex; gap: 12px; align-items: center; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px;
    background: linear-gradient(135deg, #ff9933 0%, #ff9933 33%, #ffffff 33%, #ffffff 66%, #bc002d 66%); text-shadow: 0 1px 2px rgba(0,0,0,.4); }
  .name { font-weight: 700; } .handle { color: #536471; }
  .text { font-size: 17px; line-height: 1.5; margin: 12px 0; word-wrap: break-word; }
  .text a, .tag { color: #1d9bf0; text-decoration: none; }
  .meta { color: #536471; padding: 12px 0; border-bottom: 1px solid #eff3f4; }
  .stats { display: flex; gap: 20px; padding: 12px 0; color: #536471; border-bottom: 1px solid #eff3f4; font-size: 14px; }
  .stats b { color: #0f1419; }`;
  const body = `
<div class="mock-banner">Mock X post · not published, created offline by the Growth agent via <code>twitter_v2.tweet.create</code> <a href="/">← Back to demo</a></div>
<div class="column">
  <div class="header">Post</div>
  <article class="post">
    <div class="author">
      <div class="avatar" aria-hidden="true">AF</div>
      <div><div class="name">Antigravity Fan Club</div><div class="handle">@AntigravityFC</div></div>
    </div>
    <div class="text">${richText(tweet.text, { hashtags: true })}</div>
    <div class="meta">${escapeHtml(formatDate(tweet.createdAt))} · ID ${escapeHtml(tweet.id)}</div>
    <div class="stats"><span><b>0</b> Reposts</span><span><b>0</b> Quotes</span><span><b>0</b> Likes</span><span><b>0</b> Bookmarks</span></div>
  </article>
</div>`;
  return shell('Antigravity Fan Club on X (mock)', css, body);
}
