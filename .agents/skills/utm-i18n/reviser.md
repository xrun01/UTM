# 改稿代理说明

主代理把下面的说明发给改稿代理，填入 `{lang}`、`{root}`、`{in}`、`{out}` 这 4 个参数。

---

你审校 UTM 的 `{lang}` 译文。UTM 是 Mac 上的虚拟机 App，界面是 macOS 原生风格。仓库在 `{root}`。

## 先读

1. `.agents/skills/utm-i18n/SKILL.md` 的「流程 3：审校」：问题分类和约束。
2. `i18n/glossary/terms.yml`：术语定义和翻译规则。
3. `i18n/glossary/{lang}.yml`：这种语言定下的译法。文件不存在时，你在第 1 步新建它。
4. `{in}`：待审条目。格式是 `{ "lang": "…", "items": [{ "id", "en", "comment", "current", "state" }] }`。
   - `en` 是英文原文，`current` 是现在的译文。
   - `comment` 是开发者写的上下文，常常是调用这条文案的源文件名。上下文不够时，在仓库中搜索英文原文。
   - `state` 是 `needs_review` 时，译文通常是机翻。
5. `i18n/removed.json`：英文改过的键的旧译文。可以参考，但英文的意思可能变了。

## 不要做

- 不要修改 catalog（`Platform/**/*.xcstrings`）。你只输出改动建议，由主代理写入。
- 不要改英文。英文的问题写进 `source_issues`。
- 不要改风格偏好。只修 5 类问题：语义错误、术语错误、漏译、文字系统错误、不通顺。
- 不要运行 `translate.js`。

## 第 1 步：定术语

逐个检查 `terms.yml` 中 rule 不是 `keep` 的术语。`{lang}.yml` 中还没有的，为 `{lang}` 定 1 种译法，写进 `i18n/glossary/{lang}.yml`。

- rule 是 `apple` 时，按 Apple 在这种语言里的官方写法。查 `support.apple.com/<locale>` 核对。查不到时，写进 `doubts`。
- rule 是 `microsoft` 时，按这种语言的 Windows 界面写法，查 `support.microsoft.com/<locale>`。
- rule 是 `translate` 时，按 note 的意思，用这种语言软件界面的通行说法。
- 待审条目中出现 3 次以上、但术语表没有的界面术语，也定下译法，写进 `{lang}.yml`。例如 drive、display。在交付总结中列出这些术语，由主代理决定是否补进 `terms.yml`。

`{lang}.yml` 的格式：键是术语 id，值是 1 行译法。查过官方来源的，在行末用注释写出 URL。

## 第 2 步：逐条审校

逐条对照 `en` 和 `current`。每条只有 2 种结果：改，或确认。

- 新译必须忠于英文：不增加信息，不删除信息。
- 新译必须用第 1 步定下的术语译法。
- 占位符（`%@`、`%lld`、`%1$@`）的数量和类型必须和英文一致。调整语序时，改用带序号的写法，例如 `%2$@ … %1$@`。
- 英文中的数字必须保留，用阿拉伯数字。
- 首尾空白、换行数必须和英文一致。英文用「…」时，译文也用「…」。
- 菜单项、按钮、标题按这种语言的 macOS 界面习惯写，同类文案的写法必须一致。
- 界面空间有限。同样准确时，选短的写法。
- 句子必须只有 1 种读法。
- 你没有把握的改动，不要改，写进 `doubts`。

## 输出

把结果写成 JSON 文件 `{out}`。`id` 原样使用输入中的 `id`。`reason` 用简体中文写，1 至 2 句。

```json
{
  "lang": "{lang}",
  "changes": [
    { "id": "Localizable|Shared Folder|", "old": "…", "new": "…", "type": "术语错误", "reason": "…" }
  ],
  "approved": [
    { "id": "…", "value": "…" }
  ],
  "doubts": [
    { "id": "…", "current": "…", "question": "…" }
  ],
  "source_issues": [
    { "id": "…", "en": "…", "problem": "…", "suggest": "…" }
  ]
}
```

- `old` 必须和输入的 `current` 逐字相同。`approved` 的 `value` 也必须和 `current` 逐字相同。
- 每个输入条目只能出现在 `changes`、`approved`、`doubts` 中的 1 处。
- `type` 只能是以下 5 个值之一：语义错误、术语错误、漏译、文字系统错误、不通顺。

写完后，用 `bun -e` 读一次 `{out}`。确认 JSON 能解析，并且 3 个列表的条数之和等于输入条数。最后回复 1 段总结：各类别的条数，`approved`、`doubts`、`source_issues` 的条数，以及新定的术语。
