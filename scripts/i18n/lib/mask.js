// 发送翻译前遮盖占位符，收到译文后还原
// 接口会保留 {n}，但会调换它们的顺序，所以还原时按需改写成带序号的 %n$ 形式

import { isFormatText, specsOf } from "./format.js";

const TOKEN_RE = /\{(\d+)\}/g;

// 返回 { text, specs, is_format }；text 中第 n 个参数写成 {n}，%% 写成 %
// 不支持的文案返回 null：含 %#@var@（stringsdict 变量），或原文本身含 {数字}（会和遮盖标记混淆）
export const maskOf = (source) => {
  const specs = specsOf(source);
  if (specs.some((s) => s.var !== undefined) || /\{\d+\}/.test(source)) return null;
  let text = "",
    last = 0;
  for (const s of specs) {
    text += source.slice(last, s.start).replaceAll("%%", "%") + "{" + s.pos + "}";
    last = s.end;
  }
  text += source.slice(last).replaceAll("%%", "%");
  return { text, specs, is_format: isFormatText(source) };
};

// 去掉占位符中的序号：%2$@ → %@
const plainOf = (raw) => raw.replace(/^%\d+\$/, "%");

// 还原占位符；参数缺失或多出时返回 null
export const unmaskOf = (masked, translated) => {
  const by_pos = new Map(masked.specs.map((s) => [s.pos, s])),
    order = [...translated.matchAll(TOKEN_RE)].map((m) => Number(m[1]));
  if (order.some((p) => !by_pos.has(p)) || new Set(order).size !== by_pos.size) return null;

  // 参数顺序不变、没有重复、原文也没有用序号时，保持原写法；否则全部改成带序号的写法
  const keep = order.every((p, i) => p === i + 1) && masked.specs.every((s) => !s.explicit);
  let out = "",
    last = 0;
  for (const m of translated.matchAll(TOKEN_RE)) {
    const literal = translated.slice(last, m.index);
    out += masked.is_format ? literal.replaceAll("%", "%%") : literal;
    const spec = by_pos.get(Number(m[1]));
    out += keep ? spec.raw : "%" + spec.pos + "$" + plainOf(spec.raw).slice(1);
    last = m.index + m[0].length;
  }
  const tail = translated.slice(last);
  return out + (masked.is_format ? tail.replaceAll("%", "%%") : tail);
};
