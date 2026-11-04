---
name: utm-i18n
description: UTM 的国际化流程：加文案（新增或修改界面文案后提取、翻译、审校）、加语言、审校译文。输入用自然语言描述，例如「Windows 向导加了几句文案」「加上巴西葡萄牙语」「审校日语和韩语新加的译文」。当用户说「加文案」「翻译新文案」「加语言」「审校 <语言>」「utm-i18n」或「/utm-i18n」时使用。
---

# utm-i18n

这份说明与代理无关，用你的代理提供的工具执行，例如 Claude Code、Codex、OpenCode。这是权威版本，`.claude/commands/`、`.opencode/command/` 下的文件只做转发。

## 先读

| 文件 | 用途 |
|---|---|
| `Documentation/i18n.md` | 文件布局、条目状态、写文案的规则、检查项 |
| `i18n/glossary/terms.yml` | 术语定义和翻译规则 |
| `i18n/glossary/<lang>.yml` | 这种语言定下的译法 |
| `i18n/languages.json` | 已启用的语言，以及 Apple 代码和翻译接口代码 |

## 选择流程

用户的输入是自然语言。先判断属于哪个流程，再把你理解的范围用 1 句话告诉用户，然后开始。

| 用户说的 | 流程 |
|---|---|
| 加了或改了界面文案、「翻译新文案」 | 流程 1：加文案 |
| 「加上 <语言>」「支持 <语言>」 | 流程 2：加语言 |
| 「审校 <语言>」「检查 <语言> 的译文」 | 流程 3：审校 |

## 通用约束

- 不要手动改 catalog 的格式，只用 `scripts/i18n/` 下的脚本或 Xcode 修改。
- 同一句英文只有 1 种译法。同一个英文词有 2 种意思时，在源码中改用显式键，见 `Documentation/i18n.md`。
- 翻译只在本地运行，不在 CI 运行。`translate.js` 的 token 取环境变量 `WEBC_TOKEN`，或 `~/.config/webc.site.yml`。不要打印 token。
- 多个分支同时改 catalog 会冲突。合并到 `main` 必须串行，合并前先 rebase，再运行 sync 和 check。
- 构建命令在 `UTM` 和 `vm` 的上级目录运行：`bun vm/script/buildApp.js`。其他命令在 UTM 仓库根目录运行。
- 第 1 次运行脚本前，在 `scripts/i18n/` 中运行 `bun install`。

## 流程 1：加文案

输入：可选的自然语言描述，例如「只看 Windows 向导」。描述只用来缩小审校范围。不写时，审校全部新文案。

1. 运行 `bun vm/script/buildApp.js`。
2. 运行 `bun scripts/i18n/sync.js`。
   结果：新文案进入 catalog，源码已不用的键被删除。
3. 运行 `bun scripts/i18n/review.js new-keys --out <tmp>/new-keys.json`。
   结果：得到所有语言都缺译的键，也就是新文案。按用户的描述筛选。
4. 审校新文案的英文。规则如下，有问题就改源码，然后回到第 1 步：
   - 菜单项、按钮、窗口标题用首字母大写（title case），说明文字和提示用句首大写（sentence case）。
   - 执行前要求用户输入更多信息的菜单项和按钮，以「…」（U+2026）结尾，不写「...」。
   - 专有名词的写法见 `scripts/i18n/lib/terms.js` 和术语表。
   - 有歧义的短词（例如 Display、Open）加 `comment`，或改用显式键。
5. 运行 `bun scripts/i18n/translate.js`。它机翻所有语言的缺译条目，但不翻译短标签（最多 2 个词、不含占位符）。短标签缺少上下文，机翻常选错义项。
   结果：每种语言输出写入条数、失败条数、留给 skill 的短标签条数。失败的条目和短标签保持缺译，运行时显示英文，在第 7 步补译。
6. 运行 `bun scripts/i18n/check.js --ci`。
   结果：`0 个错误`。
7. 审校和补译新文案：执行流程 3 的第 1 至 8 步，导出命令是 `review.js export --lang <lang> --keys <tmp>/new-keys.json --state needs_review,missing --out <tmp>/<lang>/export.json`。机翻的条目审校，缺译的条目补译。
   zh-HK 这类派生语言：先审校和补译它的来源语言，再运行 `translate.js --lang <code>` 转换，最后单独审校。派生语言导出时不加 `--keys`，这样由旧译文转换出的条目也在范围内。
8. 提交源码和 catalog。提交说明写出新增几条文案、机翻几种语言、审校结果。

## 流程 2：加语言

输入：语言名称，例如「巴西葡萄牙语」。

1. 确定 Apple 语言代码。
   - 用 `bun -e 'console.log(new Intl.DisplayNames(["zh-Hans"], { type: "language" }).of("pt-BR"))'` 核对代码和名称是否对应。
   - 名称对应多个代码时，先问用户，不要自己选。例如「葡萄牙语」可以是 `pt-BR` 或 `pt-PT`，「中文繁体」可以是 `zh-Hant` 或 `zh-HK`，「西班牙语」可以是 `es` 或 `es-419`。
2. 确定翻译接口代码：运行 `bun -e 'console.log((await import("@3-/lang/CODE.js")).default.join(" "))'`（在 `scripts/i18n/` 中运行）。
   - 接口有这种语言时，记下代码。注意同一个接口代码只能对应 1 种 Apple 语言，例如接口只有 1 个 `pt`。
   - 接口没有这种语言、但能由已启用的语言转换时（例如 zh-HK 由 zh-Hant 转换），用 `derive`。
   - 两者都不行时，停止，并告诉用户原因。
3. 在 `i18n/languages.json` 中加入这种语言。
4. 准备术语表。amalthea 是 VM64 官网仓库，本机通常在 `~/dev/amalthea`，GitHub 上是 `xrun01/amalthea`。它的 `glossary/` 用 Google 风格的代码，例如 `zh-TW.yml` 对应 zh-Hant，`es.yml` 对应 es-419。有这种语言的文件时，复制过来。去掉 `ui-` 开头的术语，并在文件头注明来源 commit。没有时，在第 7 步由改稿代理新建。
5. 运行 `bun scripts/i18n/translate.js --lang <code>`。
6. 运行 `bun scripts/i18n/check.js --lang <code>`。
   结果：`0 个错误`。
7. 全量审校和补译：执行流程 3 的第 1 至 8 步，语言是 `<code>`，范围是 `--state needs_review,missing`。zh-HK 这类派生语言，先审校和补译它的来源语言，再运行 `translate.js --lang <code>` 转换，最后单独审校。
8. 运行 `bun vm/script/buildApp.js`，确认 `UTM.app/Contents/Resources/<code>.lproj/` 存在，再做流程 3 第 9 步的布局验收。fork 不维护 `UTM.xcodeproj`，所以不用改它的 `knownRegions`。
9. 提交 `i18n/languages.json`、术语表和 catalog。

## 流程 3：审校

输入：语言列表和范围，例如「审校日语和韩语新加的译文」。范围的默认值是 `needs_review` 的全部条目。用户说「全部」时，范围是 `--state all`。用户说「补译」或「缺译」时，范围是 `--state missing`。`--state` 可以写多个状态，用逗号分隔。

注意：范围包括 `translated` 时（用户说「全部」），审校会改动已审校的译文。开始前告诉用户这一点，并在报告中确认这些改动。

### 问题分类

改稿代理只修下面 5 类问题，不改风格偏好。缺译条目（导出状态是 `missing`）由改稿代理翻译，类别写「补译」。

| 类别 | 含义 | 例子 |
|---|---|---|
| 语义错误 | 意思和英文不同，或增删了信息 | 「A drive cannot be read only once a snapshot has been taken」被译成「拍快照后才能读取驱动器」 |
| 术语错误 | 不符合术语表，或同一术语有 2 种以上译法 | 「guest」译成「客户端」 |
| 漏译 | 残留英文或其他语言的词 | 德语译文中残留「Settings」 |
| 文字系统错误 | 必须保留的名称被音译，或用错文字、大小写、标点 | 阿拉伯语把 Linux 写成「لينكس」 |
| 不通顺 | 母语读者读不顺，或一眼能看出是机翻 | 逐词直译的长句 |

界面文案按这种语言的 macOS 界面习惯写。菜单和按钮的写法、敬语、是否用句号，都参照 Apple 在这种语言里的写法。

### 步骤

下文 `<tmp>` 是会话临时目录下的 `i18n-review/`，每种语言 1 个子目录 `<tmp>/<lang>/`。

1. **导出。** 导出 0 条的语言跳过后续步骤。每种语言运行 `bun scripts/i18n/review.js export --lang <lang> --out <tmp>/<lang>/export.json`，按范围加 `--state`、`--keys`、`--key`、`--limit`。
   `export.json` 必须留在 `proposal.json` 旁边。第 6 步按它核对导出后有没有变化。
2. **改稿。** 每种语言启动 1 个改稿代理，最多 3 个并行。说明按 `reviser.md`，填入 4 个参数：语言、仓库根目录、输入路径、输出路径。
   结果：`<tmp>/<lang>/proposal.json`，以及更新后的 `i18n/glossary/<lang>.yml`。
3. **主代理复核。** 读 `proposal.json` 的全部改动和 `doubts`。
   - 你能判断的语言（至少 zh-Hans），逐条看新译。
   - `doubts` 中能按术语表规则判断的，直接定：把这一条从 `doubts` 移到 `changes` 或 `approved`。要改多条时，把意见发回原改稿代理。
   - 跨语言都会出现的新术语，补进 `terms.yml`。
4. **回译。** 运行 `bun scripts/i18n/review.js back-input --proposal <tmp>/<lang>/proposal.json --out <tmp>/<lang>/back-input.json`。每种语言启动 1 个新的回译代理，说明按 `back-translator.md`。回译代理只能看 `back-input.json`。
   结果：`<tmp>/<lang>/back.json`。回译覆盖改动和确认的全部条目，因为机翻条目即使没改也要验证。
   不透明编号由条目和译文算出。`back-input` 只输出还没有当前译文回译的条目，所以改过的条目会自动重新回译。
5. **比对。** 运行 `bun scripts/i18n/review.js compare-input --dir <tmp> --langs <lang,lang> --out <tmp>/compare-input.json`。它合并英文和当前译文的回译。提示「缺少当前译文的回译」时，先回到第 4 步。
   - 条目超过 100 条时，启动比对代理，说明按 `comparator.md`。不超过 100 条时，你自己逐条比较英文、回译和 `note`。
   - 结果都按 `comparator.md` 的格式写到 `<tmp>/compare.json`，没有问题时写 `[]`。第 8 步的报告读它。
   - 意思一致：通过。
   - 意思不一致，或 `note` 指出真实的歧义：退回改稿代理。改稿代理改了译文后，再执行第 4 步：`back-input` 的输出写 `<tmp>/<lang>/back2-input.json`，回译代理的结果写 `back2.json`。第 N 轮写 `backN.json`。然后重新执行本步，覆盖 `compare.json`。
   - 改稿代理坚持原译文、但你想换 1 个回译代理复核时，`back-input` 加 `--ids-file <文件>`，强制输出这些条目。文件是条目 id 的 JSON 数组，比对代理的输出可以直接用。
   - 最多退回 2 轮。2 轮后仍有分歧的条目，从 `changes` 和 `approved` 中移到 `withdrawn`，写明原因：`{ "id": "…", "reason": "…" }`。这些条目保持原状态，报告中单独列出。
6. **写入。** 先运行 `bun scripts/i18n/review.js apply --lang <lang> --proposal <tmp>/<lang>/proposal.json --dry-run`，通过后去掉 `--dry-run` 再运行 1 次。
   - 脚本只写导出过的条目，并逐条核对导出后译文、状态、英文都没变。所以它不会覆盖导出后别人确认或改过的译文。核对不通过时，重新导出这些条目再审。
   - 导出的每个条目都必须出现在 `changes`、`approved`、`doubts`、`withdrawn` 中的 1 处，否则拒绝写入。
   - 新译文按 `check.js` 的规则校验。任何 1 条不合格时，不写入任何条目。
   - 写入后，改动和确认的条目状态都变成 `translated`。已经写入的条目再运行时跳过，所以补上漏掉的条目后可以重新运行。
   - 已经写入的条目要再改时，把这些条目的「表名|键」写成 JSON 数组文件，用 `export --state translated --keys <文件>` 导出到新目录，再走一遍审校。不要用 `--key`：键里的括号、加号会被当成正则。不要覆盖原来的 `export.json`，否则原 proposal 的其他条目会被拒绝。
   - 补译复数时只补了部分类别，脚本会警告。缺的类别运行时退回 `other`。
7. **检查。** 运行 `bun scripts/i18n/check.js`。
   结果：`0 个错误`。
8. **报告。** 运行 `bun scripts/i18n/review.js report --dir <tmp> --langs <lang,lang> --out <tmp>/report.html`。报告先列待决定的事项，再逐条列改动，可以按语言筛选和搜索。摘要表的「缺回译」不为 0 时，说明有条目跳过了回译，回到第 4 步。用户不懂这种语言时，靠报告判断改得对不对。
9. **布局验收。** 文案变长会撑破固定宽度的界面。
   1. 运行 `bun vm/script/buildApp.js`。
   2. 用 `open -n build/UTM.app --args -AppleLanguages "(<lang>)"` 启动 app。打开新建虚拟机向导和设置窗口。
   3. 用 `screencapture -l <窗口 ID> <文件>` 截图，检查文字是否被截断、是否重叠。窗口 ID 用 CoreGraphics 取：写 1 个 Swift 脚本，调用 `CGWindowListCopyWindowInfo`，按 UTM 的进程号筛选 `kCGWindowNumber`。
   4. 再用 `-NSDoubleLocalizedStrings YES` 启动 1 次，检查文案加倍后的布局。ar 另外检查从右到左的布局。
   注意：截图要求「屏幕录制」权限。没有权限时，请用户授权或人工检查，不要跳过这一步。
10. **提交。** 提交说明按语言列出改动类别和条数，例如 `de：术语错误 4 条、不通顺 3 条`。

### 约束

- 不改英文。英文的问题写进 `proposal.json` 的 `source_issues`，交给用户决定。改英文会让所有语言的译文失效。
- 占位符的数量、类型和位置必须和英文一致。`%@` 可以改成带序号的 `%1$@` 以调整语序。
- 专有名词原样保留，清单见 `scripts/i18n/lib/terms.js` 和术语表中 rule 为 `keep` 的术语。
- zh-HK 由 zh-Hant 转换而来，但它是独立的语言，单独审校。审校 zh-Hant 改动的译文不会自动同步到 zh-HK。
- 英文改过的键，旧译文在 `i18n/removed.json` 中。改稿时可以参考它保持术语和风格一致。但是不要照抄，因为英文的意思可能变了。

## 交付

交付说明列出：

- 每种语言的改动类别和条数，确认条数。
- 2 轮后仍有分歧、保持原状态的条目。
- `source_issues` 汇总，等用户决定是否改英文。
- 审校报告的路径。
