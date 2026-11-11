[![npm](https://img.shields.io/npm/v/dsh-tool-gpt-image.svg)](https://www.npmjs.com/package/dsh-tool-gpt-image)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# dsh-tool-gpt-image

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加两个真正可用的图像工具：
`image_generate`（文生图）和 `image_edit`（改图 / 局部重绘）。

它们调用 OpenAI 兼容的 `POST {baseURL}/images/generations`（JSON）和
`POST {baseURL}/images/edits`（multipart），把返回的 `b64_json`（或 `url`）解码后
**存入 DSH 的附件存储**——所以在 Web GUI 里会直接渲染成图片，不只是给一个路径；
同时把文件落到会话工作区，方便用户直接打开/拿走。

零 npm 依赖（只用 Node 内建模块），这样它能从一个只装了自身软链的 profile 里正常加载。

![preview](docs/preview.jpg)

> 上图由本插件生成：`image_generate({ prompt: "一只戴着宇航员头盔的橘猫，扁平插画风格，纯色背景" })`


## 装了什么

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明这是一个 DSH bundle（`dsh.bundle.patch`） |
| `cordis.patch.yml` | 往组合里插入 `tool-gpt-image` 这一行，带默认 config |
| `index.js` | 插件本体：注册 `image_generate` / `image_edit` 两个工具 |

## 配置

默认值写在 `cordis.patch.yml` 的 `insert.config` 里。要在**不改包**的情况下覆盖，
在 profile 的 `~/.dsh/profiles/<name>/cordis.patch.yml` 里加一段同 id 的 override：

```yaml
- id: tool-gpt-image
  config:
    baseURL: https://your-relay.example/v1
    apiKeyEnv: YOUR_RELAY_API_KEY
    defaultModel: gpt-image-1
    models: [gpt-image-2, gpt-image-2.5-flare]
    outputDir: images
    timeoutMs: 300000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.openai.com/v1` | 兼容 OpenAI 的 base URL，插件会拼 `/images/generations` |
| `apiKeyEnv` | `OPENAI_API_KEY` | 先查 `ctx.credentials.resolve()`，再查进程环境变量 |
| `defaultModel` | `gpt-image-1` | 文生图默认模型 |
| `defaultEditModel` | 同 `defaultModel` | 改图默认模型（有些中转站的 edits 走另一个模型） |
| `models` | `[defaultModel]` | 写进工具描述里，让模型知道有哪些可选 |
| `outputDir` | `images` | 相对工作区的默认落盘目录 |
| `timeoutMs` | `300000` | 单次生成超时；生图慢，别设太小 |

API key 用 DSH 的凭据存储最省事——在模型页填一次，或者直接写 `~/.dsh/.credentials.yaml` 的 `refs`；
轮换 key 不需要改配置、不需要重启。

## 换一套环境接入

插件不认识任何 provider id，只认 `baseURL` / `apiKeyEnv` / `defaultModel`。三步：

```bash
# 1. 装
plugin_manager install_bundle  link:/abs/path/to/dsh-tool-gpt-image
```

```yaml
# 2. 在你自己 profile 的 cordis.patch.yml 里覆盖（别改 bundle 里的默认值）
- id: tool-gpt-image
  config:
    baseURL: https://your-relay.example/v1
    apiKeyEnv: YOUR_RELAY_API_KEY      # 名字随你，合法标识符即可
    defaultModel: gpt-image-1
```

```bash
# 3. 存 key：模型页填，或直接写
# ~/.dsh/.credentials.yaml
refs:
  YOUR_RELAY_API_KEY: sk-xxxx
```

如果这台机器上已经有 pi-ai provider，想让**密钥跟着 provider 走**，把 `apiKeyEnv`
写成和该 provider 相同的名字即可 —— 两边指向同一条凭据记录，换 key 不用重启。

**不支持的协议**：Azure OpenAI（`/openai/deployments/<id>/images/generations?api-version=`）、
ComfyUI、sd-webui 等非 OpenAI 形状的端点需要改请求拼装。

## 用法

### `image_generate` — 文生图

模型侧：

```json
{
  "prompt": "一只戴着宇航员头盔的橘猫，扁平插画风格",
  "size": "1024x1024",
  "n": 1,
  "quality": "high",
  "output_format": "png",
  "save_to": "images/cat.png"
}
```

返回值：

```json
{
  "model": "gpt-image-2",
  "prompt": "…",
  "images": [
    { "path": "/abs/workspace/images/cat.png",
      "image": { "attachmentId": "…", "mediaType": "image/png", "bytes": 123456, "width": 1024, "height": 1024 } }
  ]
}
```

`render()` 会把 `images[]` 里的每个附件转成 `{ type: 'image' }` 内容块，所以图会直接出现在对话里。

### `image_edit` — 改图 / 局部重绘

```json
{
  "prompt": "把背景改成夜晚的霓虹城市，主体保持不变",
  "image": "images/cat.png",
  "mask": "images/cat-mask.png",
  "size": "1024x1024"
}
```

- `image` 必填：PNG / JPEG / WebP，绝对路径或相对工作区的路径
- `mask` 可选：与 `image` 同尺寸的 PNG，**全透明像素 = 要重绘的区域**，不透明 = 保留
- 其余参数与 `image_generate` 相同；不写 `save_to` 时落到 `images/edited-<时间戳>-<序号>.<ext>`

不带 mask 就是整体重绘（换风格、改光线、加元素）；带 mask 才是 inpainting。

## 安装 / 更新 / 卸载

已发布到 npm，别人直接装就行：

```bash
# 从 npm 安装（推荐给使用者）
plugin_manager install_bundle  dsh-tool-gpt-image@0.2.0

# 本地开发：软链自己的源码，改完 toggle 插件条目生效
plugin_manager install_bundle  link:/abs/path/to/dsh-tool-gpt-image
```

改完代码后：**linked 包的源码改动不会被 HMR 自动重新 import**（HMR 只盯 profile 的
`cordis.patch.yml` 之类配置）。两条路，任选其一：

```bash
# A. 在 Plugins 页把这一项关掉再打开（等价于下面两条 plugin_manager 调用）
#    或者让 agent 执行：
#    plugin_manager set_plugin include:tool-gpt-image enabled:false
#    plugin_manager set_plugin include:tool-gpt-image enabled:true
```

```bash
# B. 重启 DSH
```

卸载：`plugin_manager` 里把该 bundle 关掉或移除即可。

## 已知限制

- 只支持 OpenAI 风格的 `/images/generations` 与 `/images/edits`（`b64_json` 或 `url`）。
  Azure 的 `/openai/deployments/...` 形状、ComfyUI、sd-webui 需要改请求拼装。
- 改图一次只送一张输入图（OpenAI 支持多图参考，这里没暴露）；不支持 outpainting 专用的画布扩展参数。
- 蒙版不做尺寸/格式校验，靠服务端拒绝。
- **`size` 是建议值不是保证**：实测 `gpt-image-2` 在 edits 上按源图分辨率输出
  （要 1024×1024、给 1254×1254 源图，回来还是 1254×1254）。要精确尺寸就在返回后自己缩放。
- `n > 1` 且同时给了 `save_to` 时，文件名自动加 `-1`、`-2` 后缀。
- 工具在调用它的那条模型路由不具备图像输入能力时仍能执行，但模型本身看不到图（GUI 里能看到）。
