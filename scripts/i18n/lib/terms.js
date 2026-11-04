// 必须原样保留的专有名词：不翻译、不音译、不改大小写
// 译文可以在词尾加变格，所以按词干判断是否出现（斯拉夫语会把 Rosetta 写成 Rosettę）

export const KEEP_TERMS = [
  "UTM",
  "VM64",
  "Apple",
  "Mac",
  "macOS",
  "Windows",
  "Linux",
  "Microsoft",
  "Intel",
  "QEMU",
  "Rosetta",
  "SPICE",
  "VirtIO",
  "VirtFS",
  "UEFI",
  "TPM",
  "IPSW",
  "USB",
  "NVMe",
  "ARM64",
  "App Store",
  "AppleScript",
];

const STEMS = { Rosetta: "Rosett", iPhone: "iPhon" };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 按字母边界匹配，避免把 "Macs" 当成 "Mac"、把 "macOS" 当成 "Mac"
const boundaryRe = (term, flags) => new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(term) + "(?![\\p{L}\\p{N}])", flags);

// 返回 [{ term, msg }]；term 用于例外清单的匹配
export const termIssuesOf = (source, translation, terms = KEEP_TERMS) => {
  const out = [];
  for (const term of terms) {
    if (!boundaryRe(term, "u").test(source)) continue;
    const stem = STEMS[term] ?? term;
    if (translation.includes(stem)) continue;
    // 只在词边界上找大小写不同的写法，避免把 "macOS" 里的 "mac" 当成 "Mac"
    const wrong_case = translation.match(
      new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(stem) + (STEMS[term] ? "" : "(?![\\p{L}\\p{N}])"), "iu"),
    );
    out.push({
      term,
      msg: wrong_case ? "专有名词大小写错误：应为 " + term + "，译文写成 " + wrong_case[0] : "缺少专有名词 " + term,
    });
  }
  return out;
};
