// 审校报告：单文件 HTML。先列待决定的事项，再逐条列改动；可以按语言筛选和搜索
// 数据以 JSON 嵌入页面，全部用 textContent 渲染，不拼接 HTML

export const reportHtmlOf = (data) => {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-Hans">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UTM 译文审校</title>
<style>
:root {
  --bg: #f6f7f9; --surface: #fff; --fg: #1b2230; --muted: #5b6475; --line: #dde1e8;
  --accent: #1f5fbf; --old: #a1352b; --new: #1d6b3f; --warn: #8a5a00; --warn-bg: #fff6e0;
  --sans: -apple-system, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12161d; --surface: #1a2029; --fg: #e6e9ef; --muted: #9aa3b2; --line: #2c3442;
  --accent: #7aa7ff; --old: #f08a80; --new: #6fd19a; --warn: #f3c260; --warn-bg: #2e2612; } }
:root[data-theme="dark"] {
  --bg: #12161d; --surface: #1a2029; --fg: #e6e9ef; --muted: #9aa3b2; --line: #2c3442;
  --accent: #7aa7ff; --old: #f08a80; --new: #6fd19a; --warn: #f3c260; --warn-bg: #2e2612; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 var(--sans); }
main { max-width: 900px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 36px 0 12px; }
.sub, .muted { color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: start; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.bar select, .bar input { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--fg); }
.bar input { flex: 1 1 220px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
.card.todo { border-color: var(--warn); background: var(--warn-bg); }
.meta { font-size: 13px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; }
.tag { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
.row { display: grid; grid-template-columns: 4.5em 1fr; gap: 4px 10px; margin-top: 6px; }
.row b { font-weight: 500; color: var(--muted); font-size: 13px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.old { color: var(--old); } .new { color: var(--new); }
.id { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
details summary { cursor: pointer; color: var(--accent); }
</style>
<main>
<h1>UTM 译文审校</h1>
<p class="sub" id="sub"></p>
<table id="summary"><thead><tr><th>语言</th><th>改动</th><th>确认</th><th>待决定</th></tr></thead><tbody></tbody></table>
<h2>待决定</h2>
<div id="todo"></div>
<h2>改动</h2>
<div class="bar"><select id="lang"><option value="">全部语言</option></select><input id="q" type="search" placeholder="搜索英文、译文或理由"></div>
<div id="changes"></div>
<h2>确认无误的条目</h2>
<div id="approved"></div>
</main>
<script>
const DATA = ${json};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const row = (label, text, cls) => { const r = el("div", "row"); r.append(el("b", "", label), el("div", "text " + (cls || ""), text)); return r; };
const total = (k) => DATA.reduce((n, d) => n + d[k].length, 0);
document.getElementById("sub").textContent = DATA.length + " 种语言，改动 " + total("changes") + " 条，确认 " + total("approved") + " 条";
const tbody = document.querySelector("#summary tbody"), lang_sel = document.getElementById("lang");
for (const d of DATA) {
  const tr = el("tr");
  for (const v of [d.lang, d.changes.length, d.approved.length, d.doubts.length + d.source_issues.length]) tr.append(el("td", "", String(v)));
  tbody.append(tr);
  lang_sel.append(Object.assign(el("option", "", d.lang), { value: d.lang }));
}
const todo = document.getElementById("todo");
for (const d of DATA) {
  for (const x of d.doubts) { const c = el("div", "card todo"); c.append(el("div", "meta", d.lang + " · 拿不准的译文"), el("div", "id", x.id || ""), row("当前", x.current || ""), row("问题", x.question || "")); todo.append(c); }
  for (const x of d.source_issues) { const c = el("div", "card todo"); c.append(el("div", "meta", d.lang + " · 英文原文的问题"), el("div", "id", x.id || ""), row("英文", x.en || ""), row("问题", x.problem || ""), row("建议", x.suggest || "")); todo.append(c); }
}
if (!todo.children.length) todo.append(el("p", "muted", "没有待决定的事项。"));
const changes = document.getElementById("changes"), q = document.getElementById("q");
const render = () => {
  changes.replaceChildren();
  const needle = q.value.trim().toLowerCase();
  for (const d of DATA) {
    if (lang_sel.value && d.lang !== lang_sel.value) continue;
    for (const c of d.changes) {
      if (needle && ![c.en, c.old, c.new, c.reason, c.back].some((s) => (s || "").toLowerCase().includes(needle))) continue;
      const card = el("div", "card"), meta = el("div", "meta");
      meta.append(el("span", "tag", d.lang), el("span", "tag", c.type || ""));
      card.append(meta, el("div", "id", c.id), row("英文", c.en), row("原译", c.old, "old"), row("新译", c.new, "new"), row("回译", c.back || "（没有回译）"));
      if (c.note) card.append(row("回译备注", c.note));
      card.append(row("理由", c.reason || ""));
      changes.append(card);
    }
  }
  if (!changes.children.length) changes.append(el("p", "muted", "没有匹配的改动。"));
};
lang_sel.addEventListener("change", render); q.addEventListener("input", render); render();
const approved = document.getElementById("approved");
for (const d of DATA) {
  if (!d.approved.length) continue;
  const det = el("details"); det.append(el("summary", "", d.lang + "：" + d.approved.length + " 条"));
  for (const a of d.approved) { const c = el("div", "card"); c.append(el("div", "id", a.id), row("英文", a.en), row("译文", a.value), row("回译", a.back || "（没有回译）")); if (a.note) c.append(row("回译备注", a.note)); det.append(c); }
  approved.append(det);
}
if (!approved.children.length) approved.append(el("p", "muted", "没有。"));
</script>
</html>
`;
};
