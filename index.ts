import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { getCapabilities, Image, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const EXTENSION_NAME = "image-gen";
const CONFIG_FILE = join(getAgentDir(), "image-gen.json");
const DEFAULT_BASE_URL = "http://<api-host>:<port>";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_RESPONSE_FORMAT: ResponseFormat = "b64_json";
const DEFAULT_OUTPUT_DIR = ".image-gen";
const IMAGE2_GENERATE_PATH = "/v1/images/generations";
const IMAGE2_EDIT_PATH = "/v1/images/edits";

const IMAGE_SIZE_VALUES = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
type ImageSize = (typeof IMAGE_SIZE_VALUES)[number] | string;

type ResponseFormat = "b64_json" | "url";
type Action = "generate" | "edit";
type ToolAction = "help" | "generate" | "edit" | "status";
type ReviewChoice = "approve" | "revise" | "reject" | "cancel";

interface ImageGenConfig {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	size?: ImageSize;
	responseFormat?: ResponseFormat;
	outputDir?: string;
	reviewToolEnabled?: boolean;
}

interface ResolvedConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	size: string;
	responseFormat: ResponseFormat;
	outputDir: string;
	reviewToolEnabled: boolean;
}

interface ImageRequestOptions {
	action: Action;
	prompt: string;
	image?: string;
	outputName?: string;
	size?: string;
	responseFormat?: ResponseFormat;
	model?: string;
}

interface ImageApiResponse {
	data?: Array<{
		b64_json?: string;
		url?: string;
	}>;
	error?: {
		message?: string;
	};
}

interface ModelListResponse {
	data?: Array<{
		id?: string;
	}>;
	error?: {
		message?: string;
	};
}

interface ImageResult {
	file?: string;
	url?: string;
	responseFile?: string;
	b64?: string;
	mimeType?: string;
}

interface ImageGenToolDetails extends ImageResult {
	action: ToolAction;
	configured?: boolean;
	configPath?: string;
	model?: string;
	size?: string;
	responseFormat?: ResponseFormat;
	outputDir?: string;
	reviewToolEnabled?: boolean;
}

interface ImageReviewToolDetails {
	choice: ReviewChoice;
	feedback?: string;
	image?: string;
	title?: string;
	question?: string;
}

const IMAGE_GEN_TOOL_PARAMS = Type.Object({
	action: StringEnum(["help", "generate", "edit", "status"] as const, {
		description: "help=查看完整能力；generate=文生图；edit=图生图；status=配置状态。",
		default: "help",
	}),
	prompt: Type.Optional(Type.String({ description: "生图/编辑提示词。generate/edit 必填。" })),
	image: Type.Optional(Type.String({ description: "edit 输入图：本地路径、URL、data URL 或 base64。" })),
	output_name: Type.Optional(Type.String({ description: "输出文件名；留空自动生成。" })),
	size: Type.Optional(Type.String({ description: "可选尺寸覆盖，如 1024x1024。" })),
	response_format: Type.Optional(StringEnum(["b64_json", "url"] as const, { description: "可选返回格式覆盖。" })),
	model: Type.Optional(Type.String({ description: "可选模型覆盖，默认 gpt-image-2。" })),
});

type ImageGenToolParams = Static<typeof IMAGE_GEN_TOOL_PARAMS>;

const IMAGE_REVIEW_TOOL_PARAMS = Type.Object({
	image: Type.String({ description: "要给用户审查的图片：本地路径、data URL、base64；URL 仅展示链接。" }),
	title: Type.Optional(Type.String({ description: "审查标题，如 前端概念图审查。" })),
	question: Type.Optional(Type.String({ description: "要用户确认的问题。" })),
	context: Type.Optional(Type.String({ description: "简短说明图片用途、页面位置或设计目标。" })),
	allow_feedback: Type.Optional(Type.Boolean({ description: "是否允许用户输入文字反馈，默认 true。" })),
});

type ImageReviewToolParams = Static<typeof IMAGE_REVIEW_TOOL_PARAMS>;

const IMAGE_GEN_PROMPT_SNIPPET = "前端设计主场景：先用image_gen生成页面参照效果图、元素图、图标icon、插画/商品图；支持文生图/图生图/改图；先help，未配置/image-gen config。";
const IMAGE_REVIEW_PROMPT_SNIPPET = "生成前端概念图/素材后用image_review给用户预览确认，收集通过/修改/重做及反馈；可在/image-gen config关闭。";

export default function imageGenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "image_gen",
		label: "Image Gen",
		description: "Image2 图片生成工具。前端设计是主场景：设计页面前先生成参照效果图，再按需生成页面要插入的元素图片、图标 icon、插画、商品图、空状态图、背景图等素材；也支持通用文生图、图生图、改图、换背景、换风格。先用 action=help 获取完整参数说明；未配置时提示用户运行 /image-gen config。",
		promptSnippet: IMAGE_GEN_PROMPT_SNIPPET,
		parameters: IMAGE_GEN_TOOL_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeImageGenTool(params, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "help";
			return new Text(theme.fg("toolTitle", theme.bold("image_gen")) + " " + theme.fg("muted", action), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "image_review",
		label: "Image Review",
		description: "用户图片审查工具。模型生成前端概念图、页面参照图或前端素材图后，应主动调用此工具，把图片用 TUI 展示给用户确认，并收集通过、修改、重做或文字反馈。可在 /image-gen config 中关闭，关闭后不再注入提示词。",
		promptSnippet: IMAGE_REVIEW_PROMPT_SNIPPET,
		parameters: IMAGE_REVIEW_TOOL_PARAMS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeImageReviewTool(params, ctx);
		},
		renderCall(args, theme) {
			const title = typeof args.title === "string" ? args.title : "review";
			return new Text(theme.fg("toolTitle", theme.bold("image_review")) + " " + theme.fg("muted", title), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncReviewToolActive(pi, ctx);
	});

	pi.registerCommand("image-gen", {
		description: "Image2 图片生成 / 图生图 / 配置",
		handler: async (args, ctx) => {
			await handleImageGenCommand(pi, args, ctx);
		},
	});
}

async function handleImageGenCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);

	if (parsed.action === "generate") {
		await generateFlow(ctx, parsed.rest);
		return;
	}

	if (parsed.action === "edit") {
		await editFlow(ctx, parsed.rest);
		return;
	}

	if (parsed.action === "config") {
		await configFlow(pi, ctx);
		return;
	}

	if (parsed.action === "status") {
		await showStatus(ctx);
		return;
	}

	if (parsed.action === "help") {
		showHelp(ctx);
		return;
	}

	if (args.trim()) {
		await generateFlow(ctx, args.trim());
		return;
	}

	if (!ctx.hasUI) {
		showHelp(ctx);
		return;
	}

	const choice = await ctx.ui.select("Image Gen", [
		"文生图",
		"图生图 / 编辑",
		"配置 Image2 API",
		"审查工具开关",
		"查看状态",
	]);

	if (choice === "文生图") await generateFlow(ctx, "");
	if (choice === "图生图 / 编辑") await editFlow(ctx, "");
	if (choice === "配置 Image2 API") await configFlow(pi, ctx);
	if (choice === "审查工具开关") await reviewToolToggleFlow(pi, ctx);
	if (choice === "查看状态") await showStatus(ctx);
}

async function syncReviewToolActive(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "ui">): Promise<void> {
	const config = await loadConfig();
	applyReviewToolActive(pi, ctx, config.reviewToolEnabled ?? true);
}

function applyReviewToolActive(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "ui">, enabled: boolean): void {
	const active = new Set(pi.getActiveTools());
	const hasReview = active.has("image_review");

	if (enabled && !hasReview) {
		active.add("image_review");
		pi.setActiveTools([...active]);
	}
	if (!enabled && hasReview) {
		active.delete("image_review");
		pi.setActiveTools([...active]);
	}

	ctx.ui.setStatus("image-review", enabled ? undefined : "image_review: off");
}

function parseArgs(args: string): { action?: "generate" | "edit" | "config" | "status" | "help"; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { rest: "" };

	const [head = "", ...tail] = trimmed.split(/\s+/);
	const rest = tail.join(" ").trim();
	const normalized = head.toLowerCase();

	if (["generate", "gen", "text", "txt2img", "文生图"].includes(normalized)) return { action: "generate", rest };
	if (["edit", "image", "img2img", "图生图", "编辑"].includes(normalized)) return { action: "edit", rest };
	if (["config", "cfg", "setup", "配置"].includes(normalized)) return { action: "config", rest };
	if (["status", "show", "状态"].includes(normalized)) return { action: "status", rest };
	if (["help", "-h", "--help", "帮助"].includes(normalized)) return { action: "help", rest };

	return { rest: trimmed };
}

async function executeImageReviewTool(
	params: ImageReviewToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ImageReviewToolDetails>> {
	const config = await loadConfig();
	if (config.reviewToolEnabled === false) {
		return {
			content: [{ type: "text", text: "image_review 已关闭。需要重新启用请运行 /image-gen config。" }],
			details: { choice: "cancel", image: params.image, title: params.title, question: params.question },
		};
	}

	if (!ctx.hasUI) {
		return {
			content: [{ type: "text", text: "当前模式没有 TUI，无法进行用户图片审查。" }],
			details: { choice: "cancel", image: params.image, title: params.title, question: params.question },
		};
	}

	let preview: ReviewPreview;
	try {
		preview = await loadReviewPreview(params.image, ctx.cwd);
	} catch (error) {
		return {
			content: [{ type: "text", text: `图片审查失败：${error instanceof Error ? error.message : String(error)}` }],
			details: { choice: "cancel", image: params.image, title: params.title, question: params.question },
		};
	}
	const choice = await showReviewOverlay(ctx, params, preview);
	let feedback = "";
	if (choice === "revise" || choice === "reject") {
		const value = await ctx.ui.editor("请输入图片修改反馈", "");
		feedback = value?.trim() || "";
	} else if (params.allow_feedback !== false) {
		const wantsFeedback = await ctx.ui.confirm("补充反馈？", "是否要补充文字反馈？");
		if (wantsFeedback) {
			const value = await ctx.ui.editor("补充反馈", "");
			feedback = value?.trim() || "";
		}
	}

	const details: ImageReviewToolDetails = {
		choice,
		feedback: feedback || undefined,
		image: params.image,
		title: params.title,
		question: params.question,
	};
	const content: AgentToolResult<ImageReviewToolDetails>["content"] = [{ type: "text", text: formatReviewResult(details) }];
	if (preview.b64 && preview.mimeType) {
		content.push({ type: "image", data: preview.b64, mimeType: preview.mimeType });
	}
	return { content, details };
}

async function executeImageGenTool(
	params: ImageGenToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((partialResult: AgentToolResult<ImageGenToolDetails>) => void) | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ImageGenToolDetails>> {
	const action = params.action || "help";

	if (action === "help") {
		return toolTextResult("help", buildToolHelp(), { configPath: CONFIG_FILE });
	}

	if (action === "status") {
		return toolTextResult("status", await buildToolStatus(), await buildToolStatusDetails());
	}

	const prompt = params.prompt?.trim();
	if (!prompt) {
		return toolTextResult(action, "缺少 prompt。先调用 action=help 查看参数，或补充明确的生图提示词。", { configPath: CONFIG_FILE });
	}

	if (action === "edit" && !params.image?.trim()) {
		return toolTextResult("edit", "缺少 image。edit 需要本地路径、URL、data URL 或 base64 输入图。", { configPath: CONFIG_FILE });
	}

	onUpdate?.({
		content: [{ type: "text", text: `image_gen ${action}: requesting Image2...` }],
		details: { action },
	});

	const result = await requestImage(ctx, {
		action,
		prompt,
		image: params.image?.trim(),
		outputName: params.output_name?.trim() || undefined,
		size: params.size?.trim() || undefined,
		responseFormat: params.response_format,
		model: params.model?.trim() || undefined,
	}, signal);

	const details: ImageGenToolDetails = {
		action,
		file: result.file,
		url: result.url,
		responseFile: result.responseFile,
		mimeType: result.mimeType,
		model: params.model?.trim() || undefined,
		size: params.size?.trim() || undefined,
		responseFormat: params.response_format,
	};
	const content: AgentToolResult<ImageGenToolDetails>["content"] = [{ type: "text", text: formatSuccess(result) }];
	if (result.b64 && result.mimeType) {
		content.push({ type: "image", data: result.b64, mimeType: result.mimeType });
	}
	return { content, details };
}

function toolTextResult(
	action: ToolAction,
	text: string,
	details: Partial<ImageGenToolDetails> = {},
): AgentToolResult<ImageGenToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { action, ...details },
	};
}

function buildToolHelp(): string {
	return [
		"image_gen 前端优先使用规范：",
		"1. 做 landing page、dashboard、移动端、官网、组件库前，先生成页面参照效果图，作为视觉方向和氛围基准。",
		"2. 实现页面时，生成需要插入的元素图片、图标 icon、插画、商品图、空状态图、背景图、卡片装饰图。",
		"3. 文生图：action=generate, prompt=图片/页面效果描述。",
		"4. 图生图/编辑：action=edit, image=输入图, prompt=修改要求，例如换背景、统一风格、生成变体。",
		"5. 前端素材应在 prompt 中说明尺寸比例、透明背景需求、风格、色板、用途和插入位置。",
		"6. 可选参数：output_name、size、response_format、model。",
		"7. 生成前端概念图或素材后，调用 image_review 给用户预览确认并收集反馈。",
		"8. 未配置时请让用户运行 /image-gen config，不要在工具参数里索要密钥。",
		"支持 image：本地路径、HTTP URL、data:image/...、裸 base64。",
		"输出：b64_json/data URL 会保存文件并返回图片块；普通 URL 会保存 JSON。",
	].join("\n");
}

async function buildToolStatus(): Promise<string> {
	const details = await buildToolStatusDetails();
	return [
		"image_gen 状态：",
		`configured: ${details.configured ? "yes" : "no"}`,
		`config: ${details.configPath}`,
		`model: ${details.model}`,
		`size: ${details.size}`,
		`response: ${details.responseFormat}`,
		`output: ${details.outputDir}`,
		`image_review: ${details.reviewToolEnabled ? "on" : "off"}`,
		details.configured ? "可直接 generate/edit。" : "未配置，请运行 /image-gen config。",
	].join("\n");
}

async function buildToolStatusDetails(): Promise<ImageGenToolDetails> {
	const config = await resolveConfig();
	return {
		action: "status",
		configured: Boolean(config.baseUrl && config.baseUrl !== DEFAULT_BASE_URL && config.apiKey && config.model),
		configPath: CONFIG_FILE,
		model: config.model,
		size: config.size,
		responseFormat: config.responseFormat,
		outputDir: config.outputDir,
		reviewToolEnabled: config.reviewToolEnabled,
	};
}

async function generateFlow(ctx: ExtensionCommandContext, initialPrompt: string): Promise<void> {
	const prompt = await resolvePrompt(ctx, "文生图 Prompt", initialPrompt);
	if (!prompt) return;

	const outputName = ctx.hasUI
		? await ctx.ui.input("输出文件名", "留空自动生成；例如 cat.png")
		: undefined;

	await runWithStatus(ctx, "image-gen: generating", async () => {
		const result = await requestImage(ctx, {
			action: "generate",
			prompt,
			outputName: outputName?.trim() || undefined,
		});
		await showResult(ctx, result);
	});
}

async function editFlow(ctx: ExtensionCommandContext, initialPrompt: string): Promise<void> {
	let image = "";
	let prompt = initialPrompt;

	if (initialPrompt) {
		const parsed = parseEditInlineArgs(initialPrompt);
		image = parsed.image;
		prompt = parsed.prompt;
	}

	if (!image) {
		const value = await ctx.ui.input("输入图片", "本地路径、http(s) URL、data:image/... 或裸 base64");
		if (!value?.trim()) return;
		image = value.trim();
	}

	const resolvedPrompt = await resolvePrompt(ctx, "图生图 / 编辑 Prompt", prompt);
	if (!resolvedPrompt) return;

	const outputName = ctx.hasUI
		? await ctx.ui.input("输出文件名", "留空自动生成；例如 edited.png")
		: undefined;

	await runWithStatus(ctx, "image-gen: editing", async () => {
		const result = await requestImage(ctx, {
			action: "edit",
			prompt: resolvedPrompt,
			image,
			outputName: outputName?.trim() || undefined,
		});
		await showResult(ctx, result);
	});
}

interface ReviewPreview {
	b64?: string;
	mimeType?: string;
	label: string;
	warning?: string;
}

async function loadReviewPreview(input: string, cwd: string): Promise<ReviewPreview> {
	const trimmed = input.trim();
	if (trimmed.startsWith("data:image/")) {
		const parsed = parseDataUrl(trimmed);
		return withTerminalImageWarning({ b64: parsed.data, mimeType: parsed.mimeType, label: "data URL" });
	}
	if (/^https?:\/\//i.test(trimmed)) {
		const response = await fetch(trimmed);
		if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
		const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
		const mimeType = contentType?.startsWith("image/") ? contentType : mimeFromPath(new URL(trimmed).pathname);
		const data = Buffer.from(await response.arrayBuffer()).toString("base64");
		return withTerminalImageWarning({ b64: data, mimeType, label: trimmed });
	}
	if (looksLikeBase64(trimmed)) {
		return withTerminalImageWarning({ b64: trimmed, mimeType: "image/png", label: "base64 image" });
	}

	const file = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	const data = await readFile(file);
	return withTerminalImageWarning({ b64: data.toString("base64"), mimeType: mimeFromPath(file), label: file });
}

function withTerminalImageWarning(preview: ReviewPreview): ReviewPreview {
	const caps = getCapabilities();
	if (!caps.images) {
		return { ...preview, warning: "当前终端不支持 inline image 或已被 pi 禁用，将显示图片占位信息。" };
	}
	if (caps.images === "kitty" && preview.mimeType !== "image/png") {
		return { ...preview, warning: "Kitty/Ghostty/WezTerm 图片协议在 pi 中优先支持 PNG；非 PNG 可能显示为占位信息。" };
	}
	return preview;
}

async function showReviewOverlay(ctx: ExtensionContext, params: ImageReviewToolParams, preview: ReviewPreview): Promise<ReviewChoice> {
	return ctx.ui.custom<ReviewChoice>((_tui, theme, _keybindings, done) => {
		const title = params.title?.trim() || "前端图片审查";
		const question = params.question?.trim() || "这个概念图/素材是否可以继续用于前端实现？";
		const context = params.context?.trim();
		const image = preview.b64 && preview.mimeType
			? new Image(preview.b64, preview.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 90, maxHeightCells: 30, filename: safeBasename(preview.label) })
			: undefined;

		return {
			render(width: number) {
				const lines = [
					theme.fg("accent", theme.bold(title)),
					context ? theme.fg("muted", context) : "",
					theme.fg("toolOutput", question),
					preview.warning ? theme.fg("warning", preview.warning) : "",
					preview.b64 ? "" : theme.fg("warning", `无法内联预览图片：${preview.label}`),
				].filter(Boolean);
				if (image) lines.push("", ...image.render(width));
				lines.push(
					"",
					theme.fg("success", "1 通过，继续实现"),
					theme.fg("warning", "2 需要修改，输入反馈"),
					theme.fg("error", "3 重做/拒绝，输入原因"),
					theme.fg("dim", "Esc 取消"),
				);
				return lines;
			},
			invalidate() {
				image?.invalidate();
			},
			handleInput(data: string) {
				if (data === "1") done("approve");
				else if (data === "2") done("revise");
				else if (data === "3") done("reject");
				else if (matchesKey(data, Key.escape)) done("cancel");
			},
		};
	}, { overlay: true, overlayOptions: { width: "85%", maxHeight: "90%", margin: 2 } });
}

function formatReviewResult(details: ImageReviewToolDetails): string {
	const label: Record<ReviewChoice, string> = {
		approve: "用户通过，可以继续前端实现。",
		revise: "用户要求修改，请根据反馈调整图片或设计。",
		reject: "用户拒绝/要求重做，请重新生成方案。",
		cancel: "用户取消审查，停止基于该图片继续推进。",
	};
	return [
		`image_review: ${details.choice}`,
		label[details.choice],
		details.feedback ? `反馈：${details.feedback}` : "",
	].filter(Boolean).join("\n");
}

function parseEditInlineArgs(value: string): { image: string; prompt: string } {
	const trimmed = value.trim();
	const match = trimmed.match(/^(?:--image|-i)\s+(\S+)\s+([\s\S]+)$/);
	if (match) return { image: match[1], prompt: match[2].trim() };

	const [first = "", ...rest] = trimmed.split(/\s+/);
	if (looksLikeImageInput(first) && rest.length > 0) {
		return { image: first, prompt: rest.join(" ").trim() };
	}

	return { image: "", prompt: trimmed };
}

async function resolvePrompt(ctx: ExtensionCommandContext, title: string, initial: string): Promise<string | undefined> {
	if (initial.trim()) return initial.trim();
	if (!ctx.hasUI) {
		ctx.ui.notify(`缺少 prompt。用法: /image-gen generate <prompt>`, "error");
		return undefined;
	}
	const prompt = await ctx.ui.editor(title, "");
	return prompt?.trim() || undefined;
}

async function configFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const config = await loadConfig();
		await ensureOutputDir(ctx.cwd, (await resolveConfig()).outputDir);
		const choice = await ctx.ui.select("Image2 配置", [
			"查看当前配置",
			"设置 API Base URL",
			"设置 API Key",
			"设置模型",
			"设置尺寸",
			"设置返回格式",
			"设置输出目录",
			`审查工具开关 (${(config.reviewToolEnabled ?? true) ? "on" : "off"})`,
			"测试连接",
		]);

		if (!choice) return;

		if (choice === "查看当前配置") {
			await ensureOutputDir(ctx.cwd, (await resolveConfig()).outputDir);
			ctx.ui.notify(formatConfig(config), "info");
			continue;
		}

		if (choice === "设置 API Base URL") {
			const value = await ctx.ui.input("API Base URL", config.baseUrl || DEFAULT_BASE_URL);
			if (value?.trim()) await saveConfig({ ...config, baseUrl: trimTrailingSlash(value.trim()) });
			continue;
		}

		if (choice === "设置 API Key") {
			const value = await ctx.ui.input("API Key", "留空取消；输入 - 清除已保存 key");
			if (value === undefined || value === "") continue;
			const next = { ...config };
			if (value.trim() === "-") delete next.apiKey;
			else next.apiKey = value.trim();
			await saveConfig(next);
			continue;
		}

		if (choice === "设置模型") {
			await chooseModelFlow(ctx, config);
			continue;
		}

		if (choice === "设置尺寸") {
			const selected = await ctx.ui.select("图片尺寸", [...IMAGE_SIZE_VALUES, "自定义"]);
			if (!selected) continue;
			if (selected === "自定义") {
				const custom = await ctx.ui.input("自定义尺寸", config.size || DEFAULT_SIZE);
				if (custom?.trim()) await saveConfig({ ...config, size: custom.trim() });
			} else {
				await saveConfig({ ...config, size: selected });
			}
			continue;
		}

		if (choice === "设置返回格式") {
			const selected = await ctx.ui.select("返回格式", ["b64_json", "url"]);
			if (selected === "b64_json" || selected === "url") await saveConfig({ ...config, responseFormat: selected });
			continue;
		}

		if (choice === "设置输出目录") {
			const value = await ctx.ui.input("输出目录", config.outputDir || DEFAULT_OUTPUT_DIR);
			if (value?.trim()) {
				await saveConfig({ ...config, outputDir: value.trim() });
				await ensureOutputDir(ctx.cwd, value.trim());
			}
			continue;
		}

		if (choice.startsWith("审查工具开关")) {
			await reviewToolToggleFlow(pi, ctx);
			continue;
		}

		if (choice === "测试连接") {
			await testConnection(ctx);
		}
	}
}

async function chooseModelFlow(ctx: ExtensionCommandContext, config: ImageGenConfig): Promise<void> {
	const resolved = await resolveConfig();
	let models: string[] = [];

	if (resolved.baseUrl && resolved.baseUrl !== DEFAULT_BASE_URL && resolved.apiKey) {
		ctx.ui.setStatus(EXTENSION_NAME, "image-gen: loading models");
		try {
			models = await fetchModels(resolved);
		} catch (error) {
			ctx.ui.notify(`获取模型列表失败，改为手动输入：${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			ctx.ui.setStatus(EXTENSION_NAME, undefined);
		}
	} else {
		ctx.ui.notify("先配置 API Base URL 和 API Key，才能自动获取模型列表。", "warning");
	}

	const current = resolved.model || DEFAULT_MODEL;
	if (models.length > 0) {
		const options = [...new Set([current, ...models]), "手动输入"];
		const selected = await ctx.ui.select("选择模型", options);
		if (!selected) return;
		if (selected !== "手动输入") {
			await saveConfig({ ...config, model: selected });
			return;
		}
	}

	const value = await ctx.ui.input("模型 ID", current);
	if (value?.trim()) await saveConfig({ ...config, model: value.trim() });
}

async function fetchModels(config: ResolvedConfig): Promise<string[]> {
	const response = await fetch(`${config.baseUrl}/v1/models`, {
		headers: { Authorization: `Bearer ${config.apiKey}` },
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);

	let json: ModelListResponse;
	try {
		json = JSON.parse(text) as ModelListResponse;
	} catch {
		throw new Error(`返回非 JSON：${text.slice(0, 120)}`);
	}
	if (json.error?.message) throw new Error(json.error.message);

	const models = (json.data || [])
		.map((item) => item.id)
		.filter((id): id is string => Boolean(id?.trim()))
		.sort((a, b) => a.localeCompare(b));
	if (models.length === 0) throw new Error("/v1/models 未返回可用模型 ID");
	return models;
}

async function reviewToolToggleFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const config = await loadConfig();
	const enabled = config.reviewToolEnabled ?? true;
	const choice = await ctx.ui.select("image_review 审查工具", [
		enabled ? "保持开启" : "开启审查工具",
		enabled ? "关闭审查工具" : "保持关闭",
	]);
	if (!choice || choice.startsWith("保持")) return;

	const nextEnabled = choice.startsWith("开启");
	await saveConfig({ ...config, reviewToolEnabled: nextEnabled });
	applyReviewToolActive(pi, ctx, nextEnabled);
	ctx.ui.notify(nextEnabled ? "image_review 已开启，审查工具提示词已恢复注入。" : "image_review 已关闭，审查工具提示词已停止注入。", "info");
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	await ensureOutputDir(ctx.cwd, (await resolveConfig()).outputDir);
	ctx.ui.notify(formatConfig(await loadConfig()), "info");
}

function showHelp(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		[
			"/image-gen 用法：",
			"  /image-gen                         打开 TUI 菜单",
			"  /image-gen generate <prompt>       文生图",
			"  /image-gen edit <image> <prompt>   图生图 / 编辑",
			"  /image-gen config                  配置 Image2 API",
			"  /image-gen status                  查看状态",
			"",
			"命令只有一层子动作；TUI 菜单最多进入一层表单。",
		].join("\n"),
		"info",
	);
}

async function requestImage(ctx: { cwd: string }, options: ImageRequestOptions, signal?: AbortSignal): Promise<ImageResult> {
	const config = await resolveConfig();
	validateConfig(config);

	const body: Record<string, unknown> = {
		model: options.model || config.model,
		prompt: options.prompt,
		size: options.size || config.size,
		response_format: options.responseFormat || config.responseFormat,
	};

	if (options.action === "edit") {
		if (!options.image) throw new Error("图生图需要 image 输入");
		body.image = await normalizeImageInput(options.image, ctx.cwd);
	}

	const endpoint = options.action === "edit" ? IMAGE2_EDIT_PATH : IMAGE2_GENERATE_PATH;
	const response = await fetch(`${config.baseUrl}${endpoint}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Image2 HTTP ${response.status}: ${text.slice(0, 800)}`);
	}

	let json: ImageApiResponse;
	try {
		json = JSON.parse(text) as ImageApiResponse;
	} catch {
		throw new Error(`Image2 返回非 JSON：${text.slice(0, 300)}`);
	}

	if (json.error?.message) throw new Error(json.error.message);
	const first = json.data?.[0];
	if (!first) throw new Error("Image2 未返回 data[0]");

	const outputDir = await ensureOutputDir(ctx.cwd, config.outputDir);

	if (first.b64_json) {
		const file = resolveOutputFile(outputDir, options.outputName, "png");
		await writeFile(file, Buffer.from(first.b64_json, "base64"));
		return { file, b64: first.b64_json, mimeType: "image/png" };
	}

	if (first.url?.startsWith("data:")) {
		const parsed = parseDataUrl(first.url);
		const file = resolveOutputFile(outputDir, options.outputName, extensionFromMime(parsed.mimeType));
		await writeFile(file, Buffer.from(parsed.data, "base64"));
		return { file, b64: parsed.data, mimeType: parsed.mimeType };
	}

	if (first.url) {
		const responseFile = resolveOutputFile(outputDir, options.outputName || "image-url", "json");
		await writeFile(responseFile, JSON.stringify(json, null, 2), "utf8");
		return { url: first.url, responseFile };
	}

	const responseFile = resolveOutputFile(outputDir, options.outputName || "image-response", "json");
	await writeFile(responseFile, JSON.stringify(json, null, 2), "utf8");
	return { responseFile };
}

async function testConnection(ctx: ExtensionCommandContext): Promise<void> {
	try {
		const config = await resolveConfig();
		validateConfig(config);
		const response = await fetch(`${config.baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
		});
		if (!response.ok) {
			ctx.ui.notify(`连接失败：HTTP ${response.status}`, "warning");
			return;
		}
		ctx.ui.notify("连接正常：/v1/models 可访问", "info");
	} catch (error) {
		ctx.ui.notify(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runWithStatus(ctx: ExtensionCommandContext, status: string, work: () => Promise<void>): Promise<void> {
	ctx.ui.setStatus(EXTENSION_NAME, status);
	try {
		await work();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		ctx.ui.setStatus(EXTENSION_NAME, undefined);
	}
}

async function loadConfig(): Promise<ImageGenConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as ImageGenConfig;
	} catch {
		return {};
	}
}

async function saveConfig(config: ImageGenConfig): Promise<void> {
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

async function resolveConfig(): Promise<ResolvedConfig> {
	const config = await loadConfig();
	const baseUrl = process.env.IMAGE2_BASE_URL || process.env.BASE_URL || config.baseUrl || "";
	const apiKey = process.env.IMAGE2_API_KEY || process.env.API_KEY || config.apiKey || "";
	return {
		baseUrl: trimTrailingSlash(baseUrl),
		apiKey,
		model: process.env.IMAGE2_MODEL || process.env.IMAGE_MODEL || config.model || DEFAULT_MODEL,
		size: process.env.IMAGE2_SIZE || process.env.IMAGE_SIZE || config.size || DEFAULT_SIZE,
		responseFormat: normalizeResponseFormat(process.env.IMAGE2_RESPONSE_FORMAT || process.env.IMAGE_RESPONSE_FORMAT || config.responseFormat),
		outputDir: process.env.IMAGE2_OUTPUT_DIR || process.env.IMAGE_OUTPUT_DIR || config.outputDir || DEFAULT_OUTPUT_DIR,
		reviewToolEnabled: config.reviewToolEnabled ?? true,
	};
}

function validateConfig(config: ResolvedConfig): void {
	if (!config.baseUrl || config.baseUrl === DEFAULT_BASE_URL) throw new Error("Image2 API Base URL 未配置，请运行 /image-gen config");
	if (!config.apiKey) throw new Error("Image2 API Key 未配置，请运行 /image-gen config");
	if (!config.model) throw new Error("Image2 模型未配置，请运行 /image-gen config");
}

function normalizeResponseFormat(value: unknown): ResponseFormat {
	return value === "url" ? "url" : "b64_json";
}

function formatConfig(config: ImageGenConfig): string {
	const envBaseUrl = process.env.IMAGE2_BASE_URL || process.env.BASE_URL;
	const envApiKey = process.env.IMAGE2_API_KEY || process.env.API_KEY;
	return [
		"Image2 配置",
		`配置文件: ${CONFIG_FILE}`,
		`Base URL: ${envBaseUrl || config.baseUrl || "未配置"}${envBaseUrl ? " (env)" : ""}`,
		`API Key: ${envApiKey ? maskSecret(envApiKey) + " (env)" : maskSecret(config.apiKey)}`,
		`Model: ${process.env.IMAGE2_MODEL || process.env.IMAGE_MODEL || config.model || DEFAULT_MODEL}`,
		`Size: ${process.env.IMAGE2_SIZE || process.env.IMAGE_SIZE || config.size || DEFAULT_SIZE}`,
		`Response: ${process.env.IMAGE2_RESPONSE_FORMAT || process.env.IMAGE_RESPONSE_FORMAT || config.responseFormat || DEFAULT_RESPONSE_FORMAT}`,
		`Output: ${process.env.IMAGE2_OUTPUT_DIR || process.env.IMAGE_OUTPUT_DIR || config.outputDir || DEFAULT_OUTPUT_DIR}`,
		`Review tool: ${(config.reviewToolEnabled ?? true) ? "on" : "off"}`,
	].join("\n");
}

function maskSecret(value: string | undefined): string {
	if (!value) return "未配置";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

async function normalizeImageInput(input: string, cwd: string): Promise<string> {
	const trimmed = input.trim();
	if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:image/")) return trimmed;
	if (looksLikeBase64(trimmed)) return trimmed;

	const file = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	const data = await readFile(file);
	const mimeType = mimeFromPath(file);
	return `data:${mimeType};base64,${data.toString("base64")}`;
}

function looksLikeImageInput(value: string): boolean {
	if (/^https?:\/\//i.test(value) || value.startsWith("data:image/")) return true;
	return /\.(png|jpe?g|webp|gif)$/i.test(value) || existsSync(value);
}

function looksLikeBase64(value: string): boolean {
	return value.length > 80 && /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function mimeFromPath(file: string): string {
	const extension = extname(file).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".webp") return "image/webp";
	if (extension === ".gif") return "image/gif";
	return "image/png";
}

function parseDataUrl(value: string): { mimeType: string; data: string } {
	const match = value.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) throw new Error("无效 data URL 图片响应");
	return { mimeType: match[1], data: match[2] };
}

function extensionFromMime(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "png";
}

function safeBasename(value: string): string | undefined {
	if (/^https?:\/\//i.test(value)) return undefined;
	return basename(value);
}

async function ensureOutputDir(cwd: string, outputDir: string): Promise<string> {
	const dir = resolveOutputDir(cwd, outputDir);
	await mkdir(dir, { recursive: true });
	return dir;
}

function resolveOutputDir(cwd: string, outputDir: string): string {
	return isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir);
}

function resolveOutputFile(outputDir: string, requestedName: string | undefined, fallbackExtension: string): string {
	const safeName = requestedName?.trim();
	if (safeName) {
		const resolved = isAbsolute(safeName) ? safeName : resolve(outputDir, safeName);
		return extname(resolved) ? resolved : `${resolved}.${fallbackExtension}`;
	}
	return join(outputDir, `image-${timestamp()}.${fallbackExtension}`);
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

async function showResult(ctx: ExtensionCommandContext, result: ImageResult): Promise<void> {
	ctx.ui.notify(formatSuccess(result), "info");
	if (!ctx.hasUI || !result.b64 || !result.mimeType) return;

	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const image = new Image(result.b64!, result.mimeType!, { fallbackColor: (text) => theme.fg("muted", text) }, {
			maxWidthCells: 80,
			maxHeightCells: 28,
			filename: result.file ? basename(result.file) : undefined,
		});
		const help = new Text(theme.fg("success", "图片已生成") + "\n" + theme.fg("dim", `${result.file || ""}\nEnter / Esc 关闭预览`), 0, 0);
		return {
			render(width: number) {
				return [...image.render(width), "", ...help.render(width)];
			},
			invalidate() {
				image.invalidate();
				help.invalidate();
			},
			handleInput() {
				done();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "85%", margin: 2 } });
}

function formatSuccess(result: { file?: string; url?: string; responseFile?: string }): string {
	if (result.file) return `✅ 图片已保存：${result.file}`;
	if (result.url) return `✅ 图片 URL：${result.url}\n响应已保存：${result.responseFile}`;
	return `✅ 响应已保存：${result.responseFile}`;
}
