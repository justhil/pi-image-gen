import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, Focusable } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Editor, getCapabilities, Image, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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

interface EditImageInput {
	buffer: Buffer;
	filename: string;
	mimeType: string;
}

interface MultipartField {
	name: string;
	value: string | Buffer;
	filename?: string;
	contentType?: string;
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
	selectedLabel?: string;
	previewFile?: string;
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
	image: Type.String({ description: "要给用户审查的图片：本地路径、URL、data URL 或 base64。" }),
	title: Type.Optional(Type.String({ description: "审查标题，如 图片审查。" })),
	question: Type.Optional(Type.String({ description: "要用户确认的问题。" })),
	context: Type.Optional(Type.String({ description: "简短说明图片用途、页面位置或设计目标。" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "可选自定义按钮文案，最多 4 个；默认：通过、需要修改、重做、取消。" })),
	allow_feedback: Type.Optional(Type.Boolean({ description: "是否显示反馈输入框，默认 true。" })),
});

type ImageReviewToolParams = Static<typeof IMAGE_REVIEW_TOOL_PARAMS>;

const IMAGE_GEN_PROMPT_SNIPPET = "前端/UI设计优先考虑调用image_gen生成参考图或素材；也支持通用生图/编辑，未配置用/image-gen config。";
const IMAGE_REVIEW_PROMPT_SNIPPET = "用image_review展示图片给用户确认并收集反馈；可在/image-gen config关闭。";

export default function imageGenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "image_gen",
		label: "Image Gen",
		description: "Image2 图片生成/编辑工具。前端/UI 设计时优先考虑生成参考图或素材；同时支持通用文生图、图生图、改图、换背景、换风格。先用 action=help 获取完整参数说明；未配置时提示用户运行 /image-gen config。",
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
		description: "用户图片审查工具。需要用户确认图片时调用此工具，用 TUI 展示图片并收集通过、修改、重做或文字反馈。可在 /image-gen config 中关闭，关闭后不再注入提示词。",
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
	const review = await showReviewOverlay(ctx, params, preview);

	const details: ImageReviewToolDetails = {
		choice: review.choice,
		feedback: review.feedback || undefined,
		image: params.image,
		title: params.title,
		question: params.question,
		selectedLabel: review.label,
		previewFile: preview.file,
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
		"image_gen 使用说明：",
		"1. 文生图：action=generate，prompt=图片描述。",
		"2. 图生图/编辑：action=edit，image=输入图，prompt=修改要求。",
		"3. 前端/UI 设计是高频场景：可生成页面参考图、图标、插画、商品图、空状态图、背景图。",
		"4. 其他场景同样可用：概念图、产品图、换背景、风格变体、通用插画。",
		"5. prompt 建议写清：主体、风格、比例/尺寸、色彩、用途、是否透明背景。",
		"6. 可选参数：output_name、size、response_format、model。",
		"7. 需要用户确认图片时，调用 image_review 展示并收集反馈。",
		"8. 未配置时请让用户运行 /image-gen config，不要在工具参数里索要密钥。",
		"支持 image：本地路径、HTTP URL、data:image/...、裸 base64。",
		"输出：b64_json/data URL/普通图片 URL 都会保存图片；URL 响应另存 *-response.json。",
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
	file?: string;
	viewerMessage?: string;
	warning?: string;
}

interface ReviewOverlayResult {
	choice: ReviewChoice;
	label: string;
	feedback: string;
}

interface ReviewOption {
	value: ReviewChoice | "freeform";
	title: string;
	description: string;
}

async function loadReviewPreview(input: string, cwd: string): Promise<ReviewPreview> {
	const trimmed = input.trim();
	if (trimmed.startsWith("data:image/")) {
		const parsed = parseDataUrl(trimmed);
		return prepareReviewPreview(ctxOutputDir(cwd), parsed.data, parsed.mimeType, "review-image", "data URL");
	}
	if (/^https?:\/\//i.test(trimmed)) {
		const response = await fetch(trimmed);
		if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
		const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
		const mimeType = contentType?.startsWith("image/") ? contentType : mimeFromPath(new URL(trimmed).pathname);
		const b64 = Buffer.from(await response.arrayBuffer()).toString("base64");
		return prepareReviewPreview(ctxOutputDir(cwd), b64, mimeType, "review-image", trimmed);
	}
	if (looksLikeBase64(trimmed)) {
		return prepareReviewPreview(ctxOutputDir(cwd), trimmed, "image/png", "review-image", "base64 image");
	}

	const file = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	const data = await readFile(file);
	return prepareReviewPreview(ctxOutputDir(cwd), data.toString("base64"), mimeFromPath(file), file, file);
}

async function prepareReviewPreview(outputDir: string, b64: string, mimeType: string, nameHint: string, label: string): Promise<ReviewPreview> {
	await mkdir(outputDir, { recursive: true });
	const file = resolveOutputFile(outputDir, `${basename(nameHint, extname(nameHint)) || "review-image"}-${timestamp()}.${extensionFromMime(mimeType)}`, extensionFromMime(mimeType));
	await writeFile(file, Buffer.from(b64, "base64"));
	const base = withTerminalImageWarning({ b64, mimeType, label, file });
	if (getCapabilities().images) return base;

	const viewerMessage = await openImageWithDefaultViewer(file);
	return { ...base, viewerMessage, warning: joinMessages(base.warning, viewerMessage) };
}

function ctxOutputDir(cwd: string): string {
	return resolveOutputDir(cwd, DEFAULT_OUTPUT_DIR);
}

function withTerminalImageWarning(preview: ReviewPreview): ReviewPreview {
	const caps = getCapabilities();
	if (!caps.images) return { ...preview, warning: shellAwareImageWarning(preview.file) };
	if (caps.images === "kitty" && preview.mimeType !== "image/png") {
		return { ...preview, warning: "Kitty/Ghostty/WezTerm 图片协议在 pi 中优先支持 PNG；非 PNG 可能显示为占位信息，已保存原图文件。" };
	}
	return preview;
}

function shellAwareImageWarning(file: string | undefined): string {
	const shell = process.env.PSModulePath ? "PowerShell/cmd" : process.env.SHELL ? basename(process.env.SHELL) : "当前 shell";
	const terminal = process.env.WT_SESSION ? "Windows Terminal" : process.env.TERM_PROGRAM || process.env.TERM || "当前终端";
	return `${shell} 不是图片协议，${terminal} 未向 pi 暴露 Kitty/iTerm2 inline image；已保存图片文件${file ? `：${file}` : ""}。`;
}

function joinMessages(...messages: Array<string | undefined>): string | undefined {
	const compact = messages.filter((message): message is string => Boolean(message?.trim()));
	return compact.length > 0 ? compact.join(" ") : undefined;
}

async function openImageWithDefaultViewer(file: string): Promise<string> {
	const command = defaultOpenCommand(file);
	if (!command) return `已保存图片：${file}`;
	try {
		const child = spawn(command.command, command.args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => undefined);
		child.unref();
		return `已尝试用系统默认图片查看器打开：${file}`;
	} catch (error) {
		return `无法自动打开默认图片查看器，已保存图片：${file}（${error instanceof Error ? error.message : String(error)}）`;
	}
}

function defaultOpenCommand(file: string): { command: string; args: string[] } | undefined {
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", file] };
	if (process.platform === "darwin") return { command: "open", args: [file] };
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return { command: "wslview", args: [file] };
	if (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
		return { command: "xdg-open", args: [file] };
	}
	return undefined;
}

function reviewSelectTheme(theme: ExtensionContext["ui"]["theme"]): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

function reviewEditorTheme(theme: ExtensionContext["ui"]["theme"]): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: reviewSelectTheme(theme),
	};
}

function reviewOptions(params: ImageReviewToolParams): ReviewOption[] {
	const labels = (params.options || []).map((item) => item.trim()).filter(Boolean).slice(0, 4);
	const defaults = ["通过", "需要修改", "重做", "取消"];
	const [approve, revise, reject, cancel] = [...labels, ...defaults.slice(labels.length)];
	const options: ReviewOption[] = [
		{ value: "approve", title: approve, description: "认可这张图片。" },
		{ value: "revise", title: revise, description: "保留方向，并填写修改反馈。" },
		{ value: "reject", title: reject, description: "不采用这张图片，并填写原因。" },
		{ value: "cancel", title: cancel, description: "取消本次审查。" },
	];
	if (params.allow_feedback !== false) {
		options.splice(3, 0, { value: "freeform", title: "自定义反馈", description: "直接输入完整反馈。" });
	}
	return options;
}

async function showReviewOverlay(ctx: ExtensionContext, params: ImageReviewToolParams, preview: ReviewPreview): Promise<ReviewOverlayResult> {
	return ctx.ui.custom<ReviewOverlayResult>((tui, theme, keybindings, done) => {
		const title = params.title?.trim() || "图片审查";
		const question = params.question?.trim() || "这张图片是否可用？";
		const context = params.context?.trim();
		const options = reviewOptions(params);
		const selectItems: SelectItem[] = options.map((option) => ({ value: option.value, label: option.title, description: option.description }));
		const selectList = new SelectList(selectItems, Math.min(selectItems.length, 8), reviewSelectTheme(theme), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 36,
		});
		const editor = new Editor(tui, reviewEditorTheme(theme), { paddingX: 1, autocompleteMaxVisible: 0 });
		const allowFeedback = params.allow_feedback !== false;
		let mode: "select" | "comment" = "select";
		let selected = options[0];
		let lastPreviewValue = selected.value;
		const image = preview.b64 && preview.mimeType && getCapabilities().images
			? new Image(preview.b64, preview.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 90, maxHeightCells: 30, filename: safeBasename(preview.label) })
			: undefined;

		selectList.onSelectionChange = (item) => {
			const next = options.find((option) => option.value === item.value) || options[0];
			selected = next;
			if (next.value !== lastPreviewValue) {
				lastPreviewValue = next.value;
				editor.setText(prefillReviewFeedback(next.value));
			}
			tui.requestRender();
		};
		selectList.onSelect = (item) => {
			selected = options.find((option) => option.value === item.value) || options[0];
			if (selected.value === "cancel") {
				done({ choice: "cancel", label: selected.title, feedback: "" });
				return;
			}
			if (selected.value === "approve" && !editor.getText().trim()) {
				done({ choice: "approve", label: selected.title, feedback: "" });
				return;
			}
			if (!allowFeedback) {
				done({ choice: selected.value === "freeform" ? "revise" : selected.value, label: selected.title, feedback: "" });
				return;
			}
			mode = "comment";
			editor.focused = true;
			if (!editor.getText().trim()) editor.setText(prefillReviewFeedback(selected.value));
			tui.requestRender();
		};
		selectList.onCancel = () => done({ choice: "cancel", label: "取消", feedback: "" });
		editor.onSubmit = (text) => done({
			choice: selected.value === "freeform" ? "revise" : selected.value,
			label: selected.title,
			feedback: text.trim(),
		});

		const component: Component & Focusable = {
			focused: true,
			render(width: number) {
				const panelWidth = Math.max(40, width);
				const lines = renderPanelBox(theme, panelWidth, "审查说明", renderReviewHeader(theme, panelWidth - 4, title, question, context, preview));

				lines.push("", reviewSectionTitle(theme, "图片预览"));
				if (image) lines.push(...image.render(panelWidth));
				else lines.push(...renderPanelBox(theme, panelWidth, "图片文件", [theme.fg("muted", preview.file ? `已保存，外部查看器已尝试打开：${preview.file}` : `[Image: ${preview.mimeType || "image"}]`)]));

				lines.push("", reviewSectionTitle(theme, mode === "select" ? "选择结果" : "填写反馈"));
				if (mode === "select") lines.push(...renderPanelBox(theme, panelWidth, "决策", renderReviewSelectPane(theme, panelWidth - 4, selectList, selected)));
				else {
					lines.push(...renderPanelBox(theme, panelWidth, selected.title, [theme.fg("muted", selected.description)]));
					lines.push(...editor.render(panelWidth));
				}
				const hint = mode === "select" ? "输入文字过滤 · ↑↓/Ctrl+j/k 切换 · Enter 选择 · Esc 取消" : "Enter 提交反馈 · Esc 返回选项";
				lines.push("", ...renderPanelBox(theme, panelWidth, "快捷键", [theme.fg("dim", hint)]));
				return lines;
			},
			invalidate() {
				image?.invalidate();
				selectList.invalidate();
				editor.invalidate();
			},
			handleInput(data: string) {
				if (mode === "comment") {
					if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
						mode = "select";
						editor.focused = false;
						tui.requestRender();
						return;
					}
					editor.handleInput(data);
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
		return component;
	}, { overlay: true, overlayOptions: { width: "92%", minWidth: 40, maxHeight: "88%", margin: 1 } });
}

function prefillReviewFeedback(choice: ReviewChoice | "freeform"): string {
	if (choice === "revise") return "需要修改：";
	if (choice === "reject") return "需要重做：";
	return "";
}

function renderReviewHeader(theme: ExtensionContext["ui"]["theme"], width: number, title: string, question: string, context: string | undefined, preview: ReviewPreview): string[] {
	return [
		theme.fg("accent", theme.bold(title)),
		context ? theme.fg("muted", truncateToWidth(context, width, "…")) : "",
		...wrapTextWithAnsi(question, Math.max(20, width)).map((line) => theme.fg("toolOutput", line)),
		preview.warning ? theme.fg("warning", truncateToWidth(preview.warning, width, "…")) : "",
		preview.viewerMessage && preview.warning !== preview.viewerMessage ? theme.fg("muted", truncateToWidth(preview.viewerMessage, width, "…")) : "",
		preview.file ? theme.fg("dim", truncateToWidth(`文件：${preview.file}`, width, "…")) : "",
	].filter(Boolean);
}

function reviewSectionTitle(theme: ExtensionContext["ui"]["theme"], title: string): string {
	return theme.bg("toolSuccessBg", ` ${theme.fg("accent", theme.bold(title))} `);
}

function renderPanelBox(theme: ExtensionContext["ui"]["theme"], width: number, title: string, content: string[]): string[] {
	const innerWidth = Math.max(20, width - 4);
	const border = theme.fg("borderMuted", "─".repeat(innerWidth + 2));
	const titleText = ` ${title} `;
	const top = `${theme.fg("borderMuted", "╭")}${theme.fg("borderAccent", truncateToWidth(titleText, innerWidth, "…"))}${border.slice(Math.min(visibleWidth(titleText), innerWidth))}${theme.fg("borderMuted", "╮")}`;
	const body = content.length > 0 ? content : [""];
	return [
		top,
		...body.flatMap((line) => wrapTextWithAnsi(line, innerWidth)).map((line) => renderPanelLine(theme, innerWidth, line)),
		`${theme.fg("borderMuted", "╰")}${theme.fg("borderMuted", "─".repeat(innerWidth + 2))}${theme.fg("borderMuted", "╯")}`,
	];
}

function renderPanelLine(theme: ExtensionContext["ui"]["theme"], innerWidth: number, line: string): string {
	const truncated = truncateToWidth(line, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
	return `${theme.fg("borderMuted", "│ ")}${theme.bg("toolPendingBg", `${truncated}${padding}`)}${theme.fg("borderMuted", " │")}`;
}

function renderReviewSelectPane(theme: ExtensionContext["ui"]["theme"], width: number, selectList: SelectList, selected: ReviewOption): string[] {
	if (width < 84) return selectList.render(width);
	const leftWidth = Math.floor(width * 0.43);
	const rightWidth = width - leftWidth - 3;
	const left = selectList.render(leftWidth);
	const right = [
		theme.fg("accent", selected.title),
		...wrapTextWithAnsi(selected.description, rightWidth).map((line) => theme.fg("muted", line)),
	];
	const rows = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let i = 0; i < rows; i++) {
		lines.push(`${truncateToWidth(left[i] || "", leftWidth, "", true)}${theme.fg("dim", " │ ")}${truncateToWidth(right[i] || "", rightWidth, "")}`);
	}
	return lines;
}

function formatReviewResult(details: ImageReviewToolDetails): string {
	const label: Record<ReviewChoice, string> = {
		approve: "用户通过。",
		revise: "用户要求修改。",
		reject: "用户要求重做。",
		cancel: "用户取消审查。",
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
	const response = await fetch(apiUrl(config.baseUrl, "/v1/models"), {
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

	let response: Response;
	let text: string;
	if (options.action === "edit") {
		if (!options.image) throw new Error("图生图需要 image 输入");
		const image = await normalizeEditImageInput(options.image, ctx.cwd);
		const editPayload = {
			model: options.model || config.model,
			prompt: options.prompt,
			size: options.size || config.size,
			response_format: options.responseFormat || config.responseFormat,
		};
		const multipart = encodeMultipartForm([
			{ name: "model", value: editPayload.model },
			{ name: "prompt", value: editPayload.prompt },
			{ name: "size", value: editPayload.size },
			{ name: "response_format", value: editPayload.response_format },
			{ name: "image", value: image.buffer, filename: image.filename, contentType: image.mimeType },
		]);
		response = await fetch(apiUrl(config.baseUrl, IMAGE2_EDIT_PATH), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": multipart.contentType,
			},
			body: new Uint8Array(multipart.body),
			signal,
		});
		text = await response.text();
	} else {
		const body: Record<string, unknown> = {
			model: options.model || config.model,
			prompt: options.prompt,
			size: options.size || config.size,
			response_format: options.responseFormat || config.responseFormat,
		};
		response = await fetch(apiUrl(config.baseUrl, IMAGE2_GENERATE_PATH), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
		text = await response.text();
	}

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
		const responseFile = resolveOutputFile(outputDir, responseOutputName(options.outputName || "image-url"), "json");
		await writeFile(responseFile, JSON.stringify(json, null, 2), "utf8");
		if (/^https?:\/\//i.test(first.url)) {
			const downloaded = await downloadImageResult(first.url);
			if (downloaded) {
				const file = resolveOutputFile(outputDir, options.outputName || basename(new URL(first.url).pathname), extensionFromMime(downloaded.mimeType));
				await writeFile(file, downloaded.buffer);
				return { file, url: first.url, responseFile, b64: downloaded.buffer.toString("base64"), mimeType: downloaded.mimeType };
			}
		}
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
		const response = await fetch(apiUrl(config.baseUrl, "/v1/models"), {
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

function encodeMultipartForm(fields: MultipartField[]): { body: Buffer; contentType: string } {
	const boundary = `----pi-image-gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const chunks: Buffer[] = [];
	for (const field of fields) {
		chunks.push(Buffer.from(`--${boundary}\r\n`));
		if (Buffer.isBuffer(field.value)) {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(field.name)}"; filename="${escapeMultipartName(field.filename || "image.png")}"\r\n`));
			chunks.push(Buffer.from(`Content-Type: ${field.contentType || "application/octet-stream"}\r\n\r\n`));
			chunks.push(field.value, Buffer.from("\r\n"));
		} else {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(field.name)}"\r\n\r\n${field.value}\r\n`));
		}
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function escapeMultipartName(value: string): string {
	return value.replace(/["\r\n]/g, "_");
}

async function downloadImageResult(url: string): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
	const response = await fetch(url);
	if (!response.ok) return undefined;
	const buffer = Buffer.from(await response.arrayBuffer());
	const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
	const mimeType = detectImageMime(buffer) || (isSupportedImageMime(contentType) ? contentType : undefined);
	return mimeType ? { buffer, mimeType } : undefined;
}

function responseOutputName(name: string): string {
	const extension = extname(name);
	const stem = extension ? name.slice(0, -extension.length) : name;
	return `${stem}-response.json`;
}

async function normalizeEditImageInput(input: string, cwd: string): Promise<EditImageInput> {
	const trimmed = input.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		const response = await fetch(trimmed);
		if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
		const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
		const buffer = Buffer.from(await response.arrayBuffer());
		const mimeType = detectImageMime(buffer) || (contentType?.startsWith("image/") ? contentType : undefined);
		return buildEditImageInput(buffer, mimeType, basename(new URL(trimmed).pathname), trimmed);
	}
	if (trimmed.startsWith("data:image/")) {
		const parsed = parseDataUrl(trimmed);
		const buffer = Buffer.from(parsed.data, "base64");
		return buildEditImageInput(buffer, parsed.mimeType, "input", "data URL");
	}
	if (looksLikeBase64(trimmed)) {
		const buffer = Buffer.from(trimmed, "base64");
		return buildEditImageInput(buffer, undefined, "input", "base64 image");
	}

	const file = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	const data = await readFile(file);
	return buildEditImageInput(data, mimeFromPath(file), basename(file), file);
}

function buildEditImageInput(buffer: Buffer, hintedMimeType: string | undefined, filename: string, label: string): EditImageInput {
	const detectedMimeType = detectImageMime(buffer);
	const mimeType = detectedMimeType || (isSupportedImageMime(hintedMimeType) ? hintedMimeType : undefined);
	if (!mimeType) {
		const head = buffer.subarray(0, 16).toString("hex") || "empty";
		throw new Error(`输入图不是有效图片：${label}。仅支持 jpeg/png/gif/webp；文件头=${head}`);
	}
	const safeName = filename && extname(filename) ? filename : `input.${extensionFromMime(mimeType)}`;
	return {
		buffer,
		filename: safeName,
		mimeType,
	};
}

function detectImageMime(buffer: Buffer): string | undefined {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6) {
		const gifHeader = buffer.subarray(0, 6).toString("ascii");
		if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
	}
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

function isSupportedImageMime(value: string | undefined): value is string {
	return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
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

function apiUrl(baseUrl: string, path: string): string {
	const base = trimTrailingSlash(baseUrl);
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) return `${base}${normalizedPath.slice(3)}`;
	return `${base}${normalizedPath}`;
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
