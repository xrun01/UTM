// 格式占位符解析：%@、%lld、%1$@、%.1f、%*d、%#@var@ 与字面量 %%

// 依次匹配：%%；stringsdict 变量 %#@name@（可带位置）；printf 格式（可带位置、标志、宽度、精度、长度修饰）
// 标志不含空格：「50% done」里的「% d」是字面量，不是占位符。真正需要百分号的格式文案必须写 %%
const SPEC_RE =
  /%%|%(?:(\d+)\$)?#@([A-Za-z_][A-Za-z0-9_]*)@|%(?:(\d+)\$)?[-+#0']*(\d+|\*(?:\d+\$)?)?(?:\.(\d+|\*(?:\d+\$)?))?(hh|h|ll|l|q|L|z|t|j)?([@dDiuUxXoOfFeEgGaAcCsSp])/g;

// 同一个参数的不同写法视为同一类型：%d 与 %i、%ld 与 %lld（64 位平台）、%lf 与 %f
const TYPE_ALIAS = { i: "d", D: "d", U: "u", O: "o", F: "f" },
  LEN_ALIAS = { l: "ll", q: "ll" },
  FLOAT = new Set(["f", "F", "e", "E", "g", "G", "a", "A"]);

const typeOf = (len, conv) => {
  const t = TYPE_ALIAS[conv] ?? conv;
  if (FLOAT.has(conv)) return t;
  return (LEN_ALIAS[len] ?? len ?? "") + t;
};

// 返回占位符列表：{ raw, start, end, pos, explicit, type, var }；%% 不计入
// 宽度或精度写成 * 时，它也占 1 个 int 参数
export const specsOf = (text) => {
  const out = [];
  let seq = 0;
  for (const m of text.matchAll(SPEC_RE)) {
    if (m[0] === "%%") continue;
    const base = { raw: m[0], start: m.index, end: m.index + m[0].length };
    if (m[2] !== undefined) {
      out.push({ ...base, pos: m[1] ? Number(m[1]) : ++seq, explicit: !!m[1], var: m[2], type: "var:" + m[2] });
      continue;
    }
    for (const star of [m[4], m[5]]) {
      if (!star?.startsWith("*")) continue;
      const p = star.match(/^\*(\d+)\$$/);
      out.push({ raw: star, start: m.index, end: m.index, pos: p ? Number(p[1]) : ++seq, explicit: !!p, type: "d", star: true });
    }
    out.push({ ...base, pos: m[3] ? Number(m[3]) : ++seq, explicit: !!m[3], type: typeOf(m[6], m[7]) });
  }
  return out;
};

// 去掉占位符和 %% 后剩下的 % 是孤立的百分号
const loosePercentOf = (text) => {
  let rest = text;
  for (const s of specsOf(text).filter((s) => !s.star).reverse()) rest = rest.slice(0, s.start) + rest.slice(s.end);
  return rest.replaceAll("%%", "").includes("%");
};

// 原文是格式文案：含占位符或 %%。这种文案运行时会经过格式化，字面量 % 必须写成 %%
export const isFormatText = (text) => specsOf(text).length > 0 || text.includes("%%");

// 占位符签名：按位置排序成 "1:@,2:lld"
export const signatureOf = (text) =>
  [...new Set(specsOf(text).map((s) => s.pos + ":" + s.type))]
    .sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]) || (a < b ? -1 : 1))
    .join(",");

// 比较原文与译文的占位符：返回问题描述，没有问题时返回 null
export const specMismatchOf = (source, translation) => {
  const pos_li = specsOf(translation);
  if (pos_li.some((s) => s.explicit) && pos_li.some((s) => !s.explicit)) {
    return "译文混用了带序号和不带序号的占位符";
  }
  const a = signatureOf(source),
    b = signatureOf(translation);
  if (a !== b) return "占位符不一致：原文 [" + a + "]，译文 [" + b + "]";
  if (isFormatText(source) && loosePercentOf(translation)) return "格式文案中的百分号必须写成 %%";
  return null;
};
