// 审校报告：单文件 HTML。先列待决定的事项，再列回译不一致与撤回的改动，然后逐条列改动和确认的条目
// 语言筛选和搜索对所有区块生效。数据以 JSON 嵌入页面，全部用 textContent 渲染，不拼接 HTML

export const reportHtmlOf = (data) => {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-Hans">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UTM 译文审校</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #fff; --fg: #1b2230; --muted: #5b6475; --line: #dde1e8;
  --accent: #1f5fbf; --old: #a1352b; --new: #1d6b3f; --warn: #8a5a00; --warn-bg: #fff6e0;
  --sans: -apple-system, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #12161d; --surface: #1a2029; --fg: #e6e9ef; --muted: #9aa3b2; --line: #2c3442;
  --accent: #7aa7ff; --old: #f08a80; --new: #6fd19a; --warn: #f3c260; --warn-bg: #2e2612; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 var(--sans); }
main { max-width: 900px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 36px 0 12px; }
.sub, .muted { color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: start; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; position: sticky; top: 0; background: var(--bg); padding: 8px 0; }
.bar select, .bar input { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--fg); }
.bar input { flex: 1 1 220px; min-width: 0; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
.card.todo { border-color: var(--warn); background: var(--warn-bg); }
.meta { font-size: 13px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; }
.tag { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
.row { display: grid; grid-template-columns: 4.5em minmax(0, 1fr); gap: 4px 10px; margin-top: 6px; }
.row b { font-weight: 500; color: var(--muted); font-size: 13px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; unicode-bidi: plaintext; }
.old { color: var(--old); } .new { color: var(--new); }
.id { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
details summary { cursor: pointer; color: var(--accent); }
</style>
<main>
<h1>UTM 译文审校</h1>
<p class="sub" id="sub"></p>
<table id="summary"><thead><tr><th>语言</th><th>改动</th><th>确认</th><th>待决定</th><th>回译不一致</th><th>缺回译</th><th>撤回</th></tr></thead><tbody></tbody></table>
<div class="bar"><select id="lang" aria-label="语言"><option value="">全部语言</option></select><input id="q" type="search" placeholder="搜索英文、译文或理由" aria-label="搜索"></div>
<h2>待决定</h2>
<div id="todo"></div>
<h2>回译不一致</h2>
<div id="mismatch"></div>
<h2>撤回的改动</h2>
<div id="withdrawn"></div>
<h2>改动</h2>
<div id="changes"></div>
<h2>确认无误的条目</h2>
<div id="approved"></div>
</main>
<script>
const DATA = ${json};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
// 译文按目标语言渲染：lang 决定字形，dir=auto 让从右到左的文字和占位符按正确顺序显示
const row = (label, text, cls, lang) => {
  const r = el("div", "row"), v = el("div", "text " + (cls || ""), text || "");
  if (lang) { v.lang = lang; v.dir = "auto"; }
  r.append(el("b", "", label), v);
  return r;
};
const card = (cls, metaParts, id) => {
  const c = el("div", "card " + (cls || "")), meta = el("div", "meta");
  for (const m of metaParts) if (m) meta.append(el("span", "tag", m));
  c.append(meta);
  if (id) c.append(el("div", "id", id));
  return c;
};
const total = (k) => DATA.reduce((n, d) => n + d[k].length, 0);
document.getElementById("sub").textContent = DATA.length + " 种语言，改动 " + total("changes") + " 条，确认 " + total("approved") + " 条";
const tbody = document.querySelector("#summary tbody"), lang_sel = document.getElementById("lang"), q = document.getElementById("q");
for (const d of DATA) {
  const tr = el("tr");
  for (const v of [d.lang, d.changes.length, d.approved.length, d.doubts.length + d.source_issues.length, d.mismatches.length, d.no_back, d.withdrawn.length]) tr.append(el("td", "", String(v)));
  tbody.append(tr);
  lang_sel.append(Object.assign(el("option", "", d.lang), { value: d.lang }));
}
const SECTIONS = {
  todo: (d) => [
    ...d.doubts.map((x) => [x, () => { const c = card("todo", [d.lang, "拿不准的译文"], x.id); c.append(row("英文", x.en), row("当前", x.current, "", d.lang), row("问题", x.question)); return c; }]),
    ...d.source_issues.map((x) => [x, () => { const c = card("todo", [d.lang, "英文原文的问题"], x.id); c.append(row("英文", x.en), row("问题", x.problem), row("建议", x.suggest)); return c; }]),
  ],
  mismatch: (d) => d.mismatches.map((x) => [x, () => { const c = card("todo", [d.lang, x.type], x.id); c.append(row("英文", x.en), row("问题", x.problem)); return c; }]),
  withdrawn: (d) => d.withdrawn.map((x) => [x, () => { const c = card("", [d.lang, "保持 needs_review"], x.id); c.append(row("英文", x.en), row("当前", x.current, "", d.lang), row("原因", x.reason)); return c; }]),
  changes: (d) => d.changes.map((x) => [x, () => {
    const c = card("", [d.lang, x.type], x.id);
    c.append(row("英文", x.en), row("原译", x.old || "（缺译）", "old", d.lang), row("新译", x.new, "new", d.lang), row("回译", x.back || "（没有回译）"));
    if (x.note) c.append(row("回译备注", x.note));
    c.append(row("理由", x.reason));
    return c;
  }]),
  approved: (d) => d.approved.map((x) => [x, () => {
    const c = card("", [d.lang], x.id);
    c.append(row("英文", x.en), row("译文", x.value, "", d.lang), row("回译", x.back || "（没有回译）"));
    if (x.note) c.append(row("回译备注", x.note));
    return c;
  }]),
};
const EMPTY = { todo: "没有待决定的事项。", mismatch: "没有回译不一致的条目。", withdrawn: "没有撤回的改动。", changes: "没有匹配的改动。", approved: "没有。" };
const matches = (x) => {
  const needle = q.value.trim().toLowerCase();
  return !needle || Object.values(x).some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
};
const render = () => {
  for (const [name, build] of Object.entries(SECTIONS)) {
    const box = document.getElementById(name);
    box.replaceChildren();
    for (const d of DATA) {
      if (lang_sel.value && d.lang !== lang_sel.value) continue;
      const cards = build(d).filter(([x]) => matches(x)).map(([, make]) => make());
      if (!cards.length) continue;
      // 确认的条目数量多，按语言折叠
      if (name === "approved") {
        const det = el("details"); det.append(el("summary", "", d.lang + "：" + cards.length + " 条"), ...cards); box.append(det);
      } else box.append(...cards);
    }
    if (!box.children.length) box.append(el("p", "muted", EMPTY[name]));
  }
};
lang_sel.addEventListener("change", render); q.addEventListener("input", render); render();
</script>
</html>
`;
};
