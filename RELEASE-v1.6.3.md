# Live2DPet v1.6.3 — 修复 OBS 抓不到桌宠的真正原因

> 如果你在 OBS 里抓桌宠只有一片黑 —— 这一版是真正的解药。
> v1.6.1 / v1.6.2 都还在围着「透明窗口」打转，方向都不对。

---

## 🎯 真正的原因：Chromium 绕过了 Windows GDI

OBS 读窗口内容，依赖的是 **Windows GDI** 那条路。
而 **Electron / Chromium 用自己的合成路径把这条路绕开了**，OBS 根本读不到内容 —— 只能给你一片黑。

这解释了之前所有现象：

| 现象 | 是否能用「透明窗口」解释 |
|------|--------------------------|
| 窗口采集是黑的 | ✅ 看起来能 |
| **游戏采集也是黑的** | ❌ 解释不了 |
| 采集方式选 Automatic / BitBlt / WGC 全黑 | ❌ 解释不了 |
| 换成不透明的抠像窗口就能抓到 | ❌ 解释不了 |

> OBS 开发者在 [electron/electron#16955](https://github.com/electron/electron/issues/16955) 下的原话：
> 「**nothing I can do about capturing browser-based applications due to that render
> technique they're all using which bypasses the windows GDI**」

同一个 issue 里给出了经过验证的解法：关掉 Chromium 的 **GPU 合成**。
其他 Electron 应用就是这么做的，它们管它叫 **streamer mode**。

---

## ✅ 修复：新增「OBS 兼容模式」

启动时加上：

```js
app.commandLine.appendSwitch('disable-gpu-compositing');
```

### 怎么开

1. **设置 → 集成 → OBS 兼容模式** → 勾选
2. 点 **保存**
3. 点 **立即重启**（命令行开关只能在进程启动时决定，所以必须重启）

### 怎么确认生效

启动日志里出现这一行就对了：

```
[OBS] compatibility mode ON — disable-gpu-compositing, disable-accelerated-video-decode, disable-accelerated-video-encode
```

设置界面里也会显示开关**当前是否真的生效**、以及是否需要重启 —— 不会出现「改了但没生效」的错觉。

> ⚠️ 代价：渲染性能会下降一些。**不直播时可以关掉**（同样需要重启）。

---

## 🔬 想先验证一下？不用改设置

带上参数启动即可，效果和兼容模式完全一样：

```bash
node launch.js --disable-gpu-compositing     # 从源码运行
Live2DPet.exe --disable-gpu-compositing      # 便携版
```

---

## 📺 重启后，在 OBS 里添加

1. **来源** → `+` → **窗口采集** → 窗口选 **`Desktop Pet`**（进程 `electron.exe`）
2. 若仍是黑屏 → 改用 **游戏采集**，模式「采集特定窗口」，窗口同样选 `Desktop Pet`，
   并勾选 **「允许透明度」**
3. 都不行 → **显示器采集**（桌宠以屏幕上样子出现，含透明效果）

采集的是**桌宠本体窗口**：

- ✅ 表情、动作、说话气泡全都在（不是复制渲染）
- ✅ 不遮挡屏幕、不需要绿幕、不需要任何额外窗口
- ✅ 桌宠正常启动即可被采集

---

## ✅ 验证

- 实测启动日志确认开关被正确追加，应用其余功能（TTS / 弹幕 / 桌宠）不受影响
- 新增 `tests/test-obs-mode.js`（**11 个**）：开关解析、只接受显式 `boolean true`、
  不泄漏共享数组、配置缺失/损坏时安全降级、打包版优先读 userData、
  以及开关确实被 append 到命令行
- **432 个测试全过**，全项目语法 0 失败

---

## 📦 下载

| 文件 | 大小 | 说明 |
|------|------|------|
| `Live2DPet-v1.6.3-portable.zip` | 99.6 MB | **推荐**。解压后得到 `Live2DPet.exe` + `使用说明.md` + `config.example.json` |
| `Live2DPet.exe` | 99.5 MB | 单文件便携版，双击即用 |

```
SHA256 (Live2DPet-v1.6.3-portable.zip)
8BB482A70AACE8A9B95D29920A9BF21D7569DE8E5D9B9D2DD7C52E1E705BE7E3
```

> ⚠️ 本版本**不内置任何 API Key**。首次运行请把 `config.example.json` 复制为 `config.json`
> 并填入自己的密钥，或直接在设置界面里填写。

---

## 🙏 致谢

- [electron/electron#16955](https://github.com/electron/electron/issues/16955) —— 定位根因与解法的关键线索，
  特别是 OBS 开发者与 mtgatracker 作者分享的 `disable-gpu-compositing` 做法
- [xfgryujk/blivedm](https://github.com/xfgryujk/blivedm) —— 直播弹幕客户端的设计参照
- 详见 [README.md 的致谢章节](./README.md#-致谢)
