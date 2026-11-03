# src/core/vision — 识屏流水线（移植自 dsh-see-now）

本目录**不是自研代码**，是从 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)
移植过来的。原作者 SAOS-3624，Apache License 2.0，版权声明见同目录
`LICENSE-dsh-see-now` 与 `NOTICE-dsh-see-now`。

## 它解决什么

想让 AI 陪你看屏幕，最直觉的做法是"定时截全屏喂过去"，两个死结：

| 做法 | 问题 |
|---|---|
| 每 2 秒截一张全屏 | 一分钟 30 张图，全是重复画面，token 直接烧穿 |
| 每隔 30 秒截一张 | 中间发生了什么全丢了，AI 只会说"看起来你在用电脑" |

dsh-see-now 换了个思路：**先判断这一帧值不值得看，再决定传不传。**

- 每帧先打一个 0–255 的"变化分"（HSV 三通道加权差，在 64×36 网格上算，约 0.2ms）
- 只有"画面突然换了一张"或"一直在动、攒够了量"才留下来
- 留下来的几帧**拼进同一张图**，一张图的固定成本摊到 4~8 帧上

结果：同样一段 30 秒的操作，别人烧 30 张图，这里常常只要 2~3 张。

## 模块一览

```
cuts.js      64×36 网格 + HSV 加权绝对差 → 0–255 变化分
tiers.js     出帧密度 → 格子档位（1..8 档，边长 1/k）
pack.js      DP 装箱：把不同大小的格子铺满画布，最大化占用率
scale.js     cover 方式把整幅帧缩进一格（box 平均，不变形）
sheet.js     拼图 + 5×7 点阵编号（零图像库）
png.js       纯 JS PNG 编码（zlib 直出，省掉 ffmpeg 进程启动的 ~95ms）
pipeline.js  唯一有状态的地方：帧 → 打分 → 切点/积分 → 留帧 → 档位 → 装箱 → 出图
capture.js   唯一 spawn ffmpeg 的地方：一根 rawvideo 管道
```

上层适配（**本项目新增，不属于上游**）：

- `src/core/screen-observer.js` — Electron 侧的会话管理（start / watch / peek / grace / pace）
- `src/main/vision-ipc.js` — IPC 通道
- `src/renderer/vision-client.js` — 渲染进程客户端，把 sheet 转成 OpenAI content 块

## 两条判据（核心，缺一不可）

**① 切点** —— 这一帧的分数跳得又高又孤立：

```
score ≥ cutAbs(12)                 绝对地板：变化够不够大
score > 2.5 × max(1, 前后帧)        尖峰：是不是"一下子"
距上一刀 ≥ 0.4 秒                   不应期
```

**② 积分** —— 分不高但一直有，攒够才录一帧：

```
need = 4分 × 12fps × 3秒 = 144     固定的绝对阈值，不跟着画面一起涨
每帧累加自己的分，累够就录、清零
```

为什么两个都要：**尖峰是相对的**，在低分区也会成立。实测缓慢缩放有帧 `s=13.6`、
前后邻居只有 1.1/1.3，尖峰判据完全放行 —— 没有绝对地板，它就会被切成一块块。
反过来只有地板也不行：一镜到底的视频每帧 4 分，永远不会"跳"。

## 移植时做的改动

| 项 | 上游 | 这里 |
|---|---|---|
| 模块格式 | ESM (`import/export`) | CommonJS（Electron 主进程直接 require） |
| 会话层 | DSH 插件 + 阻塞式工具调用 | `screen-observer.js`，`watch()` 返回 Promise |
| 悬浮窗 | Tk 悬浮窗 + 聊天插话 | **移除**（桌宠有自己的气泡与 ChatWindow） |
| ffmpeg 定位 | `~/.dsh/tools/ffmpeg/bin` | `resolveFfmpegPath()`：环境变量 → userData → 常见安装位置 → PATH |
| 硬闸 | `hungUp` / `endedSource` | 保留等价语义（`suppressed`），但由用户主动停止触发 |
| 出图消费 | 工具结果附带图片 | 转成 `data:image/png;base64` 塞进 `image_url` 块 |

算法参数**一个都没有改**，包括 `cutAbs=12`、`REF_SCORE=4`、`binCost=1000`、
`maxWaitSec=15` 这些经过实测标定的值。改动它们会让上游那两张标定表全部失效。

## 本机实测（Windows / gdigrab / 12fps → 800×450）

```
首帧       408ms
解码       11.5 fps（目标 12）
静止屏幕   变化分 mean 0.03 / max 0.12   → 8 秒只出 1 张（首帧）
硬切素材   6 段纯色每段 2 秒 → 抓到 5/5 个切点，分峰值 70.67
拼图验证   4 帧排成 2×2，四角颜色与素材逐像素一致
```

`ddagrab` 在本机返回 "Selected output not supported"（桌面复制 API 被挡住），
探针自动退到 `gdigrab` —— 这正是上游设计引擎探测的原因。

## 回归测试

`tests/test-vision.js` — 68 个测试，覆盖：

- 变化分的刻度（含"单通道变化上限是 85"这个容易估错的数）
- 环形色相、低饱和度降权
- 档位的 fps 归一化（12fps 与 30fps 在同样帧率下必须同档）
- 装箱的单箱不变量（多箱会画糊图且不报错，这是最危险的失效模式）
- PNG 行滤波字节、逐像素 round-trip
- 管线：静止不出图、硬切能抓、微小抖动不算切点、连续运动靠积分
- ffmpeg 参数（含 macOS 必须挂 `-r` 的那个坑）

真机冒烟：`npm run verify:vision`（需要 ffmpeg 与真实屏幕）。

## 已知限制（沿用上游）

- **只认"画面变了"，不认"语义变了"**。同一句话的两个排版版本算变化，
  两段内容不同但长得很像的页面可能算没变。
- **没有跨帧语义去重**（除了 `dupMin` 那道粗筛）。
- **Linux 还没接**（要补 `x11grab` 或 PipeWire，现在会直接报错，不假装能用）。
- **macOS 要多给一次权限**：系统设置 → 隐私与安全性 → 屏幕录制。
  没给的时候不会报错，只会全黑 —— 探针会算平均像素发现它并给出提示。
