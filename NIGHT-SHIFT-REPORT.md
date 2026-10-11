# 夜间工作交接 · 2026-10-10 23:17 → 2026-10-11 03:21

> 你把这台机器交给我四个小时，并让我在结束时关机。这是这段时间里我做的事、怎么验证的、
> 以及我**故意没做**的事。所有改动都在一个独立分支上，`main` 一个字都没动。

- **分支**：`auto/night-shift-20261010`
- **规模**：14 个提交（13 个代码/测试修复 + 1 个本报告），49 个文件，`+3242 / −439`
- **测试**：539 → **623**，全绿（新增 10 个测试文件）

---

## ⚠️ 请先看这段：一次数据事故与恢复

**发生了什么**：我在核对一个测试时误用了 `git stash pop`，而没有先看 `git stash list`。
弹出来的不是我的改动，而是**你自己在 `main` 上留的那个 stash**（`WIP: tts-service`）。
它的内容与我的分支冲突，产生冲突标记（`main.js` / `preload.js` / `src/core/tts-service.js` /
`src/main/tts-ipc.js` / `src/renderer/settings-ui.js`），并且 **`config.json`（你本机正在用的
那份，7413 字节）被覆盖成了 stash 里那份更旧的配置**。
（这个错误我犯了两次：第二次 `git stash push` 时已经无改动可存，随后的 `pop` 又弹出了你的 stash。）
现在我已改用「另存文件 + `git show` 覆盖 + 还原」的方式核对旧实现，**完全不再触碰 stash**。

**你的 stash 没有丢**：`git stash list` 里仍是 `stash@{0}: On main: WIP: tts-service`，
内容一个字节都没少，你随时可以自己 pop 回来看。

**config.json 已尽可能恢复**。原本那份已被覆盖，磁盘上找不回；我按下面两处重建：

1. **骨架**用应用自己的 `getDefaultConfig()`（保证 17 个顶层键、结构完整合法）；
2. **实际取值**用我在本会话 23:44 从**正在运行的应用**（OBS 浏览器源的 `/api/config`）
   实测到的你最新状态——模型、角色、obs / bilibili / dsh / companion / tts / stt、
   16 个启用情绪、16 个表情、`chatGap:90`、`modelName:mimo-v2.6-flash`、`canvasYRatio:0.9` 等；
3. **密钥类字段**（`apiKey` / `tts.mimo.apiKey` / `stt.apiKey`）从你那份旧配置里取回——
   同一台机器、同一用户派生的密钥，实测**可以正常解密**（`sk-c7jsq…`，51 字符）。

**验证**：用应用自己的 `loadConfigFile()` 读取 → 无任何缺失段落；再真实启动一次，日志显示
`AIChatClient: …/v1 **mimo-v2.6-flash**`、`Character loaded: **白枢**`、
`Game companion: off`、`Live companion: on | mode: all`、`[Bili] room 31845149`、OBS 源就绪
—— 与你出事前的运行状态一致；停止后 `config.json` 哈希与启动前完全相同（未被改写）。

**你必须知道的两点**：
- 我无法知道你**最新那份**密钥字段的真实取值（`/api/config` 会把它们脱敏成空串），
  所以 `apiKey` 等取的是你旧配置里的值。**如果它们其实已经换过，请在设置里重新填一次。**
- 旧配置那份我另存为 `config.stale-from-stash.json`（仓库根目录，未提交），
  用它对照过就可以删掉。`config.json` 本身被 `.gitignore` 忽略，不会被提交。

---

## 一、安全问题：最高危的三条

### 1. 一次提示注入 = 本机任意命令（已修）

`pet-chat-window.html` 的「冒险日记」弹窗把**模型返回的文本**用字符串拼进 `innerHTML`：

```js
box.innerHTML = '<h3>…</h3><div>…' + diary.replace(/\n/g, '<br>') + '…'
```

两个条件叠在一起就致命：

- 那扇窗是 `webSecurity: false`（因为酒馆预设要靠 `fetch` 读 `file://` 的 `presets/*.json`）；
- `preload.js` 向渲染层暴露了 **`dshRun(task)`**，也就是「让主进程跑一次 dsh 任务」。

于是链路是：**弹幕/对话 → 模型输出被注入 → 渲染层执行脚本 → 调用 `dshRun` → 本机任意代码**。

**修法**：新增 `appendPlainText()`，用 `createElement` + `textContent` 构造 DOM，换行转 `<br>`。
**验证**：把 `appendPlainText` 从 HTML 里抽出来用 DOM 桩真跑一遍 —— 注入载荷落成文本节点而不是元素。

### 2. OBS 浏览器源：一个请求就能让主进程崩掉（已修）

`resolveWithin()` 在 HTTP 请求路径上调用 `decodeURIComponent`，而它对畸形转义会**抛 `URIError`**。
该函数直接就是 `http.createServer` 的监听器，异常 = 主进程未捕获异常。

**在线实测**（趁应用真跑着，用原始 TCP 发请求）：

| 请求 | 结果 |
|---|---|
| `/obs`、`/api/config` | 200 |
| `/src/%`、`/src/%zz` | **403**（修复前会崩） |
| `/libs/../../package.json` | 403 |
| 外来 `Host` 头 | 403 |
| 打完之后主进程 | **6 个进程一个不少**，仍正常服务 200 |

修复前触发者只需本机任意进程，或者你访问的网页里一个 `<img src="http://127.0.0.1:端口/src/%">`。
另外给整个路由加了一层兜底：意外异常记日志 + 500，不外泄细节、不掀翻进程。

### 3. 一个坏密文会毁掉整份配置（已修）

`config.json` 从别的机器拷过来、或改过 Windows 主机名/用户名（解密密钥由这两者派生）时，
`decrypt` 会抛错 → `loadConfigFile` 的 catch 把它吞成 `getDefaultConfig()` →
**随后任何一次保存都以这份空配置为基础写盘**。

**实测对比**（旧实现 / 新实现）：

| 场景 | 旧 | 新 |
|---|---|---|
| `loadConfigFile()` 后 `modelName` | 掉回默认值 | `my-model` ✅ |
| `loadConfigFile()` 后 `characters` | `undefined`（全丢） | `[{id:'c1'}]` ✅ |
| 再写一小块之后磁盘上的 `characters` | **真的没了** | 保留 ✅ |

现在改为逐字段兜底：解不开就保留密文（对**原机器**仍可恢复）并 warn，其余字段照常。
配套让 `encryptFields` 跳过已是密文的值，避免再包一层把原密文彻底埋掉。

---

## 二、其余已修缺陷

每条都先用**修复前**的代码复现过，再修，并留了能在旧实现上失败的回归用例。

| # | 症状 | 根因 | 验证方式 |
|---|---|---|---|
| 4 | 点了「停止」，弹幕还在推到渲染层 | `stop()` 无法中止「正在连接中」的会话；`_handleFrame` 不检查 `_stopping` | 实测旧：停止后仍建 1 条连接、注入帧仍派发；新：0 |
| 5 | 重复 `start()` 漏一条连接，同一条弹幕处理两遍 | 幂等判据依赖 `_connected`，而它要等鉴权回复才为真 | 实测旧：并发 start 建 2 条 socket；新：1 |
| 6 | 检测间隔清空后，桌宠 ~4ms 热循环打 IPC | `Math.max(10000, NaN)` 仍是 `NaN` | 新增用例覆盖 NaN/''/undefined/Infinity |
| 7 | 宠物说话时停止 → 播放 Promise 永久挂起，协程泄漏 | 出口只有 `ended`/`error`，而 `pause()` 不触发 `ended` | 用 race 兜底，旧实现判定失败 |
| 8 | 离线语音失败后**每秒**重建原生识别会话 | 白名单只覆盖两个「没装」，漏了 `microphone_denied` | 用永久失败集合统一判定 |
| 9 | 并发 `start()` 开**两支麦克风**，且第一支永不被释放 | 防重入用的 `_active` 要到函数末尾才置位 | stash 源文件复验：旧失败、新通过 |
| 10 | 每次「保存模型配置」泄漏一个常驻监听器 | `ipcRenderer.on` 无退订，`destroy()` 也不解绑 | preload 改返回退订函数 + 复验 |
| 11 | 默认音频被清空且不可恢复 | 「先删目录再逐条合成」，后端挂了就什么都没了 | 8 条新用例，含并发与 styleId 恢复 |
| 12 | 「音频设备管理」整段被复制 4 份，3 份错关进预设回调 | 花括号深度 2/3/2，而不是 0 | 深度扫描：旧 4 处声明（2/3/2/0），新 1 处（0） |
| 13 | 模型素材名可闭合 HTML 属性注入 | `value="${f.emotionName}"` 等 12 处未转义 | 新增转义护栏，旧文件判定失败 |
| 14 | 关键帧选择选到**错的帧**，且丢弃新帧 | `await` 期间用旧下标回查已变动的数组 | 实测旧选中 `"second"`、新选中 `"first"` |
| 15 | 历史到 300 条后阶段总结永久停摆 | 裁剪时的索引修正是恒等式（`slice` 之后才算） | 旧实现在上限后就再不触发 |
| 16 | 记忆归档整体偏移一天（东八区凌晨 0–8 点） | 用 `toISOString()` 当「今天」，即 UTC 日 | `localDayKey()` + 用例 |
| 17 | `asr-install` 永久返回陈旧快照，重装无效 | async IIFE 无 await 时，内部 `finally` 在赋值前跑完 | 独立验证该时序：旧留下 STALE PROMISE |
| 18 | 弹幕状态终态被丢弃，界面一直显示「已连接」 | 纯领先沿节流，无补发 | 3 条用例覆盖补发与 stop 清理 |
| 19 | `flush()` 在途期间的写入被标记成「已保存」而丢失 | `await` 之后才清 `_dirty` | 2 条用例 |
| 20 | 并发写配置互相覆盖 | 读-改-写跨越多个 await，无串行化 | 并发用例：旧丢字段、新都保留 |
| 21 | 无效加密字段导致整份配置重置（同 #3 的读写侧） | `obs.browserSource` 浅合并 | 双向用例 |
| 22 | OBS 启停竞态：Promise 永不 settle，此后再也起不来 | `close()` 无法结算在途的 `start()` | 实测旧 `STILL PENDING`、新正常结算 |
| 23 | 测试套件每跑一次往 `%TEMP%` 丢约 30 个目录 | 6 个测试文件建了临时目录却从不清理 | 前后计数：1242 → 1242，新增 0 |

其余较小但确凿的：`suggestParamMapping` 遇到没有 `Id` 的 CDI 参数抛 `TypeError`（会让整次模型导入失败）、
`initModel()` 浮空 Promise、`desktop-pet.html` catch 内二次 await 可能再抛、
`obs-shim` 重连无互斥（同页可叠出多条 WebSocket）、测试 TTS 的 blob URL 从不回收、
`renderer-log` 的 `level` 未白名单（`console['__proto__']` 会让主进程抛异常）、
`stt-windows` 的临时 `.ps1` 失败路径不删、双反斜杠换行字面量 3 处、
`character-manager` 初始化浮空 Promise、离线语音测试的兜底定时器不回收。

---

## 三、我核实后判定为**误报**的（没有照单全收）

第三方巡检报了几条，我逐条核实后**没有**动手：

- **「音频输入/输出下拉框元素不存在」** —— 错。`index.html:254/256` 明明有
  `audio-input-device` / `audio-output-device`。真正的问题是 #12 那个层级错位，
  而下拉框其实一直有被填充（顶层那份是好的）。按误报去「修」反而会改坏。
- **`vlm-extractor`「同一条弹幕处理两遍」之外的放大程度**、**CDI 缺 Id 的真实样例** —— 标注不确定，
  我按代码证据修了能证实的部分，没有假装证实推断部分。
- **`asr-model.downloadFile` 并发争抢 `.part`** —— 唯一调用方已被 `installing` 串行化，**不可达**，未改。

---

## 四、我**故意没改**的（附理由）

1. **`webSecurity: false`（聊天窗）** —— 它存在是因为酒馆预设用 `fetch('presets/x.json')` 读本地文件；
   `file://` 页面下没有它就会读失败。关掉它会连带弄坏预设功能，而那是另一条独立问题。
   我选择掐死注入点（#1）而不是动这个开关。**这条值得你后面单独决策**。
2. **解不开密的字段在 UI 里会显示成一串 `enc:v1:…`** —— 这是我在「保护密文」和「界面干净」之间的取舍：
   保留密文 → 拷回原机器还能用；清空 → 下次保存就把密文彻底删了。我选了不毁数据，代价是 UI 里那串东西难看。
3. **`KnowledgeStore` / `LongTermPool.flush` / `ConversationStore` 的几处缺陷** —— 它们当前是**未接线**的
   （`new KnowledgeStore(...)` 在 `enhancement-orchestrator.js:21` 被注释掉；`window.__chatStore` 全仓无赋值点）。
   我只修了确定生效路径上的问题，没有去改死代码。
4. **`launch.js` 在 Windows 上 Ctrl+C 会得到 exit code 1** —— 观感问题，不影响功能，未改。

---

## 五、环境处置（请核对）

- ✅ **`main` 一个字没动**，全部改动在 `auto/night-shift-20261010`
- ✅ **你自己的运行数据没被我提交**：`assets/prompts/b72f84ec-….json` 仍是「未提交改动」原样
  （内容我看了，是「白枢」角色卡的提示词微调：把「动作前置」改成「不要写动作描写，避免被语音读出来」。
  只读未改、也未提交）。
  （过程说明：我中途误用了一次 `git add -A` 把它带进了提交，随后用
  `git restore --source=HEAD~1 --staged` + `--amend` 摘了出来并核对过文件清单。）
- ✅ **真机冒烟测试**：启动过应用约 18 秒，日志干净（TTS/AI/角色/增强/OBS 全部就绪，
  浏览器源在 `127.0.0.1:13711`），随后**主动停掉**（因为配置里 `bilibili.enabled: true`，
  我不想让它在后台连直播间花你的 API 额度）。停止后 `config.json` 哈希**与启动前完全一致**。
- ✅ **清理**：删除了 1242 个历史遗留的测试临时目录（1.59 MB，全部逐个校验过绝对路径在 `%TEMP%` 下才删），
  并修掉了产生它们的源头。
- ⏰ **关机**：已用 `shutdown /s /t 14400` 排程，计划 **2026-10-11 03:21:24** 关机。
  收尾时复核过一遍：再下发排程返回 1190「A system shutdown has already been scheduled」，
  说明原排程仍生效。如果你不想关，随时 `shutdown /a` 撤销。
- ✅ 收尾核查：无残留 electron 进程、无后台任务、`%TEMP%` 里没有我留下的探针文件、
  工作区除你自己的运行数据外干净。

---

## 六、第二轮：对抗性自审 + 测试质量审计

我不满足于「测试全绿」，于是让一只小鲸**审查我自己这两千多行改动**，另一只专门审**测试套件本身**。
两份都抓到了真东西（都指向我的疏漏）：

### 第二轮修掉的生产代码缺陷

| 症状 | 根因 | 验证 |
|---|---|---|
| **第二条气泡回复永不出现**，且每次泄漏一个渲染进程 | `win.close()` 是异步的；旧气泡迟到的 `closed` 会把已经换成新气泡的**共享槽**抹成 null，新气泡再也拿不到唯一的显示路径 | 3 条新用例，旧实现 2/3 失败 |
| **OBS 浏览器源收不到任何宠物事件**（镜像整体失效） | `if (!win \|\| win.isDestroyed \|\| …)` —— 第一个 `isDestroyed` 是**方法引用**（恒真），函数永远在第一行返回 | 端到端用例：真连一个 ws 客户端，断言能收到 play-expression |
| 语音「装了但起不来」时仍是 **1 秒一次**重启风暴 | 失败原因白名单只列了已知常量，而原生加载失败是以 `e.message` 原文回传的 | 改为计数：连续三次即停手；成功清零 |
| **麦克风永久开着**（stop 打不断在途的 start） | 同实例的 `_startPromise` 挡不住「每次点击都 new 一个 capture」的真实路径 | 4 条新用例，旧实现失败 |
| 默认音频生成的并发闸门**被它要挡下的那次调用清掉** | 守卫写在 `try` 内，被拒绝的那次也跑 `finally` | 三次调用用例（旧实现会挂死，已用 race 兜住） |
| TTS 诊断把配置里的值拼进 `innerHTML`（与日记弹窗同类） | 未转义 | 已加进 RISKY 名单并转义 |

### 第二轮修掉的"假测试"

这些是更隐蔽的问题：**测试全绿，但证明不了任何事**。

- **我自己的转义护栏形同虚设**：判据只看 `${` 前一个字符是不是 `=` 或 `>`，
  于是 `value="${x}"` 这类**属性值位置被整个跳过** —— 把已转义改回未转义，护栏照样绿。
  已重写判据、抽成可单独测试的检测器，并加**正向对照**（构造样例必须被检出、正常写法不得误报）。
  实测：故意回退一处立刻报 `settings-ui.js:625`。另补「拼接式注入」这一路。
- **两个 describe 测的是抄进测试文件的实现副本**（`ConfigSchema` / `ParamFuzzyMapping`，10 个用例）。
  副本的 `getDefaultConfig` 只有 10 个键、真实的有 17 个；副本的 `suggestParamMapping` 还是修复前的版本。
  改为直接 require 真实模块后，故意改坏默认值会立刻报红（此前怎么改都是绿）。
- **一条回归用例被证伪**：`synthesize` 抛错会被逐句 catch 吞掉，旧实现末尾照样恢复 `styleId`，
  所以那条用例区分不出新旧实现。改用能逃出内层 catch 的失败。
- **两个用例会"挂死"而不是"失败"**：旧实现下会 await 一个永不释放的门。
  挂死比失败更糟——`node:test` 要等事件循环空下来才打印总结，整个套件会看起来卡住。
  已全部套上 `Promise.race`。
- 其余：`assert.ok(true)` 的恒真断言、只断言 `typeof` 的语言切换用例、
  恒真的键集断言、用例名与断言不符、桩件替换掉被测函数本身、整个文件没挂进 `npm test`、
  以及新测试又往 `%TEMP%` 丢目录（12 个 `l2d-winmgr-*`，已清理并补上 after）。

**顺带做了一次全量体检**：30 个测试文件逐个单独运行，确认**每一个都能正常退出**
（句柄泄漏导致的静默挂起是这次踩到的真实坑）。

---

## 七、怎么审阅 / 怎么回退

```bash
git log --oneline main..auto/night-shift-20261010   # 11 个提交，按主题分块
git diff main..auto/night-shift-20261010            # 全量改动
npm test                                            # 607 项，应当全绿

# 不合意就整支丢掉（main 没动过，随时可弃）
git checkout main
git branch -D auto/night-shift-20261010

# 只想挑一部分
git cherry-pick <commit>
```

每个提交的信息里都写了「症状 / 根因 / 怎么验证的」，可以直接当评审材料读。

## 八、遗留清单（我没做完 / 建议你决策）

1. **聊天窗的 `webSecurity: false`** —— 见 §四.1。注入点已掐死，但这个开关值得你单独决策。
2. **`tests/test-enhance.js` 里有 3 个 describe 被无条件 `skip`**（共 38 条用例从未注册）。
   它们测的是 v2.0 已停用的文本流水线；实测把 skip 去掉后 31 条直接失败
   （`EnhancementOrchestrator` 已不再构造 searchService / knowledgeStore / knowledgeAcq）。
   我没有删：它们属于「功能停用」而非「测试写错」，启用该功能时需要一并重写。
   但请注意 **runner 会报 `skipped 0`**，从报告上看不出它们存在。
3. **`preload.js` 里 20 个 `on*` 已统一返回退订函数**，但渲染层目前只有 ImageAdapter
   真的用了它。其它调用点仍在页面初始化时注册一次——现在不是泄漏，但热重载路径变多时会。
4. **`tests/test-renderer-structure.js` 的重复声明扫描只认行首 `function name(`**，
   `const f = () => {}` 或 `x = function(){}` 形式看不见。
5. **`config.stale-from-stash.json`** 是我为恢复而留的旧配置副本（未提交），对照完可删。
6. **`assets/prompts/b72f84ec-….json`** 是你自己的未提交改动，我没碰、也没提交。

---

## 附：后续新增 —— 让宠物说指定文案 + 说话口型同步 + OBS 同步

（这是之后单独提的需求，实现在同一个分支上。）

**怎么用**
- 设置窗 →「让宠物说」卡片：输入文字 →「说出来」；「停下」立刻闭嘴。
- 脚本 / DSH：`window.electronAPI.petSay('要说的文案', { audible: true, showBubble: true })`
  → `{ success, chars, bytes }`；失败时 `error ∈ empty_text | too_long | tts_unavailable | no_pet_window | synthesis_failed`。
- 单次上限 500 字（再长会把一大段音频塞进一次 IPC 广播）。

**口型是怎么算出来的**
1. 主进程沿用 `tts-synthesize` 那套分句 + WAV 拼接，合成整段音频后经 `pet-say` 发给宠物窗；
2. 宠物窗用 Web Audio 解码成 AudioBuffer 播放 —— 不用 `<audio>` + MediaElementSource，
   因为 data: URL 对 Web Audio 属于跨源，`createMediaElementSource` 会抛 SecurityError；
   每帧取时域 RMS；
3. `RMS → 0..1`，张开快、闭合慢地平滑，写进口型参数；
4. 口型参数**加载时自动识别**（通用命名 `ParamMouthOpenY` 等，并排除 `ParamMouthForm`），
   换模型不用改配置；模型没有该参数时打一行 warn 并静默跳过；
5. **自适应增益**：用当前这句话的音量做参考再归一化，所以小声的 TTS 也会把嘴张开 ——
   实测同一句文案，固定增益下峰值 0.43，自适应后 1.00。另外若 `AudioContext` 处于
   suspended（自动播放策略），会先 `resume()`，否则分析恒为 0、嘴一动不动。

**OBS 侧**
浏览器源收到的是同一条 `pet-say`（含音频；`audible: true` 时它自己也出声），跑的是同一套
lip-sync 代码 —— 屏幕上的宠物与 OBS 里的口型各自从同一份音频分析。AI 回复那种"音频在别的
窗口播"的情况，由播放方每帧 `setMouthLevel()` 上报，主进程转发给宠物窗并镜像给 OBS。

**实测（真实进程，不是单测）**
- `[Live2DAdapter] 口型参数: ParamMouthOpenY`
- `[PetSay] → 宠物窗（24 字，686140 字节 base64）`
- `[DesktopPet] 口型: 峰值 1.00，有效帧 810/1133`
- 冒充 OBS 浏览器源的 WebSocket 客户端收到：`pet-say` ×1、`mouth-level` ×4、
  `talking-state-changed` ×2、`chat-bubble-message` ×1

**顺手修掉的两个真 bug（都直接卡住"OBS 里看得到模型动作"）**
1. `installMirror` 把 `win.isDestroyed` 当值用（恒真）→ 镜像整体失效（见 §二）。
2. `browser-window-created` 是在 `new BrowserWindow()` **构造期间**同步发出的，而
   `ctx.petWindow` 要等构造返回才赋值 → 当场比对身份永远比不中，**OBS 源启动之后才创建的
   宠物窗 / 气泡窗一个都不会被镜像**。改为延后一拍比对；已加回归用例（旧代码下报"实际收到 []"）。

**已知限制**
- 这个模型（kailuo）的 `model3.json` **没有 Motions 段**，所以 `playMotion()` 是空转；
  目录里躺着一个没被引用的 `daiji.motion3.json`。要播它得把该文件接进 model3.json
  （或由程序在内存里注入 Motions 段）—— 这属于动你的模型文件，我没动，等你决定。
- `ParamMouthOpenY` 是音量驱动的开合，不是元音级口型。
