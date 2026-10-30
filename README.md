# chaoxing-helper

学习通（超星）课程与作业命令行工具，基于 Playwright。用于列出课程、扫描未交作业、导出作业题目（公式还原为 LaTeX）、按答案文件批量勾选单选/多选/判断题，并校验落盘。

适配 2026 年后的学习通新版页面（mooc2-ans / mooc2），旧版 `/visit/course/list` 等接口已失效。

## 特性

- 登录态复用：浏览器手动登录一次，之后所有命令共用 `storageState`
- 区分可作答与已截止：`/work/dowork` 可作答，`/work/preview` 表示已过截止时间
- 公式无损导出：题干与选项中的图片公式从 `data` 属性还原为 LaTeX
- 选项乱序安全：同时输出显示字母与标准字母，按显示字母定位点击
- 草稿可验证：勾选后自动「暂时保存」并重载核对，输出差异项
- 提交受控：`fill` 永不提交，`submit` 必须显式 `--yes`

## 环境要求

- Node.js >= 18
- Playwright 及浏览器内核（`dependencies` 已锁定 `1.49.1`）

## 安装

```bash
npm install
node scripts/chaoxing.cjs login
```

`login` 会打开真实浏览器窗口，由使用者本人扫码或输入账号密码完成登录。登录成功后写入技能根目录的 `.chaoxing-session.json`，后续命令自动复用。

若浏览器内核缺失，执行：

```bash
npx playwright install chromium
```

## 命令

所有命令输出 JSON，便于脚本与其他工具解析。

| 命令 | 说明 |
| --- | --- |
| `login` | 打开浏览器手动登录，保存会话 |
| `courses` | 列出全部课程（courseid / clazzid / cpi） |
| `scan` | 扫描未交作业；`--course <名称>` 限定课程，`--probe` 探测是否可作答 |
| `dump` | 导出某次作业的题目与选项；`--out <文件>` 落盘 |
| `fill` | 按答案文件勾选，默认保存并校验；`--dry` 只看不改，`--no-save` 不保存 |
| `verify` | 只读核对已选中题数 |
| `submit` | 提交作业，必须加 `--yes` |

### 示例

```bash
node scripts/chaoxing.cjs courses
node scripts/chaoxing.cjs scan --course 线性代数 --probe
node scripts/chaoxing.cjs dump --work "<作业URL>" --out questions.json
node scripts/chaoxing.cjs fill --work "<作业URL>" --answers answers.json
node scripts/chaoxing.cjs submit --work "<作业URL>" --yes
```

## 答案文件格式

键为题目序号或题目 qid，值为选项的显示字母；多选题给数组：

```json
{
  "answers": {
    "1": ["C"],
    "11": ["A", "B", "C"],
    "12": ["A"]
  }
}
```

## 工作流程

1. `login` 建立或刷新会话
2. `scan --probe` 找出未交且可作答的作业
3. `dump --out questions.json` 导出题目
4. 阅读题目，产出答案文件
5. `fill --answers answers.json`，确认输出中 `mismatches` 为空
6. 确认无误后 `submit --yes`

## 实现要点

修改脚本前需要了解的行为约束：

- 课程列表必须 `POST https://mooc1-1.chaoxing.com/mooc-ans/visit/courselistdata`，表单为 `courseType=1&courseFolderId=0&baseEducation=0&superstarClass=&courseFolderSize=0`；需走 `context.request` 以绕过 CORS
- 页面导航统一使用 `domcontentloaded`，`networkidle` 在学习通上常无法满足
- 已提交的作业再次访问作答页会显示「作答状态异常！」，此时以课程作业列表状态为准
- 单选/判断为 `.num_option` + `addChoice(el)`；多选为 `.num_option_dx` + `addMultipleChoice(el)`
- 必须直接调用页面函数，鼠标点击可能被遮罩层吞掉；重复调用会取消已选，需先判 `check_answer` 类
- 「暂时保存」触发 `saveWork()`，落库接口为 `addStudentWorkNewWeb`
- 校验须重载页面后读 `check_answer` 类，`aria-checked` 刷新后为 `null`

## 安全边界

- 提交不可逆且通常计入成绩，仅在明确要求时执行，并先确认是否有未作答题目
- `.chaoxing-session.json` 含登录凭证，不要提交到仓库或打进分发包；不再使用时可删除
- 仅用于操作本人的账号与课程

## 目录结构

```
.
├── SKILL.md               技能说明与 Agent 使用约定
├── package.json           playwright 依赖
├── README.md
└── scripts/
    └── chaoxing.cjs       命令行入口
```
