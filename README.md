# pi-image-gen

pi 图片生成扩展。注册一个用户命令 `/image-gen`，以及一个给模型调用的原生工具 `image_gen`。

当前先支持 Image2 / GPT-Image-2 兼容接口：

- 文生图：`POST /v1/images/generations`
- 图生图 / 编辑：`POST /v1/images/edits`
- 默认模型：`gpt-image-2`
- 默认尺寸：`1024x1024`
- 默认返回：`b64_json`

## 安装 / 加载

开发测试：

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

- API Base URL
- API Key
- 模型 ID
- 图片尺寸
- 返回格式：`b64_json` / `url`
- 输出目录
- 连接测试

配置文件位置：

```text
~/.pi/agent/image-gen.json
```

环境变量优先级高于配置文件：

```bash
export IMAGE2_BASE_URL="http://<api-host>:<port>"
export IMAGE2_API_KEY="<API_KEY>"
export IMAGE2_MODEL="gpt-image-2"
export IMAGE2_SIZE="1024x1024"
export IMAGE2_RESPONSE_FORMAT="b64_json"
export IMAGE2_OUTPUT_DIR="image-gen-output"
```

兼容短变量：

```bash
export BASE_URL="http://<api-host>:<port>"
export API_KEY="<API_KEY>"
export IMAGE_MODEL="gpt-image-2"
export IMAGE_SIZE="1024x1024"
export IMAGE_RESPONSE_FORMAT="b64_json"
export IMAGE_OUTPUT_DIR="image-gen-output"
```

## 原生工具

插件会注册工具：

```text
image_gen
```

注入系统提示的工具简介小于 100 字：

```text
前端设计主场景：先用image_gen生成页面参照效果图、元素图、图标icon、插画/商品图；支持文生图/图生图/改图；先help，未配置/image-gen config。
```

渐进式参数注入设计：

1. 系统提示只注入一句短提示，并明确前端是主场景。
2. 前端设计前先生成页面参照效果图，确定视觉方向、氛围、布局质感。
3. 页面实现时按需生成元素图片、图标 icon、插画、商品图、空状态图、背景图、卡片装饰图。
4. 工具 schema 只暴露最小 action 与少量常用参数。
5. 模型不确定时先调用 `action=help`，工具返回完整使用规范。
6. 前端素材 prompt 应说明尺寸比例、透明背景需求、风格、色板、用途和插入位置。
7. 未配置时工具只提示用户运行 `/image-gen config`，不让模型索要密钥。

工具 action：

```text
help      查看完整能力和前端使用规范
status    查看配置状态
generate  文生图 / 页面参照图 / 前端素材图
edit      图生图 / 图片编辑 / 换背景 / 统一风格
```

工具参数：

```text
action           help | generate | edit | status
prompt           生图/编辑提示词
image            edit 输入图：本地路径、URL、data URL 或 base64
output_name      输出文件名
size             可选尺寸覆盖，如 1024x1024
response_format  b64_json | url
model            可选模型覆盖
```

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

TUI 下最多进入一层表单，不再拆更多 slash command。

## 输出

默认输出目录：

```text
<当前项目>/image-gen-output
```

`b64_json` 或 `data:` URL 响应会直接保存成图片，并在支持图片协议的终端里弹出 TUI 预览。

普通 URL 响应不会下载远程图片，只会把完整 JSON 响应保存到本地，并在通知里显示 URL。
