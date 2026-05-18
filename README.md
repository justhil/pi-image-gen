# pi-image-gen

pi 图片生成扩展。注册一个用户命令 `/image-gen`，以及两个给模型调用的原生工具：`image_gen` 和 `image_review`。

当前先支持 Image2 / GPT-Image-2 兼容接口：

- 文生图：`POST /v1/images/generations`
- 图生图 / 编辑：`POST /v1/images/edits`（优先 multipart/form-data；若后端返回 prompt/body 解析错误，会自动重试 JSON `image` / `images` data URL，兼容 chatgpt2api 等实现）
- 默认模型：`gpt-image-2`
- 默认尺寸：`1024x1024`
- 默认返回：`b64_json`

## 安装 / 加载

### GitHub 安装（推荐）

```bash
pi install git:github.com/justhil/pi-image-gen
```

或使用 HTTPS：

```bash
pi install https://github.com/justhil/pi-image-gen
```

项目本地安装：

```bash
pi install -l git:github.com/justhil/pi-image-gen
```

更新：

```bash
pi update git:github.com/justhil/pi-image-gen
```

卸载：

```bash
pi remove git:github.com/justhil/pi-image-gen
```

安装后重启 pi，或在 pi 内执行：

```text
/reload
```

### 开发测试

```bash
git clone https://github.com/justhil/pi-image-gen.git
cd pi-image-gen
npm install
npm run typecheck
pi -e ./index.ts
```

也可以直接加载本地路径：

```bash
pi -e D:/workspace/pi-ext/pi-image-gen/index.ts
```

作为 pi package 安装时，`package.json` 里已经声明：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## 配置

在 pi 里运行：

```text
/image-gen config
```

TUI 配置项：

- API Base URL（`http://host:port` 或 `http://host:port/v1` 都可）
- API Key
- 模型 ID：配置好 API Base URL 和 API Key 后，会自动请求 `/v1/models` 并提供模型列表选择；失败时回退手动输入
- 图片尺寸
- 返回格式：`b64_json` / `url`
- 输出目录
- 审查工具开关
- 连接测试

配置文件位置：

```text
~/.pi/agent/image-gen.json
```

环境变量优先级高于配置文件：

```bash
export IMAGE2_BASE_URL="http://<api-host>:<port>" # 也兼容 http://<api-host>:<port>/v1
export IMAGE2_API_KEY="<API_KEY>"
export IMAGE2_MODEL="gpt-image-2"
export IMAGE2_SIZE="1024x1024"
export IMAGE2_RESPONSE_FORMAT="b64_json"
export IMAGE2_OUTPUT_DIR=".image-gen"
```

兼容短变量：

```bash
export BASE_URL="http://<api-host>:<port>"
export API_KEY="<API_KEY>"
export IMAGE_MODEL="gpt-image-2"
export IMAGE_SIZE="1024x1024"
export IMAGE_RESPONSE_FORMAT="b64_json"
export IMAGE_OUTPUT_DIR=".image-gen"
```

## 原生工具

插件会注册工具：

```text
image_gen
```

注入系统提示的工具简介小于 100 字：

```text
前端/UI设计优先考虑调用image_gen生成参考图或素材；也支持通用生图/编辑，未配置用/image-gen config。
```

渐进式参数注入设计：

1. 系统提示只注入一句短提示，避免挤占上下文。
2. 工具 schema 只暴露最小 action 与常用参数。
3. 模型不确定时先调用 `action=help`，工具返回完整使用规范。
4. 前端/UI 设计是优先提醒场景，但不限制其他生图场景。
5. 未配置时工具只提示用户运行 `/image-gen config`，不让模型索要密钥。

工具 action：

```text
help      查看完整能力和使用规范
status    查看配置状态
generate  文生图
edit      图生图 / 图片编辑 / 换背景 / 统一风格
```

工具参数：

```text
action           help | generate | edit | status
prompt           生图/编辑提示词
image            edit 输入图：本地路径、URL、data URL 或 base64；会校验 jpeg/png/gif/webp 文件头
output_name      输出文件名
size             可选尺寸覆盖，如 1024x1024
response_format  b64_json | url
model            可选模型覆盖
```

### 用户审查工具

插件还会注册：

```text
image_review
```

单独注入系统提示：

```text
用image_review展示图片给用户确认并收集反馈；可在/image-gen config关闭。
```

用途：需要用户确认图片时调用 `image_review`，用 TUI 审查面板展示图片并收集反馈。支持本地路径、HTTP/HTTPS URL、`data:image/...` 和裸 base64；URL 会先下载为 base64 再渲染。

终端图片优先使用 pi / pi-tui 的 inline image 能力：Kitty、Ghostty、WezTerm 走 Kitty graphics protocol，iTerm2 走 iTerm2 image protocol。PowerShell、cmd、zsh 是 shell，不是图片协议；在 Windows Terminal / 普通 xterm 这类未向 pi 暴露 Kitty/iTerm2 的终端里，插件会尝试调用系统默认图片查看器打开保存后的图片，同时显示图片文件路径。

审查面板参考 `pi-ask-user`：搜索式单选、宽屏分栏详情预览、可进入自定义反馈编辑器；使用上下键选择、输入文字过滤、Enter 确认、Esc 返回或取消。

默认选项：

```text
通过
需要修改
重做
取消
```

`需要修改` / `重做/拒绝` 会进入反馈编辑器，Enter 提交，Esc 返回选项；也可以选择 `输入自定义反馈` 直接给出完整反馈。

关闭方式：

```text
/image-gen config -> 审查工具开关 -> 关闭审查工具
```

关闭后扩展会从 active tools 移除 `image_review`，因此该工具的提示词也会停止注入；重新开启会恢复。

## 用户命令

打开菜单：

```text
/image-gen
```

文生图：

```text
/image-gen generate 一只戴墨镜的橘猫，赛博朋克风
```

不带 prompt 时会打开多行编辑器：

```text
/image-gen generate
```

图生图 / 编辑：

```text
/image-gen edit ./input.png 把背景改成赛博朋克霓虹风，保留主体轮廓
```

也支持：

```text
/image-gen edit --image ./input.png 把背景改成透明
```

`image` 可以是：

- 本地路径：`./input.png`
- HTTP/HTTPS URL
- `data:image/png;base64,...`
- 裸 base64

查看配置：

```text
/image-gen status
```

帮助：

```text
/image-gen help
```

## 命令结构约束

只注册 `/image-gen` 一个 pi 命令。

命令下一层 action：

- `generate`
- `edit`
- `config`
- `status`
- `help`

配置菜单内包含审查工具开关，但不新增额外 slash command。

TUI 下最多进入一层表单，不再拆更多 slash command。

## 输出

默认输出目录：

```text
<当前项目>/.image-gen
```

目录会在查看配置、修改输出目录或首次生成图片时自动创建。

`b64_json` 或 `data:` URL 响应会直接保存成图片，并在支持图片协议的终端里弹出 TUI 预览。

普通 URL 响应不会下载远程图片，只会把完整 JSON 响应保存到本地，并在通知里显示 URL。
