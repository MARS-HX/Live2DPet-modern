# Live2DPet v1.6.4 — OBS 浏览器源（推荐方案）

> v1.6.0 ~ v1.6.3 一直在尝试「让 OBS 抓到桌宠窗口」。**这条路走不通** ——
> 桌宠窗口既是透明的（分层窗口），又由 Chromium 绕过 GDI 渲染，两件事叠加，
> 窗口采集和游戏采集都只能得到纯黑。
>
> **这一版换思路：不抓窗口了，让 OBS 自己渲染桌宠。**

---

## ✨ 用法（3 步）

1. 启动桌宠 → **设置 → 集成 → 在 OBS 里使用桌宠** → 点 **复制地址**
   （形如 `http://127.0.0.1:14511/obs`）
2. OBS：**来源** → `+` → **浏览器**
3. 粘贴到 **URL**，设置宽高（例如 `400 × 600`）→ 确定

**完成。** 桌宠出现，背景是**真透明**，不需要绿幕、不需要色度键。

状态栏显示 🟢、地址后面出现「1 个源已连接」，就说明 OBS 连上了。

| | 浏览器源 | 窗口 / 游戏采集 |
|---|---|---|
| 透明度 | ✅ 原生 | ❌ 纯黑 |
| 需要绿幕 | ✅ 不需要 | — |
| 桌面上多出东西 | ✅ 不会 | — |
| 依赖窗口采集 | ✅ 完全不依赖 | 是（且抓不到） |

---

## 🔁 与桌面桌宠同源，不会走样

服务器把一份 **IPC 垫片**（`src/renderer/obs-shim.js`）注入到 **`desktop-pet.html` 本体**，
垫片用 HTTP + WebSocket 实现同样的 `window.electronAPI`。因此：

- OBS 里跑的就是**桌宠本体页面**，不是另做的简化版
- 主进程把发给桌宠窗口的**所有事件**自动镜像过去
  （`play-expression` / `play-motion` / `talking-state-changed` / `set-canvas-y` …）
  —— 通过包装 `webContents.send` 实现，以后新增事件类型**不用改任何调用点**

---

## 🔒 安全

- 只绑定 **`127.0.0.1`**，局域网其他机器访问不到
- 异地 `Host` 头直接 **403**
- 只服务白名单目录（`/src` `/libs` `/assets` / `/model`），
  并有**路径穿越防护**（含 URL 编码穿越 `/..%2f` 之类）
- `/api/config` 与 WebSocket 的首包都经过**深度脱敏** ——
  **API Key / Cookie / SESSDATA 永远不会下发到浏览器源**

---

## 🐛 实测中发现并修复的两个 bug

1. **模型目录读错配置文件**
   dev 下本应读项目目录的 `config.json`，却读了 `userData` 里三个月前的旧配置，
   指向一个不存在的模型 → `/model/...` 全部 404、桌宠画不出来。
   已改为与主程序一致的优先级（打包版优先 userData）。

2. **垫片返回的模型基址必须是绝对 http URL**
   `model-adapter.js` 会把任何不以 `file://` / `http` 开头的路径改写成 `file:///...`
   （在桌面上是对的，在浏览器源里不可用），导致**所有表情文件加载失败**。
   已改为返回 `location.origin + '/model'`。

---

## ✅ 验证方式（不是"看起来应该行"）

用一个**真实的 Chromium**（与 OBS 同引擎）加载该地址并截图数像素：

```
page           : http://127.0.0.1:14843/obs
captured size  : 400x600
drawn pixels   : 62327 (26.0% of the frame)
coloured pixels: 17450
shim connected : yes
model loaded   : yes
console errors : (none)
```

截图里可以看到桌宠被完整绘制、**背景完全透明**。

---

## 🧪 测试

- 新增 `tests/test-obs-server.js`（**17 个**）：
  脱敏（含序列化后不残留密钥）、路径穿越与编码穿越防护、异地 Host 拒绝、
  `/obs` 注入垫片且**注入位置在正文之前**、静态资源与模型目录服务、
  WebSocket 广播到客户端、端口正确释放
- 全套 **449 个测试全过**，一致性检查通过（三语言各 357 项同步、无死文件、无断 require）

---

## 📦 下载

| 文件 | 大小 | 说明 |
|------|------|------|
| `Live2DPet-v1.6.4-portable.zip` | 99.5 MB | **推荐**。解压后得到 `Live2DPet.exe` + `使用说明.md` + `config.example.json` |
| `Live2DPet.exe` | 99.5 MB | 单文件便携版，双击即用 |

```
SHA256 (Live2DPet-v1.6.4-portable.zip)
9C808D749F4CA03B449D7C13B0D49F11E5EB487D416F299F8EE3C437CF5ED52C
```

> ⚠️ 本版本**不内置任何 API Key**。首次运行请把 `config.example.json` 复制为 `config.json`
> 并填入自己的密钥，或直接在设置界面里填写。

---

## 🙏 致谢

- [electron/electron#16955](https://github.com/electron/electron/issues/16955) ——
  说明了 Chromium 绕过 Windows GDI 这一根因
- [xfgryujk/blivedm](https://github.com/xfgryujk/blivedm) —— 直播弹幕客户端的设计参照
- 详见 [README.md 的致谢章节](./README.md#-致谢)
