# dsh-tool-gpt-image

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一个真正可用的图像生成工具：`image_generate`。

它调用 OpenAI 兼容的 `POST {baseURL}/images/generations`，把返回的 `b64_json`（或 `url`）
解码后 **存入 DSH 的附件存储**——所以在 Web GUI 里会直接渲染成图片，不只是给一个路径；
同时把文件落到会话工作区，方便用户直接打开/拿走。

零 npm 依赖（只用 Node 内建模块），这样它能从一个只装了自身软链的 profile 里正常加载。

![preview](docs/preview.jpg)

> 上图由本插件生成：`image_generate({ prompt: "一只戴着宇航员头盔的橘猫，扁平插画风格，纯色背景" })`


## 装了什么

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明这是一个 DSH bundle（`dsh.bundle.patch`） |
| `cordis.patch.yml` | 往组合里插入 `tool-gpt-image` 这一行，带默认 config |
| `index.js` | 插件本体：注册 `image_generate` 工具 |

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
| `defaultModel` | `gpt-image-1` | 模型 id |
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
ComfyUI、sd-webui 等非 OpenAI 形状的端点需要改 `generate()`。

## 用法

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

## 安装 / 更新 / 卸载

```bash
# 安装（在 DSH 的 plugin_manager 里，或让 agent 执行）
plugin_manager install_bundle  link:/abs/path/to/dsh-tool-gpt-image
```

改完代码后：链接包会被 HMR 监视，通常保存即生效；若工具没出现，重启 DSH。
卸载：`plugin_manager` 里把该 bundle 关掉或移除即可。

## 已知限制

- 只支持 OpenAI 风格的 `/images/generations`（`b64_json` 或 `url`），不支持 DALL·E 之外的自定义协议。
- 不做图片编辑 / inpainting / 蒙版，只有文生图。
- `n > 1` 且同时给了 `save_to` 时，文件名自动加 `-1`、`-2` 后缀。
- 工具在调用它的那条模型路由不具备图像输入能力时仍能执行，但模型本身看不到图（GUI 里能看到）。
