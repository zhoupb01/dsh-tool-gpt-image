[![npm](https://img.shields.io/npm/v/dsh-tool-gpt-image.svg)](https://www.npmjs.com/package/dsh-tool-gpt-image)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# dsh-tool-gpt-image

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加两个真正可用的图像工具：
`image_generate`（文生图）和 `image_edit`（改图 / 局部重绘）。

**装完就能用，不需要写任何配置。** 插件会读你已经在 **设置 → 模型** 里配好的供应商，
挑出带图像模型的那个，直接复用它的接口地址、密钥和模型。

它们调用 OpenAI 兼容的 `POST {baseURL}/images/generations`（JSON）和
`POST {baseURL}/images/edits`（multipart），把返回的 `b64_json`（或 `url`）解码后
**存入 DSH 的附件存储**——所以在 Web GUI 里会直接渲染成图片，不只是给一个路径；
同时把文件落到会话工作区，方便用户直接打开/拿走。

零 npm 依赖（只用 Node 内建模块），这样它能从一个只装了自身软链的 profile 里正常加载。

![preview](docs/preview.jpg)

> 上图由本插件生成：`image_generate({ prompt: "一只戴着宇航员头盔的橘猫，扁平插画风格，纯色背景" })`


## 它是怎么“零配置”的

插件加载时（以及组合尚未就绪时的第一次调用）做一次发现：

1. 问 `ctx.llm.listConfigurableProviders()` 要到所有供应商的配置地址，
   再经 `ctx.settings.describe()`（或 `ctx.configEditor` / `ctx.loader` 兜底）读出每个
   供应商的 `baseURL`、`api`、`apiKeyEnv`、`models`。
2. 只保留 `api` 是 `openai-completions` 或 `openai-responses`、且模型清单里命中
   图像模型白名单（`gpt-image*` / `dall-e*` / `imagen*` / `flux*` / `seedream*` / `qwen-image*`）的供应商。
3. 优先选**当前会话默认模型所属的供应商**，没有就按配置顺序取第一个能用的。
4. 密钥：先按供应商的 `apiKeyEnv` 解析，没写就按模型页的约定 `<供应商ID大写>_API_KEY`；
   先查 DSH 凭据库，再查进程环境变量。
5. 模型：优先 `gpt-image-2`，其次版本号最大的 `gpt-image-*`，再其次白名单里第一个。
6. 一个都用不了、但机器上有 `OPENAI_API_KEY` 时，回落到 `api.openai.com` + `gpt-image-1`。

发现结果缓存在插件实例里：改完供应商配置后，重载插件条目（或重启 DSH）即可重新发现。

## 装了什么

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明这是一个 DSH bundle（`dsh.bundle.patch`） |
| `cordis.patch.yml` | 往组合里插入 `tool-gpt-image` 这一行（只带 `outputDir` 默认值） |
| `index.js` | 插件本体：供应商发现 + `image_generate` / `image_edit` 两个工具 |

## 安装 / 更新 / 卸载

```bash
# 从 npm 安装（推荐给使用者）
plugin_manager install_bundle  dsh-tool-gpt-image@0.3.0

# 本地开发：软链自己的源码，改完 toggle 插件条目生效
plugin_manager install_bundle  link:/abs/path/to/dsh-tool-gpt-image
```

装完如果结果里带 `restart-required`（没有 HMR 的部署会这样），退出 DSH 重开一次。

改完代码后：**linked 包的源码改动不会被 HMR 自动重新 import**。两条路，任选其一：

```bash
# A. 在 Plugins 页把这一项关掉再打开（等价于下面两条 plugin_manager 调用）
plugin_manager set_plugin include:tool-gpt-image enabled:false
plugin_manager set_plugin include:tool-gpt-image enabled:true
```

```bash
# B. 重启 DSH
```

卸载：`plugin_manager` 里把该 bundle 关掉或移除即可。

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

## 高级：可选配置

**使用者不需要碰这些。** 只有在自动发现不适用时才值得改，写在 profile 的
`~/.dsh/profiles/<name>/cordis.patch.yml` 里：

```yaml
- id: tool-gpt-image
  name: "dsh-tool-gpt-image"
  config:
    outputDir: images                 # 落盘目录（相对会话工作区）
    timeoutMs: 300000                 # 单次生成超时
    imageModelPatterns:               # 额外把哪些模型 id 认作图像模型（glob）
      - "nano-banana*"
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `outputDir` | `images` | 相对工作区的落盘目录 |
| `timeoutMs` | `300000` | 单次生成超时；生图慢，别设太小 |
| `imageModelPatterns` | 白名单 | 追加的模型 id glob，命中即当作图像模型 |

`baseURL`、`apiKeyEnv`、`defaultModel`、`models` 这四个字段在 0.3.0 已移除——
它们的值现在从你已配好的供应商里读取。

## 排错

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| 「这台机器上还没有配置模型供应商」 | 一个 provider 都没有 | 设置 → 模型 → 添加模型提供商，填地址和密钥，重启 DSH |
| 「…里没有图像模型」 | provider 的模型清单没勾图像模型 | 模型页点该行编辑 → 获取可用模型 → 勾 `gpt-image-2` → 保存 → 重启 |
| 「…的密钥还没填」 | provider 有图像模型但没存 key | 模型页点该行编辑 → 填 API 密钥（和聊天同一把） |
| `image generation failed: HTTP 404` | baseURL 不对或该服务没有 `/images/*` | 检查地址是否到 `/v1` 为止 |
| `HTTP 401` | key 无效 | 重新填 key |

错误文案末尾都带一行 `[agent] …`，把整段错误粘回对话，agent 能按它继续修。

## 已知限制

- 只支持 OpenAI 风格的 `/images/generations` 与 `/images/edits`（`b64_json` 或 `url`）。
  Azure 的 `/openai/deployments/...` 形状、ComfyUI、sd-webui 需要改请求拼装。
- 改图一次只送一张输入图（OpenAI 支持多图参考，这里没暴露）；不支持 outpainting 专用的画布扩展参数。
- 蒙版不做尺寸/格式校验，靠服务端拒绝。
- **`size` 是建议值不是保证**：实测 `gpt-image-2` 在 edits 上按源图分辨率输出
  （要 1024×1024、给 1254×1254 源图，回来还是 1254×1254）。要精确尺寸就在返回后自己缩放。
- `n > 1` 且同时给了 `save_to` 时，文件名自动加 `-1`、`-2` 后缀。
- 工具在调用它的那条模型路由不具备图像输入能力时仍能执行，但模型本身看不到图（GUI 里能看到）。
- 供应商配置改动不会自动重新发现；重载插件条目或重启 DSH 后生效。
