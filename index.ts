import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Image, Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const EXTENSION_NAME = "image-gen";
const CONFIG_FILE = join(getAgentDir(), "image-gen.json");
const DEFAULT_BASE_URL = "http://<api-host>:<port>";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_RESPONSE_FORMAT: ResponseFormat = "b64_json";
const DEFAULT_OUTPUT_DIR = "image-gen-output";
const IMAGE2_GENERATE_PATH = "/v1/images/generations";
const IMAGE2_EDIT_PATH = "/v1/images/edits";

const IMAGE_SIZE_VALUES = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
type ImageSize = (typeof IMAGE_SIZE_VALUES)[number] | string;

type ResponseFormat = "b64_json" | "url";
type Action = "generate" | "edit";
type ToolAction = "help" | "generate" | "edit" | "status";

interface ImageGenConfig {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	size?: ImageSize;
	responseFormat?: ResponseFormat;
	outputDir?: string;
}

interface ResolvedConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	size: string;
	responseFormat: ResponseFormat;
	outputDir: string;
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

const IMAGE_GEN_PROMPT_SNIPPET = "前端设计主场景：先用image_gen生成页面参照效果图、元素图、图标icon、插画/商品图；支持文生图/图生图/改图；先help，未配置/image-gen config。";

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

	pi.registerCommand("image-gen", {
		description: "Image2 图片生成 / 图生图 / 配置",
		handler: async (args, ctx) => {
			await handleImageGenCommand(args, ctx);
		},
	});
}

async function handleImageGenCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
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
		await configFlow(ctx);
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
		"查看状态",
	]);

	if (choice === "文生图") await generateFlow(ctx, "");
	if (choice === "图生图 / 编辑") await editFlow(ctx, "");
	if (choice === "配置 Image2 API") await configFlow(ctx);
	if (choice === "查看状态") await showStatus(ctx);
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
		"7. 未配置时请让用户运行 /image-gen config，不要在工具参数里索要密钥。",
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

async function configFlow(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const config = await loadConfig();
		const choice = await ctx.ui.select("Image2 配置", [
			"查看当前配置",
			"设置 API Base URL",
			"设置 API Key",
			"设置模型",
			"设置尺寸",
			"设置返回格式",
			"设置输出目录",
			"测试连接",
		]);

		if (!choice) return;

		if (choice === "查看当前配置") {
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
			const value = await ctx.ui.input("模型 ID", config.model || DEFAULT_MODEL);
			if (value?.trim()) await saveConfig({ ...config, model: value.trim() });
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
			if (value?.trim()) await saveConfig({ ...config, outputDir: value.trim() });
			continue;
		}

		if (choice === "测试连接") {
			await testConnection(ctx);
		}
	}
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
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

	const outputDir = resolveOutputDir(ctx.cwd, config.outputDir);
	await mkdir(outputDir, { recursive: true });

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
