---
name: chaoxing-helper
description: 学习通（超星）课程与作业助手。登录学习通、列出课程、扫描未交作业、导出作业题目（含公式 LaTeX）、按答案 JSON 批量勾选单选/多选/判断题、校验落盘并提交。当用户要求查看学习通作业、批量做选择题、导出题目或提交作业时使用。
metadata:
  version: 2.0.0
---

# 学习通作业助手

封装 2026 年后的学习通新版页面（mooc2-ans / mooc2），修复旧脚本只认旧接口的问题。

## 前置准备

```bash
cd <skill目录>
npm install
node scripts/chaoxing.cjs login
```

`login` 会弹出真实浏览器，由用户本人扫码或输密码；成功后把登录态写入技能根目录的 `.chaoxing-session.json`，后续命令全部复用。不要把账号密码作为命令行参数传递。

## 命令

所有命令输出 JSON，便于直接解析。

| 命令 | 作用 | 示例 |
|---|---|---|
| `login` | 打开浏览器手动登录并保存会话 | `node scripts/chaoxing.cjs login` |
| `courses` | 列出全部课程（含 courseid/clazzid/cpi） | `node scripts/chaoxing.cjs courses` |
| `scan` | 扫描未交作业；`--course` 限定课程，`--probe` 额外探测是否可作答 | `node scripts/chaoxing.cjs scan --probe` |
| `dump` | 导出某次作业的题目、选项、公式与当前选择 | `node scripts/chaoxing.cjs dump --work <URL> --out q.json` |
| `fill` | 按答案文件勾选；默认「暂时保存」并重载校验 | `node scripts/chaoxing.cjs fill --work <URL> --answers a.json` |
| `verify` | 只读核对已选中的题数 | `node scripts/chaoxing.cjs verify --work <URL>` |
| `submit` | 提交作业，必须显式 `--yes` | `node scripts/chaoxing.cjs submit --work <URL> --yes` |

答案文件格式，键为题目序号或 qid，值为选项的**显示字母**（多选题用数组）：

```json
{ "answers": { "1": ["C"], "11": ["A", "B", "C"], "12": ["A"] } }
```

`fill --dry` 只回显现有状态不写入；`fill --no-save` 勾选但不点「暂时保存」。

## 标准工作流

1. `login`（首次或会话过期时）
2. `scan --probe` 找出未交且可作答的作业
3. `dump --out q.json` 导出题目
4. 阅读 `q.json` 给出答案 JSON
5. `fill --answers a.json`，确认 `mismatches` 为空
6. 用户确认后 `submit --yes`

## 关键实现约束

改动脚本前先读这些，都是实测踩过的坑：

- 课程列表只能用 `POST mooc1-1.chaoxing.com/mooc-ans/visit/courselistdata`（表单 `courseType=1&courseFolderId=0&baseEducation=0&superstarClass=&courseFolderSize=0`），必须走 `context.request` 以绕过 CORS；旧的 `/visit/course/list` 已 404。
- 页面跳转统一用 `domcontentloaded`，`networkidle` 在学习通上经常永不满足而超时。
- 作业详情页 `/work/dowork` 才能作答；跳转到 `/work/preview` 表示**已过截止时间**，只能查看，要在结果里明确报错。
- 已提交的作业再访问 dowork 会显示「作答状态异常！」，此时改看课程作业列表状态。
- 题干与选项里的 `<img>` 公式，真实内容在 `data` 属性中，是 URL 编码的 LaTeX，必须 `decodeURIComponent` 后去掉首尾引号；只看 `innerText` 会得到空串。
- 选项顺序被打乱：`span` 的文本是**显示字母**，`data` 属性是**标准字母**，两者往往不一致。按显示字母定位点击，不要按标准字母。
- 单选题/判断题用 `.num_option` 与 `addChoice(el)`；多选题用 `.num_option_dx` 与 `addMultipleChoice(el)`，且多选题没有稳定的字母文本来源时按位置映射。
- 必须直接调用页面函数 `addChoice` / `addMultipleChoice`；Playwright 的 mouse click 可能被遮罩层拦截而不生效。重复调用会切换（把已选中的取消），所以先判 `check_answer` 类再点。
- 「暂时保存」调用 `saveWork()`，落库接口是 `addStudentWorkNewWeb`；提交是独立动作，`fill` 永远不会提交。
- 校验必须 `reload` 后读 `.num_option`/`.num_option_dx` 的 `check_answer` 类；`aria-checked` 在刷新后为 null，不能作为落盘依据。
- 登录态判定看 cookie 里的 `_uid` 或 `uf`，并确认 URL 已离开 `passport`。

## 安全边界

- 提交不可逆且计入成绩：只有用户明确要求时才执行 `submit`，并先声明哪些题是空的。
- `.chaoxing-session.json` 是登录凭证，不要提交到仓库、不要打进分发包；不再使用时可删除。
- 只操作用户本人的账号与课程。
