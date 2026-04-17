import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import {
	appendFile,
	access,
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises"
import * as path from "node:path"

import type { Part } from "@opencode-ai/sdk"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const DATA_VERSION = 1
const SIGNAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const PROPOSAL_STALE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const CORRECTION_BLOCK_NAME = "agenttracer-correction"
const SELF_IMPROVE_COMMAND_NAME = "agent-selfimprove"
const SELF_IMPROVE_COMMAND_DESCRIPTION =
	"Review open evidence-backed agentTracer improvements without mutating state"
const SELF_IMPROVE_COMMAND_TEMPLATE = [
	"Before doing anything else, call `agenttracer_selfimprove`.",
	"Review the returned open evidence-backed agentTracer proposals and summarize the most important next steps.",
	"This command is read-only by default: review and suggest improvements only.",
	"Do not edit files, capture candidate snapshots, record evals, accept proposals, or record rollbacks unless a later user message separately and explicitly approves those mutating steps.",
].join(" ")
const ALLOWED_KINDS = ["instruction", "workflow", "verification", "communication"] as const
const CORRECTIVE_RETRY_PATTERN =
	/\b(retry|re-run|rerun|try again|correct(?:ion|ive)?|revise|revision|rework|failed review|review feedback|reviewer feedback|address feedback|address reviewer|re-review)\b/i
type NamedPattern = {
	trigger: string
	pattern: RegExp
}
const BLOCKED_TOOL_PATTERN =
	/\b(not allowed|disallowed|forbidden|blocked|unsupported|unavailable|not available|cannot use|can't use|do not use|should not use|isn't allowed|is not allowed)\b/i
const BLOCKED_TOOL_CONTEXT_PATTERN =
	/\b(do not use|don't use|cannot use|can't use|should not use|blocked from using|not allowed(?:\s+for)?|forbidden|disallowed|isn't allowed|is not allowed)\b/i
const PERMISSION_PATTERNS = [
	{
		trigger: "permission-denied",
		pattern: /\b(permission denied|access denied|not permitted|insufficient permissions?)\b/i,
	},
	{
		trigger: "approval-required",
		pattern:
			/\b(permission required|approval required|requires approval|needs approval|requires permission|needs permission|requires elevated access|requires elevated permissions?)\b/i,
	},
	{
		trigger: "permission-not-granted",
		pattern:
			/\b(i do not have permission|i don't have permission|do not have permission|don't have permission|access is not granted|permission has not been granted|without approval|without permission)\b/i,
	},
	{
		trigger: "sandbox-denied",
		pattern: /\b(denied by sandbox|restricted by sandbox|sandbox prevented|sandbox blocks?|sandbox denies?)\b/i,
	},
] as const satisfies readonly NamedPattern[]
const ENVIRONMENT_PATTERNS = [
	{
		trigger: "read-only-filesystem",
		pattern:
			/\b(read-only filesystem|read only filesystem|read-only fs|read only fs|filesystem is read-only|file system is read-only)\b/i,
	},
	{
		trigger: "network-restricted",
		pattern:
			/\b(no network access|network access(?:\s+is)?\s+unavailable|offline environment|cannot reach the network|can't reach the network|environment does not allow network|environment doesn't allow network)\b/i,
	},
	{
		trigger: "sandboxed-environment",
		pattern: /\b(sandboxed|sandbox environment|running in a sandbox|this sandbox)\b/i,
	},
	{
		trigger: "environment-restricted",
		pattern: /\b(environment restriction|environment restrictions|not available in this environment|environment does not allow|environment doesn't allow)\b/i,
	},
	{
		trigger: "timeout-or-resource-cap",
		pattern:
			/\b(timed out|timeout(?:\s+limit)?|time limit exceeded|execution time limit|resource limit|resource limits|resource cap|resource caps|memory limit|cpu limit|quota exceeded|rate limited?)\b/i,
	},
] as const satisfies readonly NamedPattern[]
const CAPABILITY_PATTERNS = [
	{
		trigger: "tool-unavailable",
		pattern: /\b(tool unavailable|tool not available|missing tool|no available tool|no supported tool)\b/i,
	},
	{
		trigger: "tool-not-installed",
		pattern: /\b(tool not installed|not installed here|binary missing|cli missing)\b/i,
	},
	{
		trigger: "command-not-found",
		pattern: /\b(command not found|not found on path)\b/i,
	},
	{
		trigger: "capability-unavailable",
		pattern:
			/\b(capability unavailable|capability not available|missing capability|lack(?:s|ing)? (?:the )?(?:required )?(?:tool|capability|access)|required [a-z0-9._-]+ access is unavailable|required [a-z0-9._-]+ tool is unavailable|required [a-z0-9._-]+ capability is unavailable|required [a-z0-9._-]+ api is unavailable|required [a-z0-9._-]+ api is not accessible)\b/i,
	},
	{
		trigger: "access-unavailable",
		pattern: /\b(api not accessible|api access is unavailable|service not accessible|required access is unavailable|access unavailable)\b/i,
	},
	{
		trigger: "execution-capability-missing",
		pattern:
			/\b(not supported here|unsupported here|cannot browse|can't browse|cannot edit|can't edit|cannot write|can't write|cannot run|can't run|cannot execute|can't execute|cannot access|can't access)\b/i,
	},
] as const satisfies readonly NamedPattern[]
const CONFUSION_PATTERNS = [
	{
		trigger: "unclear-or-ambiguous",
		pattern:
			/\b(confused|not sure|unsure|unclear|ambiguous|don't understand|do not understand|can't tell|cannot tell)\b/i,
	},
	{
		trigger: "missing-context",
		pattern:
			/\b(missing context|need more context|need more info(?:rmation)?|need clarification|needs clarification|requires clarification|not enough information|missing information|insufficient (?:context|information|detail(?:s)?)|lack(?:ing)? (?:context|information|detail(?:s)?)|need additional context|need more details)\b/i,
	},
] as const satisfies readonly NamedPattern[]
const STUCK_PATTERNS = [
	{
		trigger: "stuck",
		pattern: /\b(stuck|failed again|still failing|keeps failing|retry loop|repeated failure)\b/i,
	},
	{
		trigger: "cannot-proceed",
		pattern: /\b(unable to proceed|cannot proceed|can't proceed|unable to continue|cannot continue|can't continue)\b/i,
	},
	{
		trigger: "explicit-inability",
		pattern:
			/\b(?:can't|cannot|can not|unable to|not able to)\s+(?:complete|finish|fulfill|help|comply|proceed|continue|do|perform|carry out|resolve|provide|deliver|satisfy)\b/i,
	},
	{
		trigger: "request-unfulfillable",
		pattern:
			/\b(?:this|the)\s+request\s+(?:can't|cannot|can not|could not|couldn't)\s+be\s+(?:completed|fulfilled|done)\b/i,
	},
	{
		trigger: "unfinished",
		pattern:
			/\b(could not finish|couldn't finish|unable to complete|cannot complete|can't complete|unable to fulfill|cannot fulfill|can't fulfill)\b/i,
	},
] as const satisfies readonly NamedPattern[]
const BLOCKED_TOOL_NAME_PATTERNS = [
	/[`"']([a-z0-9._-]+)[`"']/i,
	/\buse\s+the\s+([a-z0-9._-]+)\s+tool\b/i,
	/\buse\s+([a-z0-9._-]+)\s+tool\b/i,
	/\bthe\s+([a-z0-9._-]+)\s+tool\b/i,
	/\btool\s+([a-z0-9._-]+)\b/i,
	/\btool\s+[`"']([a-z0-9._-]+)[`"']/i,
	/\buse\s+[`"']([a-z0-9._-]+)[`"']/i,
	/\buse\s+([a-z0-9._-]+)\b/i,
] as const
const CAPABILITY_NAME_PATTERNS = [
	/\brequired\s+([a-z0-9._-]+)\s+(?:tool|capability|access)\s+is\s+unavailable\b/i,
	/\b(?:required|missing)\s+(?:tool|capability|access)\s+([a-z0-9._-]+)\b/i,
	/\b([a-z0-9._-]+)\s+is\s+unavailable\b/i,
	/\b[`"']?([a-z0-9._-]+)[`"']?\s*:\s*command not found\b/i,
	/\b(?:tool|command|api|service|binary|cli)\s+[`"']?([a-z0-9._ -]+)[`"']?\s+not\s+found\b/i,
	/\b(?:tool|command|api|service|binary|cli)\s+[`"']?([a-z0-9._ -]+)[`"']?\s+(?:is\s+)?(?:unavailable|not available|missing|not installed|not accessible)\b/i,
	/\b(?:missing|need|needs|requires|required)\s+(?:the\s+)?(?:tool|capability|access)\s+[`"']?([a-z0-9._ -]+)[`"']?/i,
	/\b(?:cannot|can't|unable to)\s+(browse|edit|write|run|execute|access)\b/i,
] as const
const EXTRACTED_NAME_STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"tool",
	"command",
	"capability",
	"access",
	"api",
	"service",
	"binary",
	"cli",
	"required",
	"missing",
	"needed",
	"available",
	"unavailable",
	"allowed",
	"not",
	"use",
])

type CorrectionKind = (typeof ALLOWED_KINDS)[number]
type SignalSource = "user-correction" | "same-agent-correction-loop" | "agent-stuck-state"
type ProposalStatus = "open" | "accepted" | "dismissed"
type EvalStatus = "pass" | "fail"
type ProposalHealthState = "awaiting-candidate" | "awaiting-eval" | "eval-failed" | "ready-to-accept"

type ProposalResolution = {
	actor: string
	reason: string
	recordedAt: number
}

type ProposalHealthSummary = {
	state: ProposalHealthState
	evalStatus?: EvalStatus
	isStale: boolean
	staleSince?: number
}

type SnapshotRecord = {
	version: 1
	id: string
	agent: string
	sha256: string
	relativePath: string
	absPath: string
	createdAt: number
	origin: "baseline" | "proposal-base" | "candidate"
	proposalID?: string
	note?: string
	contentPath: string
	metadataPath: string
}

export type SignalRecord = {
	version: 1
	id: string
	source: SignalSource
	agent: string
	kind: CorrectionKind
	summary: string
	normalizedSummary: string
	issueKey: string
	createdAt: number
	observedAt: number
	sessionID: string
	fingerprint: string
	metadata: Record<string, unknown>
}

export type EvalManifest = {
	version: 1
	proposalID: string
	targetAgent: string
	issueKey: string
	base: {
		snapshotID: string
		sha256: string
		path: string
	}
	candidate: {
		path: string
		snapshotID?: string
		sha256?: string
	}
	fixtures: Array<{
		id: string
		type: "text" | "path" | "signal"
		value: string
	}>
	expectedBehaviors: string[]
	passCriteria: string[]
	createdAt: number
	updatedAt: number
}

export type EvalResult = {
	version: 1
	proposalID: string
	targetAgent: string
	manifestPath: string
	baseSnapshotID: string
	candidateSnapshotID: string
	status: EvalStatus
	evaluator: string
	summary: string
	evidence: string[]
	recordedAt: number
}

export type ProposalRecord = {
	version: 1
	id: string
	status: ProposalStatus
	resolution?: ProposalResolution
	agent: string
	kind: CorrectionKind
	summary: string
	normalizedSummary: string
	issueKey: string
	createdAt: number
	updatedAt: number
	signalIDs: string[]
	signalCount: number
	userCorrectionCount: number
	baseSnapshotID: string
	candidateSnapshotID?: string
	evalManifestPath: string
	evalResultPath?: string
	files: {
		json: string
		markdown: string
	}
}

type SelfImproveSignalEvidence = {
	id: string
	source: SignalSource
	observedAt: number
	summary: string
	context?: string
}

type SelfImproveProposalReview = {
	proposalID: string
	agent: string
	kind: CorrectionKind
	summary: string
	health: ProposalHealthState
	evalStatus?: EvalStatus
	isStale: boolean
	staleSince?: number
	lastActivityAt: number
	createdAt: number
	updatedAt: number
	signalCount: number
	userCorrectionCount: number
	proposalPath: string
	proposalMarkdownPath: string
	evalManifestPath: string
	candidateSnapshotID?: string
	evalResultPath?: string
	lineageSnapshotID?: string
	lineageProposalID?: string
	signals: SelfImproveSignalEvidence[]
	nextSteps: string[]
}

type SelfImproveReview = {
	generatedAt: number
	capturedSignalCount: number
	openProposalCount: number
	staleOpenProposalCount: number
	acceptedProposalCount: number
	dismissedProposalCount: number
	agentsWithOpenProposals: string[]
	proposals: SelfImproveProposalReview[]
}

export type LineageRecord = {
	version: 1
	agent: string
	current: {
		snapshotID: string
		sha256: string
		relativePath: string
		acceptedAt: number
		proposalID?: string
		baseSnapshotID?: string
		candidateSnapshotID?: string
		evalManifestPath?: string
		evalResultPath?: string
		historyEntryID?: string
	}
	previous?: {
		snapshotID: string
		sha256: string
		relativePath: string
		acceptedAt: number
		proposalID?: string
		baseSnapshotID?: string
		candidateSnapshotID?: string
		evalManifestPath?: string
		evalResultPath?: string
		historyEntryID?: string
	}
	updatedAt: number
}

type HistoryEntry = {
	version: 1
	id: string
	action: "accept" | "rollback" | "dismiss"
	agent: string
	proposalID?: string
	fromSnapshotID?: string
	toSnapshotID?: string
	evalManifestPath?: string
	evalResultPath?: string
	actor: string
	reason: string
	recordedAt: number
}

type ParsedCorrectionBlock = {
	agent: string
	kind: CorrectionKind
	summary: string
	why?: string
	rawBlock: string
}

type SessionCorrectionContext = {
	signalID: string
	issueKey: string
	kind: CorrectionKind
	summary: string
	observedAt: number
}

type TaskInvocation = {
	callID: string
	observedAt: number
	retrySignal?: string
}

type DetectedTaskIssue = {
	category: "blocked-tool" | "permission" | "environment" | "capability" | "confusion" | "stuck"
	kind: CorrectionKind
	summary: string
	signature: string
	metadata: Record<string, unknown>
}

type AgentTracerServiceOptions = {
	profileRoot?: string
	directory?: string
	worktree?: string
	dataRoot?: string
	now?: () => number
	onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void> | void
}

type PluginConfig = Parameters<NonNullable<Hooks["config"]>>[0]

function registerSelfImproveCommand(input: PluginConfig): void {
	input.command ??= {}
	input.command[SELF_IMPROVE_COMMAND_NAME] = {
		template: SELF_IMPROVE_COMMAND_TEMPLATE,
		description: SELF_IMPROVE_COMMAND_DESCRIPTION,
	}
}

function createIssueKey(agent: string, kind: CorrectionKind, summary: string): string {
	return [agent, kind, normalizeSummary(summary)].join("::")
}

function normalizeAgentName(value: string): string {
	return value.trim().toLowerCase()
}

function normalizeSummary(value: string): string {
	return value
		.toLowerCase()
		.replace(/[`*_~]/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ")
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

function createArtifactID(prefix: string, seed: string, observedAt = Date.now()): string {
	const datePart = new Date(observedAt).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
	return `${prefix}-${datePart}-${sha256(seed).slice(0, 12)}`
}

function isAllowedKind(value: string): value is CorrectionKind {
	return ALLOWED_KINDS.includes(value as CorrectionKind)
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
	return part.type === "text" && typeof part.text === "string"
}

function toRelativePath(root: string, targetPath: string): string {
	return path.relative(root, targetPath) || "."
}

function toSessionAgentKey(sessionID: string, agent: string): string {
	return `${sessionID}::${agent}`
}

function formatJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

function resolveProfileRoot(options: AgentTracerServiceOptions): string {
	const explicitProfileRoot = options.profileRoot?.trim()
	if (explicitProfileRoot) {
		return path.resolve(explicitProfileRoot)
	}

	return path.resolve(process.cwd())
}

function resolveDataRoot(profileRoot: string, configuredDataRoot?: string): string {
	const candidate = configuredDataRoot?.trim()
	if (!candidate) {
		return path.join(profileRoot, ".agentTracer")
	}

	const resolved = path.resolve(profileRoot, candidate)
	const relativeToProfileRoot = path.relative(profileRoot, resolved)
	if (
		relativeToProfileRoot === ".." ||
		relativeToProfileRoot.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeToProfileRoot)
	) {
		throw new Error(`agentTracer data root must stay inside the current profile root: ${profileRoot}`)
	}

	return resolved
}

async function resolveEffectivePath(targetPath: string): Promise<string> {
	let currentPath = path.resolve(targetPath)
	const missingSegments: string[] = []

	while (!(await pathExists(currentPath))) {
		const parentPath = path.dirname(currentPath)
		if (parentPath === currentPath) {
			break
		}
		missingSegments.unshift(path.basename(currentPath))
		currentPath = parentPath
	}

	const resolvedExistingPath = await realpath(currentPath)
	return path.resolve(resolvedExistingPath, ...missingSegments)
}

async function assertPathStaysWithinRoot(rootPath: string, targetPath: string, label: string): Promise<void> {
	const resolvedRootPath = await realpath(rootPath)
	const resolvedTargetPath = await resolveEffectivePath(targetPath)
	const relativeToRoot = path.relative(resolvedRootPath, resolvedTargetPath)
	if (
		relativeToRoot === ".." ||
		relativeToRoot.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeToRoot)
	) {
		throw new Error(`agentTracer ${label} must stay inside the current profile root: ${resolvedRootPath}`)
	}
}

function hasCorrectiveRetrySignal(value?: string): boolean {
	if (!value) return false
	return CORRECTIVE_RETRY_PATTERN.test(value)
}

function extractRetrySignal(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return
	const args = value as { prompt?: unknown; description?: unknown }
	const pieces = [args.description, args.prompt]
		.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
		.map((item) => item.trim())
	if (pieces.length === 0) return
	return pieces.join("\n")
}

function extractBlockedToolName(value?: string): string | undefined {
	if (!value || !BLOCKED_TOOL_PATTERN.test(value)) return
	if (!BLOCKED_TOOL_CONTEXT_PATTERN.test(value)) return

	for (const pattern of BLOCKED_TOOL_NAME_PATTERNS) {
		const match = value.match(pattern)
		const toolName = normalizeExtractedName(match?.[1])
		if (toolName) return toolName
	}
}

function extractCapabilityName(value?: string): string | undefined {
	if (!value) return

	for (const pattern of CAPABILITY_NAME_PATTERNS) {
		const match = value.match(pattern)
		const capabilityName = normalizeExtractedName(match?.[1])
		if (capabilityName) return capabilityName
	}
}

function matchPatternTrigger(value: string | undefined, patterns: readonly NamedPattern[]): string | undefined {
	if (!value) return

	for (const { trigger, pattern } of patterns) {
		if (pattern.test(value)) return trigger
	}
}

function normalizeExtractedName(value: string | undefined): string | undefined {
	const normalizedValue = value?.trim().toLowerCase()
	if (!normalizedValue) return

	const token = normalizedValue
		.split(/\s+/)
		.find((part) => part && !EXTRACTED_NAME_STOP_WORDS.has(part))
	if (!token) return
	if (!/^[a-z0-9._-]+$/i.test(token)) return
	return token
}

function detectTaskIssue(agent: string, retrySignal?: string): DetectedTaskIssue | undefined {
	if (!retrySignal) return

	const blockedToolName = extractBlockedToolName(retrySignal)
	if (blockedToolName) {
		return {
			category: "blocked-tool",
			kind: "workflow",
			summary: `When ${agent} is blocked from using tool \`${blockedToolName}\`, stop retrying it and either switch to an allowed tool or explicitly request lifted permissions.`,
			signature: `blocked-tool:${blockedToolName}`,
			metadata: {
				blockedTool: blockedToolName,
				issueCategory: "blocked-tool",
			},
		}
	}

	if (BLOCKED_TOOL_CONTEXT_PATTERN.test(retrySignal)) {
		return {
			category: "blocked-tool",
			kind: "workflow",
			summary: `When ${agent} is blocked from using a disallowed or forbidden tool, stop retrying it and either switch to an allowed tool or explicitly request lifted permissions.`,
			signature: "blocked-tool:generic",
			metadata: {
				issueCategory: "blocked-tool",
			},
		}
	}

	const permissionTrigger = matchPatternTrigger(retrySignal, PERMISSION_PATTERNS)
	if (permissionTrigger) {
		return {
			category: "permission",
			kind: "workflow",
			summary: `When ${agent} hits permission or sandbox limits, stop and explicitly request the needed permission or choose an allowed fallback.`,
			signature: "permission-or-sandbox",
			metadata: {
				issueTrigger: permissionTrigger,
				issueCategory: "permission",
			},
		}
	}

	const environmentTrigger = matchPatternTrigger(retrySignal, ENVIRONMENT_PATTERNS)
	if (environmentTrigger) {
		return {
			category: "environment",
			kind: "workflow",
			summary: `When ${agent} is blocked by environment restrictions, explain the restriction clearly and request a different environment, lifted access, or the best allowed fallback.`,
			signature: "environment-restriction",
			metadata: {
				issueTrigger: environmentTrigger,
				issueCategory: "environment",
			},
		}
	}

	const capabilityTrigger = matchPatternTrigger(retrySignal, CAPABILITY_PATTERNS)
	if (capabilityTrigger) {
		const capabilityName = extractCapabilityName(retrySignal)
		return {
			category: "capability",
			kind: "workflow",
			summary: capabilityName
				? `When ${agent} lacks required capability \`${capabilityName}\`, say so explicitly and request it or choose an allowed fallback.`
				: `When ${agent} lacks a required tool or capability, say what is missing and request it or choose an allowed fallback.`,
				signature: `capability:${capabilityName ?? "generic"}`,
				metadata: {
					capability: capabilityName,
					issueTrigger: capabilityTrigger,
					issueCategory: "capability",
				},
			}
	}

	const confusionTrigger = matchPatternTrigger(retrySignal, CONFUSION_PATTERNS)
	if (confusionTrigger) {
		return {
			category: "confusion",
			kind: "instruction",
			summary: `When ${agent} is confused or missing critical context, state the gap clearly and ask a targeted clarification instead of guessing.`,
			signature: "confusion-or-missing-context",
			metadata: {
				issueTrigger: confusionTrigger,
				issueCategory: "confusion",
			},
		}
	}

	const stuckTrigger = matchPatternTrigger(retrySignal, STUCK_PATTERNS)
	if (stuckTrigger) {
		return {
			category: "stuck",
			kind: "communication",
			summary: `When ${agent} is stuck or unable to fulfill the request, stop looping and explain the unblock needed or the best available fallback.`,
			signature: "stuck-or-unfulfillable",
			metadata: {
				issueTrigger: stuckTrigger,
				issueCategory: "stuck",
			},
		}
	}
}

function shouldOpenProposal(signals: SignalRecord[]): boolean {
	if (signals.length < 2) return false

	const userCorrectionCount = signals.filter((signal) => signal.source === "user-correction").length
	const explicitCorrectionLoopCount = signals.filter(
		(signal) =>
			signal.source === "same-agent-correction-loop" &&
			signal.metadata.loopType === "explicit-corrective-retry",
	).length
	if (userCorrectionCount >= 1 && explicitCorrectionLoopCount >= 1) return true

	const autonomousIssueCount = signals.filter(
		(signal) =>
			signal.source === "agent-stuck-state" ||
			signal.metadata.loopType === "repeated-blocked-tool-misuse",
	).length
	return autonomousIssueCount >= 2
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath)
		return true
	} catch {
		return false
	}
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	if (!(await pathExists(filePath))) return
	const content = await readFile(filePath, "utf8")
	return JSON.parse(content) as T
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, formatJson(value), "utf8")
}

async function listJsonFiles(directory: string): Promise<string[]> {
	if (!(await pathExists(directory))) return []
	const entries: Dirent[] = await readdir(directory, { withFileTypes: true })
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(directory, entry.name))
		.sort()
}

async function readJsonDirectory<T>(directory: string): Promise<T[]> {
	const files = await listJsonFiles(directory)
	const loadedRecords = await Promise.all(files.map((filePath) => readJsonFile<T>(filePath)))
	const records: T[] = []
	for (const record of loadedRecords) {
		if (record) {
			records.push(record)
		}
	}
	return records
}

function parseKeyValueBlock(block: string): Record<string, string> {
	const parsed: Record<string, string> = {}
	for (const line of block.split("\n")) {
		const separatorIndex = line.indexOf(":")
		if (separatorIndex <= 0) continue
		const key = line.slice(0, separatorIndex).trim().toLowerCase()
		const value = line.slice(separatorIndex + 1).trim()
		if (!key || !value) continue
		parsed[key] = value
	}
	return parsed
}

function parseCorrectionBlocks(text: string): ParsedCorrectionBlock[] {
	const matches = text.matchAll(/```agenttracer-correction\s*\n([\s\S]*?)```/g)
	const parsedBlocks: ParsedCorrectionBlock[] = []

	for (const match of matches) {
		const rawBody = match[1]?.trim()
		if (!rawBody) continue

		const fields = parseKeyValueBlock(rawBody)
		const agent = normalizeAgentName(fields.agent ?? "")
		const kind = fields.kind?.trim().toLowerCase() ?? ""
		const summary = fields.summary?.trim()
		if (!agent || !summary || !isAllowedKind(kind)) continue

		parsedBlocks.push({
			agent,
			kind,
			summary,
			why: fields.why?.trim(),
			rawBlock: ["```agenttracer-correction", rawBody, "```"].join("\n"),
		})
	}

	return parsedBlocks
}

function buildExpectedBehaviors(summary: string): string[] {
	return [
		`Address the proposal intent: ${summary}`,
		"Preserve adjacent workflow and verification instructions unless the proposal explicitly changes them.",
		"Keep the resulting agent guidance local to this profile and reviewer-auditable.",
	]
}

function buildPassCriteria(): string[] {
	return [
		"Reviewer can trace the candidate snapshot, proposal, and eval manifest through stable file links.",
		"Candidate snapshot addresses the proposal without introducing unrelated prompt churn.",
		"Eval evidence explicitly references the manifest, base snapshot, and candidate snapshot.",
	]
}

function formatTimestamp(value: number): string {
	return new Date(value).toISOString()
}

function formatProposalHealth(value: ProposalHealthState): string {
	switch (value) {
		case "awaiting-candidate":
			return "awaiting candidate"
		case "awaiting-eval":
			return "awaiting eval"
		case "eval-failed":
			return "eval failed"
		case "ready-to-accept":
			return "ready to accept"
	}
}

function describeProposalHealth(
	proposal: ProposalRecord,
	evalResult: EvalResult | undefined,
	now: number,
): ProposalHealthSummary {
	const isStale = proposal.status === "open" && now - proposal.updatedAt >= PROPOSAL_STALE_WINDOW_MS
	const staleSince = isStale ? proposal.updatedAt + PROPOSAL_STALE_WINDOW_MS : undefined

	if (evalResult?.status === "fail") {
		return { state: "eval-failed", evalStatus: evalResult.status, isStale, staleSince }
	}

	if (evalResult?.status === "pass" && proposal.candidateSnapshotID) {
		return { state: "ready-to-accept", evalStatus: evalResult.status, isStale, staleSince }
	}

	if (proposal.candidateSnapshotID) {
		return { state: "awaiting-eval", isStale, staleSince }
	}

	return { state: "awaiting-candidate", isStale, staleSince }
}

function formatSignalContext(signal: SignalRecord): string | undefined {
	if (typeof signal.metadata.why === "string" && signal.metadata.why.trim()) {
		return signal.metadata.why.trim()
	}

	if (typeof signal.metadata.retrySignal === "string" && signal.metadata.retrySignal.trim()) {
		return `Retry signal: ${signal.metadata.retrySignal.trim()}`
	}

	if (typeof signal.metadata.loopType === "string" && signal.metadata.loopType.trim()) {
		return signal.metadata.loopType.trim()
	}
}

function renderSelfImproveReview(review: SelfImproveReview): string {
	const intro = [
		"# agentTracer self-improvement review",
		"",
		`Generated: ${formatTimestamp(review.generatedAt)}`,
		`Captured signals: ${review.capturedSignalCount}`,
		`Open proposals: ${review.openProposalCount}`,
		`Stale open proposals: ${review.staleOpenProposalCount}`,
		`Accepted proposals on record: ${review.acceptedProposalCount}`,
		`Dismissed proposals on record: ${review.dismissedProposalCount}`,
		`Agents with open proposals: ${review.agentsWithOpenProposals.length > 0 ? review.agentsWithOpenProposals.join(", ") : "none"}`,
		`Primary operator UX: run \`/${SELF_IMPROVE_COMMAND_NAME}\`. Use \`agenttracer_selfimprove\` only as the backend/manual fallback.`,
		"This entrypoint is read-only. It reviews existing evidence-backed proposals and does not edit files or mutate proposal, eval, lineage, or history state.",
	]

	if (review.proposals.length === 0) {
		return [
			...intro,
			"",
			"No open evidence-backed improvements are waiting for approval right now.",
			"If you expected a proposal, remember the threshold: at least 2 corroborating signals inside 30 days, usually a tagged user correction plus explicit corrective retry, or 2 aggressive stuck/unfulfillable signals for the same issue.",
			"Lineage/bootstrap remains lazy and profile-local: the first evidence-backed proposal initializes the baseline lineage for that agent.",
		].join("\n")
	}

	const sections = review.proposals.flatMap((proposal, index) => {
		const evidenceLines = proposal.signals.map((signal) => {
			const context = signal.context ? ` — ${signal.context}` : ""
			return `- ${signal.source} @ ${formatTimestamp(signal.observedAt)} (${signal.id}): ${signal.summary}${context}`
		})

		return [
			`## ${index + 1}. ${proposal.proposalID}`,
			"",
			`- Target agent: ${proposal.agent}`,
			`- Kind: ${proposal.kind}`,
			`- Summary: ${proposal.summary}`,
			`- Health: ${formatProposalHealth(proposal.health)}`,
			`- Eval status: ${proposal.evalStatus ?? "pending"}`,
			`- Stale: ${proposal.isStale ? `yes (since ${formatTimestamp(proposal.staleSince ?? proposal.updatedAt)})` : "no"}`,
			`- Last activity: ${formatTimestamp(proposal.lastActivityAt)}`,
			`- Created: ${formatTimestamp(proposal.createdAt)}`,
			`- Updated: ${formatTimestamp(proposal.updatedAt)}`,
			`- Evidence: ${proposal.signalCount} corroborating signals (${proposal.userCorrectionCount} tagged user correction${proposal.userCorrectionCount === 1 ? "" : "s"})`,
			`- Current lineage snapshot: ${proposal.lineageSnapshotID ?? "none recorded yet"}`,
			`- Current lineage proposal: ${proposal.lineageProposalID ?? "n/a"}`,
			`- Candidate snapshot: ${proposal.candidateSnapshotID ?? "pending"}`,
			`- Eval manifest: ${proposal.evalManifestPath}`,
			`- Eval result: ${proposal.evalResultPath ?? "pending"}`,
			`- Proposal JSON: ${proposal.proposalPath}`,
			`- Proposal Markdown: ${proposal.proposalMarkdownPath}`,
			"",
			"### Evidence",
			"",
			...evidenceLines,
			"",
			"### Next steps",
			"",
			...proposal.nextSteps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`),
			"",
		]
	})

	return [...intro, "", ...sections].join("\n")
}

function renderProposalMarkdown(
	proposal: ProposalRecord,
	signalMap: Map<string, SignalRecord>,
	health: ProposalHealthSummary | undefined,
): string {
	const signals = proposal.signalIDs
		.map((signalID) => signalMap.get(signalID))
		.filter((signal): signal is SignalRecord => Boolean(signal))
		.sort((left, right) => left.observedAt - right.observedAt)

	const signalLines = signals.map((signal) => {
		const why = typeof signal.metadata.why === "string" ? ` — ${signal.metadata.why}` : ""
		return `- ${signal.source} @ ${new Date(signal.observedAt).toISOString()} (${signal.id})${why}`
	})

	return [
		`# agentTracer proposal: ${proposal.id}`,
		"",
		`- Status: ${proposal.status}`,
		...(proposal.resolution
			? [
				`- Resolution actor: ${proposal.resolution.actor}`,
				`- Resolution recorded: ${formatTimestamp(proposal.resolution.recordedAt)}`,
				`- Resolution reason: ${proposal.resolution.reason}`,
			]
			: []),
		`- Agent: ${proposal.agent}`,
		`- Kind: ${proposal.kind}`,
		`- Issue key: ${proposal.issueKey}`,
		...(health
			? [
				`- Health: ${formatProposalHealth(health.state)}`,
				`- Eval status: ${health.evalStatus ?? "pending"}`,
				`- Stale: ${health.isStale ? `yes (since ${formatTimestamp(health.staleSince ?? proposal.updatedAt)})` : "no"}`,
			]
			: []),
		`- Created: ${new Date(proposal.createdAt).toISOString()}`,
		`- Updated: ${new Date(proposal.updatedAt).toISOString()}`,
		`- Base snapshot: ${proposal.baseSnapshotID}`,
		`- Candidate snapshot: ${proposal.candidateSnapshotID ?? "pending"}`,
		`- Eval manifest: ${proposal.evalManifestPath}`,
		`- Eval result: ${proposal.evalResultPath ?? "pending"}`,
		"",
		"## Summary",
		"",
		proposal.summary,
		"",
		"## Corroborating signals",
		"",
		...signalLines,
		"",
		"## Recommended workflow",
		"",
		...(proposal.status === "dismissed"
			? [
				"1. This proposal is dismissed and remains on disk only for auditability.",
				"2. If the issue resurfaces, new corroborating signals can open a fresh proposal for the same issue key.",
			]
			: [
				`1. Review-first path: run \`/${SELF_IMPROVE_COMMAND_NAME}\` to compare the current open evidence-backed proposals before choosing any follow-through work. If the slash command is unavailable, use \`agenttracer_selfimprove\` as the backend/manual fallback.`,
				`2. If this proposal is explicitly approved, update only \`agents/${proposal.agent}.md\` guidance needed for ${proposal.id}.`,
				`3. After the approved edit, run \`agenttracer_snapshot_candidate\` with proposal_id \`${proposal.id}\` to capture a candidate snapshot and refresh the eval manifest.`,
				"4. Run the manifest-guided verification manually, then record the result with `agenttracer_record_eval`.",
				"5. Only after explicit reviewer/human approval and a passing eval should you run `agenttracer_accept_proposal`; use `agenttracer_dismiss_proposal` only to explicitly close the proposal as obsolete/not worth pursuing, and `agenttracer_record_rollback` only for a documented restore.",
			]),
		"",
	].join("\n")
}

export function createAgentTracerService(options: AgentTracerServiceOptions = {}) {
	const profileRoot = resolveProfileRoot(options)
	const dataRoot = resolveDataRoot(profileRoot, options.dataRoot)
	const agentsDir = path.join(profileRoot, "agents")
	const signalsDir = path.join(dataRoot, "signals")
	const proposalsDir = path.join(dataRoot, "proposals")
	const evalsDir = path.join(dataRoot, "evals")
	const versionsDir = path.join(dataRoot, "versions")
	const lineageDir = path.join(dataRoot, "lineage")
	const historyDir = path.join(dataRoot, "history")
	const historyLedgerPath = path.join(historyDir, "ledger.jsonl")
	const knownAgents = new Set<string>()
	const lastTaskBySessionAgent = new Map<string, TaskInvocation>()
	const latestCorrectionBySessionAgent = new Map<string, SessionCorrectionContext>()
	let initPromise: Promise<void> | undefined
	const currentTime = (): number => options.now?.() ?? Date.now()

	const log = async (
		level: "debug" | "info" | "warn" | "error",
		message: string,
	): Promise<void> => {
		await options.onLog?.(level, message)
	}

	function createProposalResolution(actor: string, reason: string, recordedAt = currentTime()): ProposalResolution {
		const resolution = {
			actor: actor.trim(),
			reason: reason.trim(),
			recordedAt,
		} satisfies ProposalResolution
		if (!resolution.actor || !resolution.reason) {
			throw new Error("agentTracer actor and reason are required")
		}
		return resolution
	}

	function getProposalResolutionTime(proposal: ProposalRecord): number | undefined {
		if (proposal.status === "open") return
		return proposal.resolution?.recordedAt ?? proposal.updatedAt
	}

	function formatResolutionContext(proposal: ProposalRecord): string {
		if (!proposal.resolution) return `status ${proposal.status}`
		return `${proposal.status} by ${proposal.resolution.actor} at ${formatTimestamp(proposal.resolution.recordedAt)} (${proposal.resolution.reason})`
	}

	function assertProposalIsOpen(proposal: ProposalRecord, action: string): void {
		if (proposal.status === "open") return
		throw new Error(`agentTracer cannot ${action} proposal ${proposal.id}: it is already ${formatResolutionContext(proposal)}`)
	}

	async function ensureInitialized(): Promise<void> {
		if (!initPromise) {
			initPromise = (async () => {
			await assertPathStaysWithinRoot(profileRoot, dataRoot, "data root")
				await Promise.all([
					mkdir(signalsDir, { recursive: true }),
					mkdir(proposalsDir, { recursive: true }),
					mkdir(evalsDir, { recursive: true }),
					mkdir(versionsDir, { recursive: true }),
					mkdir(lineageDir, { recursive: true }),
					mkdir(historyDir, { recursive: true }),
				])

				if (!(await pathExists(agentsDir))) return
				const entries = await readdir(agentsDir, { withFileTypes: true })
				for (const entry of entries) {
					if (!entry.isFile() || !entry.name.endsWith(".md")) continue
					knownAgents.add(normalizeAgentName(entry.name.slice(0, -3)))
				}
			})()
		}

		await initPromise
	}

	function discoverAgent(agent: string): void {
		knownAgents.add(normalizeAgentName(agent))
	}

	function isKnownAgent(agent: string): boolean {
		return knownAgents.has(normalizeAgentName(agent))
	}

	function getAgentFilePath(agent: string): string {
		return path.join(agentsDir, `${agent}.md`)
	}

	function getSignalPath(signalID: string): string {
		return path.join(signalsDir, `${signalID}.json`)
	}

	function getProposalJsonPath(proposalID: string): string {
		return path.join(proposalsDir, `${proposalID}.json`)
	}

	function getProposalMarkdownPath(proposalID: string): string {
		return path.join(proposalsDir, `${proposalID}.md`)
	}

	function getEvalManifestPath(proposalID: string): string {
		return path.join(evalsDir, proposalID, "manifest.json")
	}

	function getEvalResultPath(proposalID: string): string {
		return path.join(evalsDir, proposalID, "result.json")
	}

	function getLineagePath(agent: string): string {
		return path.join(lineageDir, `${agent}.json`)
	}

	function resolveStoredPath(storedPath: string): string {
		return path.isAbsolute(storedPath) ? storedPath : path.join(profileRoot, storedPath)
	}

	function getSnapshotMetadataPath(agent: string, snapshotID: string): string {
		return path.join(versionsDir, agent, `${snapshotID}.json`)
	}

	function getSnapshotContentPath(agent: string, snapshotID: string): string {
		return path.join(versionsDir, agent, `${snapshotID}.md`)
	}

	async function loadSignals(): Promise<SignalRecord[]> {
		return readJsonDirectory<SignalRecord>(signalsDir)
	}

	async function loadProposals(): Promise<ProposalRecord[]> {
		return readJsonDirectory<ProposalRecord>(proposalsDir)
	}

	async function loadProposal(proposalID: string): Promise<ProposalRecord | undefined> {
		return readJsonFile<ProposalRecord>(getProposalJsonPath(proposalID))
	}

	async function loadLineage(agent: string): Promise<LineageRecord | undefined> {
		return readJsonFile<LineageRecord>(getLineagePath(agent))
	}

	async function loadSnapshot(agent: string, snapshotID: string): Promise<SnapshotRecord | undefined> {
		return readJsonFile<SnapshotRecord>(getSnapshotMetadataPath(agent, snapshotID))
	}

	async function loadEvalResultForProposal(proposal: ProposalRecord): Promise<EvalResult | undefined> {
		if (!proposal.evalResultPath) return
		const evalResult = await readJsonFile<EvalResult>(resolveStoredPath(proposal.evalResultPath))
		if (!evalResult) return
		if (evalResult.proposalID !== proposal.id) return
		if (evalResult.candidateSnapshotID !== proposal.candidateSnapshotID) return
		return evalResult
	}

	function getIssueEvidenceFloor(proposals: ProposalRecord[], issueKey: string): number | undefined {
		const resolvedAt = proposals
			.filter((proposal) => proposal.issueKey === issueKey && proposal.status !== "open")
			.map((proposal) => getProposalResolutionTime(proposal))
			.filter((value): value is number => typeof value === "number")
			.sort((left, right) => right - left)[0]
		return resolvedAt
	}

	function buildProposalNextSteps(proposal: ProposalRecord, health: ProposalHealthSummary): string[] {
		const steps = [
			`Prefer \`/${SELF_IMPROVE_COMMAND_NAME}\` for read-only review passes; use \`agenttracer_selfimprove\` only as the backend/manual fallback.`,
			`Review ${proposal.files.markdown} and decide whether ${proposal.id} should proceed.`,
		]

		if (health.isStale) {
			steps.push(
				`This proposal is stale after 14 days without activity. Either dismiss it with agenttracer_dismiss_proposal or refresh it with a newly approved candidate/eval pass.`,
			)
		}

		switch (health.state) {
			case "awaiting-candidate":
				steps.push(
					`Do not edit anything until a reviewer or human explicitly approves work on ${proposal.id}.`,
					`If approved, update only agents/${proposal.agent}.md for this proposal, then run agenttracer_snapshot_candidate with proposal_id ${proposal.id}.`,
					`Run the manifest at ${proposal.evalManifestPath} and record the result with agenttracer_record_eval.`,
				)
				break
			case "awaiting-eval":
				steps.push(
					`A candidate snapshot is already recorded for ${proposal.id}. Run the manifest at ${proposal.evalManifestPath} and record the result with agenttracer_record_eval.`,
				)
				break
			case "eval-failed":
				steps.push(
					`The latest recorded eval failed for ${proposal.id}. If the proposal still matters, update only agents/${proposal.agent}.md, rerun agenttracer_snapshot_candidate, and then record a fresh eval.`,
				)
				break
			case "ready-to-accept":
				steps.push(
					`A passing eval is already recorded for ${proposal.id}. Only after explicit reviewer/human approval should agenttracer_accept_proposal be used.`,
				)
				break
		}

		steps.push(
			"Use agenttracer_dismiss_proposal only to explicitly close an obsolete or no-longer-worth-pursuing proposal with an actor and reason.",
			"Use agenttracer_record_rollback only to document a manual restore after a previously accepted change is undone.",
		)

		return steps
	}

	async function requireSnapshotArtifact(
		agent: string,
		snapshotID: string,
		label: "base" | "candidate",
	): Promise<SnapshotRecord> {
		const snapshot = await loadSnapshot(agent, snapshotID)
		if (!snapshot) {
			throw new Error(`agentTracer fail-closed: missing ${label} snapshot ${snapshotID}`)
		}

		if (!(await pathExists(resolveStoredPath(snapshot.contentPath)))) {
			throw new Error(`agentTracer fail-closed: missing ${label} snapshot content for ${snapshotID}`)
		}
		if (!(await pathExists(resolveStoredPath(snapshot.metadataPath)))) {
			throw new Error(`agentTracer fail-closed: missing ${label} snapshot metadata for ${snapshotID}`)
		}

		return snapshot
	}

	async function findSnapshotByHash(agent: string, hash: string): Promise<SnapshotRecord | undefined> {
		const agentVersionDir = path.join(versionsDir, agent)
		const snapshots = await readJsonDirectory<SnapshotRecord>(agentVersionDir)
		return snapshots.find((snapshot) => snapshot.sha256 === hash)
	}

	async function appendHistory(entry: HistoryEntry): Promise<void> {
		await mkdir(historyDir, { recursive: true })
		await appendFile(historyLedgerPath, `${JSON.stringify(entry)}\n`, "utf8")
	}

	async function ensureAgentFile(agent: string): Promise<string> {
		const agentPath = getAgentFilePath(agent)
		if (!(await pathExists(agentPath))) {
			throw new Error(`agentTracer requires agents/${agent}.md to exist for ${agent}`)
		}
		return agentPath
	}

	async function snapshotAgent(options: {
		agent: string
		origin: SnapshotRecord["origin"]
		proposalID?: string
		note?: string
	}): Promise<SnapshotRecord> {
		await ensureInitialized()
		const agentPath = await ensureAgentFile(options.agent)
		const content = await readFile(agentPath, "utf8")
		const hash = sha256(content)
		const existingSnapshot = await findSnapshotByHash(options.agent, hash)
		if (existingSnapshot) return existingSnapshot

		const snapshotCreatedAt = currentTime()
		const snapshotID = createArtifactID(
			"snapshot",
			`${options.agent}:${options.origin}:${hash}:${options.proposalID ?? ""}`,
			snapshotCreatedAt,
		)
		const contentPath = getSnapshotContentPath(options.agent, snapshotID)
		const metadataPath = getSnapshotMetadataPath(options.agent, snapshotID)
		const snapshot: SnapshotRecord = {
			version: DATA_VERSION,
			id: snapshotID,
			agent: options.agent,
			sha256: hash,
			relativePath: toRelativePath(profileRoot, agentPath),
			absPath: agentPath,
			createdAt: snapshotCreatedAt,
			origin: options.origin,
			proposalID: options.proposalID,
			note: options.note,
			contentPath: toRelativePath(profileRoot, contentPath),
			metadataPath: toRelativePath(profileRoot, metadataPath),
		}

		await mkdir(path.dirname(contentPath), { recursive: true })
		await Promise.all([
			writeFile(contentPath, content, "utf8"),
			writeJsonFile(metadataPath, snapshot),
		])

		return snapshot
	}

	async function ensureBaselineLineage(agent: string, baselineSnapshot: SnapshotRecord): Promise<void> {
		const lineagePath = getLineagePath(agent)
		if (await pathExists(lineagePath)) return

		const now = currentTime()
		const baseline: LineageRecord = {
			version: DATA_VERSION,
			agent,
			current: {
				snapshotID: baselineSnapshot.id,
				sha256: baselineSnapshot.sha256,
				relativePath: baselineSnapshot.relativePath,
				acceptedAt: now,
			},
			updatedAt: now,
		}

		await writeJsonFile(lineagePath, baseline)
	}

	async function writeProposalArtifacts(proposal: ProposalRecord): Promise<void> {
		const signalMap = new Map((await loadSignals()).map((signal) => [signal.id, signal]))
		const evalResult = await loadEvalResultForProposal(proposal)
		const health = proposal.status === "open" ? describeProposalHealth(proposal, evalResult, currentTime()) : undefined
		await Promise.all([
			writeJsonFile(getProposalJsonPath(proposal.id), proposal),
			writeFile(
				getProposalMarkdownPath(proposal.id),
				renderProposalMarkdown(proposal, signalMap, health),
				"utf8",
			),
		])
	}

	async function createEvalManifest(proposal: ProposalRecord, baseSnapshot: SnapshotRecord): Promise<EvalManifest> {
		const manifestPath = getEvalManifestPath(proposal.id)
		const now = currentTime()
		const manifest: EvalManifest = {
			version: DATA_VERSION,
			proposalID: proposal.id,
			targetAgent: proposal.agent,
			issueKey: proposal.issueKey,
			base: {
				snapshotID: baseSnapshot.id,
				sha256: baseSnapshot.sha256,
				path: baseSnapshot.relativePath,
			},
			candidate: {
				path: toRelativePath(profileRoot, getAgentFilePath(proposal.agent)),
			},
			fixtures: [
				{ id: "proposal-summary", type: "text", value: proposal.summary },
				{ id: "agent-file", type: "path", value: toRelativePath(profileRoot, getAgentFilePath(proposal.agent)) },
				{ id: "corroborating-signals", type: "signal", value: proposal.signalIDs.join(",") },
			],
			expectedBehaviors: buildExpectedBehaviors(proposal.summary),
			passCriteria: buildPassCriteria(),
			createdAt: now,
			updatedAt: now,
		}

		await writeJsonFile(manifestPath, manifest)
		return manifest
	}

	async function updateEvalManifestCandidate(
		proposal: ProposalRecord,
		candidateSnapshot: SnapshotRecord,
	): Promise<EvalManifest> {
		const manifestPath = getEvalManifestPath(proposal.id)
		const manifest = await readJsonFile<EvalManifest>(manifestPath)
		if (!manifest) {
			throw new Error(`agentTracer could not find eval manifest for ${proposal.id}`)
		}

		const updatedManifest: EvalManifest = {
			...manifest,
			candidate: {
				path: candidateSnapshot.relativePath,
				snapshotID: candidateSnapshot.id,
				sha256: candidateSnapshot.sha256,
			},
			updatedAt: currentTime(),
		}

		await writeJsonFile(manifestPath, updatedManifest)
		return updatedManifest
	}

	async function recordSignal(signal: SignalRecord): Promise<SignalRecord> {
		const existingSignals = await loadSignals()
		const existingSignal = existingSignals.find((candidate) => candidate.fingerprint === signal.fingerprint)
		if (existingSignal) return existingSignal

		await writeJsonFile(getSignalPath(signal.id), signal)
		await maybeUpsertProposal(signal)
		return signal
	}

	async function maybeUpsertProposal(triggerSignal: SignalRecord): Promise<void> {
		const now = currentTime()
		const cutoff = now - SIGNAL_WINDOW_MS
		const proposals = await loadProposals()
		const evidenceFloor = getIssueEvidenceFloor(proposals, triggerSignal.issueKey)
		const signals = (await loadSignals())
			.filter((signal) => signal.issueKey === triggerSignal.issueKey && signal.observedAt >= cutoff)
			.filter((signal) => !evidenceFloor || signal.observedAt > evidenceFloor)
			.sort((left, right) => left.observedAt - right.observedAt)

		const userCorrectionCount = signals.filter((signal) => signal.source === "user-correction").length
		if (!shouldOpenProposal(signals)) return

		const openProposal = proposals.find(
			(proposal) => proposal.issueKey === triggerSignal.issueKey && proposal.status === "open",
		)

		if (openProposal) {
			const mergedProposal: ProposalRecord = {
				...openProposal,
				signalIDs: Array.from(new Set([...openProposal.signalIDs, ...signals.map((signal) => signal.id)])),
				signalCount: signals.length,
				userCorrectionCount,
				updatedAt: now,
			}
			await writeProposalArtifacts(mergedProposal)
			return
		}

		const proposalID = createArtifactID("proposal", `${triggerSignal.issueKey}:${signals.map((signal) => signal.id).join(":")}`)
		const baseSnapshot = await snapshotAgent({
			agent: triggerSignal.agent,
			origin: "proposal-base",
			proposalID,
			note: `Base snapshot for ${proposalID}`,
		})
		await ensureBaselineLineage(triggerSignal.agent, baseSnapshot)

		const proposal: ProposalRecord = {
			version: DATA_VERSION,
			id: proposalID,
			status: "open",
			agent: triggerSignal.agent,
			kind: triggerSignal.kind,
			summary: triggerSignal.summary,
			normalizedSummary: triggerSignal.normalizedSummary,
			issueKey: triggerSignal.issueKey,
			createdAt: now,
			updatedAt: now,
			signalIDs: signals.map((signal) => signal.id),
			signalCount: signals.length,
			userCorrectionCount,
			baseSnapshotID: baseSnapshot.id,
			evalManifestPath: toRelativePath(profileRoot, getEvalManifestPath(proposalID)),
			files: {
				json: toRelativePath(profileRoot, getProposalJsonPath(proposalID)),
				markdown: toRelativePath(profileRoot, getProposalMarkdownPath(proposalID)),
			},
		}

		await createEvalManifest(proposal, baseSnapshot)
		await writeProposalArtifacts(proposal)
		await log("info", `agentTracer opened proposal ${proposal.id} for ${proposal.issueKey}`)
	}

	async function observeCorrectionBlock(input: {
		agent: string
		kind: CorrectionKind
		summary: string
		why?: string
		rawBlock: string
		sessionID: string
		messageID?: string
		observedAt?: number
	}): Promise<SignalRecord | undefined> {
		await ensureInitialized()
		const agent = normalizeAgentName(input.agent)
		if (!isKnownAgent(agent)) {
			await log("warn", `agentTracer ignored correction for unknown agent '${agent}'`)
			return
		}

		const observedAt = input.observedAt ?? currentTime()
		const signal: SignalRecord = {
			version: DATA_VERSION,
			id: createArtifactID("signal", `${agent}:${input.kind}:${input.summary}:${input.sessionID}:${input.messageID ?? "message"}`, observedAt),
			source: "user-correction",
			agent,
			kind: input.kind,
			summary: input.summary,
			normalizedSummary: normalizeSummary(input.summary),
			issueKey: createIssueKey(agent, input.kind, input.summary),
			createdAt: currentTime(),
			observedAt,
			sessionID: input.sessionID,
			fingerprint: sha256(`user-correction:${agent}:${input.kind}:${input.summary}:${input.sessionID}:${input.messageID ?? "message"}`),
			metadata: {
				messageID: input.messageID,
				why: input.why,
				rawBlock: input.rawBlock,
				contract: CORRECTION_BLOCK_NAME,
			},
		}

		const recordedSignal = await recordSignal(signal)
		latestCorrectionBySessionAgent.set(toSessionAgentKey(input.sessionID, agent), {
			signalID: recordedSignal.id,
			issueKey: recordedSignal.issueKey,
			kind: recordedSignal.kind,
			summary: recordedSignal.summary,
			observedAt: recordedSignal.observedAt,
		})

		return recordedSignal
	}

	async function observeTaskInvocation(input: {
		agent: string
		sessionID: string
		callID: string
		retrySignal?: string
		observedAt?: number
	}): Promise<SignalRecord | undefined> {
		await ensureInitialized()
		const agent = normalizeAgentName(input.agent)
		discoverAgent(agent)

		const observedAt = input.observedAt ?? currentTime()
		const sessionAgentKey = toSessionAgentKey(input.sessionID, agent)
		const previousInvocation = lastTaskBySessionAgent.get(sessionAgentKey)
		const correctionContext = latestCorrectionBySessionAgent.get(sessionAgentKey)
		const detectedIssue = detectTaskIssue(agent, input.retrySignal)

		lastTaskBySessionAgent.set(sessionAgentKey, {
			callID: input.callID,
			observedAt,
			retrySignal: input.retrySignal,
		})
		let recordedIssueSignal: SignalRecord | undefined

		if (detectedIssue) {
			const isRepeatedIssueLoop =
				previousInvocation &&
				detectTaskIssue(agent, previousInvocation.retrySignal)?.signature === detectedIssue.signature &&
				observedAt > previousInvocation.observedAt
			const signal: SignalRecord = {
				version: DATA_VERSION,
				id: createArtifactID(
					"signal",
					`${agent}:${detectedIssue.signature}:${input.sessionID}:${input.callID}`,
					observedAt,
				),
				source: "agent-stuck-state",
				agent,
				kind: detectedIssue.kind,
				summary: detectedIssue.summary,
				normalizedSummary: normalizeSummary(detectedIssue.summary),
				issueKey: createIssueKey(agent, detectedIssue.kind, detectedIssue.summary),
				createdAt: currentTime(),
				observedAt,
				sessionID: input.sessionID,
				fingerprint: sha256(`agent-stuck-state:${agent}:${input.sessionID}:${detectedIssue.signature}:${input.callID}`),
				metadata: {
					previousCallID: previousInvocation?.callID,
					previousInvocationObservedAt: previousInvocation?.observedAt,
					previousRetrySignal: previousInvocation?.retrySignal,
					loopType: isRepeatedIssueLoop ? "repeated-agent-stuck-state" : undefined,
					currentCallID: input.callID,
					currentInvocationObservedAt: observedAt,
					retrySignal: input.retrySignal,
					...detectedIssue.metadata,
				},
			}

			recordedIssueSignal = await recordSignal(signal)
		}

		if (!previousInvocation || !correctionContext) return recordedIssueSignal
		if (correctionContext.observedAt <= previousInvocation.observedAt) return recordedIssueSignal
		if (observedAt <= correctionContext.observedAt) return recordedIssueSignal
		if (!hasCorrectiveRetrySignal(input.retrySignal)) return recordedIssueSignal

		latestCorrectionBySessionAgent.delete(sessionAgentKey)
		const signal: SignalRecord = {
			version: DATA_VERSION,
			id: createArtifactID(
				"signal",
				`${agent}:${correctionContext.issueKey}:${previousInvocation.callID}:${input.callID}`,
				observedAt,
			),
			source: "same-agent-correction-loop",
			agent,
			kind: correctionContext.kind,
			summary: correctionContext.summary,
			normalizedSummary: normalizeSummary(correctionContext.summary),
			issueKey: correctionContext.issueKey,
			createdAt: currentTime(),
			observedAt,
			sessionID: input.sessionID,
			fingerprint: sha256(`same-agent-correction-loop:${agent}:${input.sessionID}:${correctionContext.signalID}:${input.callID}`),
			metadata: {
				previousCallID: previousInvocation.callID,
				previousInvocationObservedAt: previousInvocation.observedAt,
				previousRetrySignal: previousInvocation.retrySignal,
				currentCallID: input.callID,
				currentInvocationObservedAt: observedAt,
				retrySignal: input.retrySignal,
				correctionObservedAt: correctionContext.observedAt,
				triggerSignalID: correctionContext.signalID,
				loopType: "explicit-corrective-retry",
			},
		}

		return recordSignal(signal)
	}

	async function captureUserMessage(input: {
		sessionID: string
		messageID?: string
		text: string
		observedAt?: number
	}): Promise<SignalRecord[]> {
		await ensureInitialized()
		const blocks = parseCorrectionBlocks(input.text)
		const signals: SignalRecord[] = []
		for (const block of blocks) {
			const signal = await observeCorrectionBlock({
				...block,
				sessionID: input.sessionID,
				messageID: input.messageID,
				observedAt: input.observedAt,
			})
			if (signal) signals.push(signal)
		}
		return signals
	}

	async function snapshotCandidate(proposalID: string, note?: string): Promise<{
		proposal: ProposalRecord
		candidate: SnapshotRecord
		manifest: EvalManifest
	}> {
		await ensureInitialized()
		const proposal = await loadProposal(proposalID)
		if (!proposal) throw new Error(`agentTracer could not find proposal ${proposalID}`)
		assertProposalIsOpen(proposal, "snapshot candidate for")
		const baseSnapshot = await requireSnapshotArtifact(proposal.agent, proposal.baseSnapshotID, "base")

		const candidate = await snapshotAgent({
			agent: proposal.agent,
			origin: "candidate",
			proposalID,
			note: note ?? `Candidate snapshot for ${proposalID}`,
		})
		if (candidate.id === baseSnapshot.id || candidate.sha256 === baseSnapshot.sha256) {
			throw new Error(`agentTracer requires a candidate snapshot distinct from the base snapshot for ${proposalID}`)
		}
		const manifest = await updateEvalManifestCandidate(proposal, candidate)
		const updatedProposal: ProposalRecord = {
			...proposal,
			candidateSnapshotID: candidate.id,
			evalResultPath: undefined,
			updatedAt: currentTime(),
		}
		await writeProposalArtifacts(updatedProposal)
		return { proposal: updatedProposal, candidate, manifest }
	}

	async function recordEval(input: {
		proposalID: string
		status: EvalStatus
		evaluator: string
		summary: string
		evidence?: string[]
	}): Promise<EvalResult> {
		await ensureInitialized()
		const proposal = await loadProposal(input.proposalID)
		if (!proposal) throw new Error(`agentTracer could not find proposal ${input.proposalID}`)
		assertProposalIsOpen(proposal, "record eval for")
		if (!proposal.candidateSnapshotID) {
			throw new Error(`agentTracer requires a candidate snapshot before recording eval for ${input.proposalID}`)
		}

		const manifest = await readJsonFile<EvalManifest>(getEvalManifestPath(input.proposalID))
		if (!manifest?.candidate.snapshotID || !manifest.candidate.sha256) {
			throw new Error(`agentTracer requires a complete eval manifest before recording eval for ${input.proposalID}`)
		}

		const result: EvalResult = {
			version: DATA_VERSION,
			proposalID: proposal.id,
			targetAgent: proposal.agent,
			manifestPath: toRelativePath(profileRoot, getEvalManifestPath(proposal.id)),
			baseSnapshotID: proposal.baseSnapshotID,
			candidateSnapshotID: proposal.candidateSnapshotID,
			status: input.status,
			evaluator: input.evaluator.trim(),
			summary: input.summary.trim(),
			evidence: input.evidence?.map((item) => item.trim()).filter(Boolean) ?? [],
			recordedAt: currentTime(),
		}

		if (!result.evaluator) throw new Error("agentTracer evaluator is required")
		if (!result.summary) throw new Error("agentTracer eval summary is required")

		await writeJsonFile(getEvalResultPath(proposal.id), result)
		const updatedProposal: ProposalRecord = {
			...proposal,
			evalResultPath: toRelativePath(profileRoot, getEvalResultPath(proposal.id)),
			updatedAt: result.recordedAt,
		}
		await writeProposalArtifacts(updatedProposal)
		return result
	}

	async function acceptProposal(input: {
		proposalID: string
		actor: string
		reason: string
	}): Promise<{ proposal: ProposalRecord; lineage: LineageRecord; history: HistoryEntry }> {
		await ensureInitialized()
		const proposal = await loadProposal(input.proposalID)
		if (!proposal) throw new Error(`agentTracer could not find proposal ${input.proposalID}`)
		assertProposalIsOpen(proposal, "accept")

		const manifest = await readJsonFile<EvalManifest>(getEvalManifestPath(proposal.id))
		const evalResult = await readJsonFile<EvalResult>(getEvalResultPath(proposal.id))
		if (!proposal.baseSnapshotID || !proposal.candidateSnapshotID || !manifest || !evalResult) {
			throw new Error(`agentTracer fail-closed: incomplete acceptance lineage for ${proposal.id}`)
		}
		const baseSnapshot = await requireSnapshotArtifact(proposal.agent, proposal.baseSnapshotID, "base")
		const candidateSnapshot = await requireSnapshotArtifact(
			proposal.agent,
			proposal.candidateSnapshotID,
			"candidate",
		)
		if (!manifest.base.snapshotID || !manifest.candidate.snapshotID || !manifest.candidate.sha256) {
			throw new Error(`agentTracer fail-closed: manifest links are incomplete for ${proposal.id}`)
		}
		if (
			manifest.proposalID !== proposal.id ||
			manifest.base.snapshotID !== proposal.baseSnapshotID ||
			manifest.candidate.snapshotID !== proposal.candidateSnapshotID
		) {
			throw new Error(`agentTracer fail-closed: manifest does not match proposal lineage for ${proposal.id}`)
		}
		if (
			evalResult.proposalID !== proposal.id ||
			evalResult.baseSnapshotID !== proposal.baseSnapshotID ||
			evalResult.candidateSnapshotID !== proposal.candidateSnapshotID ||
			evalResult.manifestPath !== toRelativePath(profileRoot, getEvalManifestPath(proposal.id)) ||
			evalResult.status !== "pass"
		) {
			throw new Error(`agentTracer fail-closed: eval result is incomplete or failing for ${proposal.id}`)
		}
		if (
			manifest.base.sha256 !== baseSnapshot.sha256 ||
			manifest.candidate.sha256 !== candidateSnapshot.sha256
		) {
			throw new Error(`agentTracer fail-closed: manifest hashes do not match stored snapshots for ${proposal.id}`)
		}
		if (candidateSnapshot.id === baseSnapshot.id || candidateSnapshot.sha256 === baseSnapshot.sha256) {
			throw new Error(`agentTracer fail-closed: candidate snapshot must differ from base snapshot for ${proposal.id}`)
		}

		const lineagePath = getLineagePath(proposal.agent)
		const lineage = (await loadLineage(proposal.agent)) ?? (() => {
			throw new Error(`agentTracer fail-closed: missing lineage file for ${proposal.agent}`)
		})()
		const resolution = createProposalResolution(input.actor, input.reason)

		const historyEntry: HistoryEntry = {
			version: DATA_VERSION,
			id: createArtifactID("history", `${proposal.id}:${proposal.candidateSnapshotID}:${resolution.actor}`, resolution.recordedAt),
			action: "accept",
			agent: proposal.agent,
			proposalID: proposal.id,
			fromSnapshotID: lineage.current.snapshotID,
			toSnapshotID: proposal.candidateSnapshotID,
			evalManifestPath: toRelativePath(profileRoot, getEvalManifestPath(proposal.id)),
			evalResultPath: toRelativePath(profileRoot, getEvalResultPath(proposal.id)),
			actor: resolution.actor,
			reason: resolution.reason,
			recordedAt: resolution.recordedAt,
		}

		const updatedLineage: LineageRecord = {
			...lineage,
			previous: lineage.current,
			current: {
				snapshotID: candidateSnapshot.id,
				sha256: candidateSnapshot.sha256,
				relativePath: candidateSnapshot.relativePath,
				acceptedAt: historyEntry.recordedAt,
				proposalID: proposal.id,
				baseSnapshotID: proposal.baseSnapshotID,
				candidateSnapshotID: proposal.candidateSnapshotID,
				evalManifestPath: historyEntry.evalManifestPath,
				evalResultPath: historyEntry.evalResultPath,
				historyEntryID: historyEntry.id,
			},
			updatedAt: historyEntry.recordedAt,
		}

		const updatedProposal: ProposalRecord = {
			...proposal,
			status: "accepted",
			resolution,
			evalResultPath: historyEntry.evalResultPath,
			updatedAt: historyEntry.recordedAt,
		}

		await Promise.all([
			writeJsonFile(lineagePath, updatedLineage),
			appendHistory(historyEntry),
			writeProposalArtifacts(updatedProposal),
		])

		return { proposal: updatedProposal, lineage: updatedLineage, history: historyEntry }
	}

	async function dismissProposal(input: {
		proposalID: string
		actor: string
		reason: string
	}): Promise<{ proposal: ProposalRecord; history: HistoryEntry }> {
		await ensureInitialized()
		const proposal = await loadProposal(input.proposalID)
		if (!proposal) throw new Error(`agentTracer could not find proposal ${input.proposalID}`)
		assertProposalIsOpen(proposal, "dismiss")

		const resolution = createProposalResolution(input.actor, input.reason)
		const historyEntry: HistoryEntry = {
			version: DATA_VERSION,
			id: createArtifactID("history", `${proposal.id}:${resolution.actor}:dismiss`, resolution.recordedAt),
			action: "dismiss",
			agent: proposal.agent,
			proposalID: proposal.id,
			actor: resolution.actor,
			reason: resolution.reason,
			recordedAt: resolution.recordedAt,
		}

		const updatedProposal: ProposalRecord = {
			...proposal,
			status: "dismissed",
			resolution,
			updatedAt: resolution.recordedAt,
		}

		await Promise.all([appendHistory(historyEntry), writeProposalArtifacts(updatedProposal)])
		await log("info", `agentTracer dismissed proposal ${updatedProposal.id} for ${updatedProposal.issueKey}`)
		return { proposal: updatedProposal, history: historyEntry }
	}

	async function recordRollback(input: {
		agent: string
		restoredSnapshotID: string
		actor: string
		reason: string
		evalResultPath?: string
	}): Promise<{ lineage: LineageRecord; history: HistoryEntry }> {
		await ensureInitialized()
		const agent = normalizeAgentName(input.agent)
		const lineage = await loadLineage(agent)
		if (!lineage) throw new Error(`agentTracer could not find lineage for ${agent}`)

		const restoredSnapshot = await loadSnapshot(agent, input.restoredSnapshotID)
		if (!restoredSnapshot) {
			throw new Error(`agentTracer could not find snapshot ${input.restoredSnapshotID} for ${agent}`)
		}

		const currentAgentPath = await ensureAgentFile(agent)
		const currentHash = sha256(await readFile(currentAgentPath, "utf8"))
		if (currentHash !== restoredSnapshot.sha256) {
			throw new Error(`agentTracer rollback requires agents/${agent}.md to match snapshot ${input.restoredSnapshotID}`)
		}
		const resolution = createProposalResolution(input.actor, input.reason)

		const historyEntry: HistoryEntry = {
			version: DATA_VERSION,
			id: createArtifactID("history", `${agent}:${input.restoredSnapshotID}:${resolution.actor}:rollback`, resolution.recordedAt),
			action: "rollback",
			agent,
			fromSnapshotID: lineage.current.snapshotID,
			toSnapshotID: input.restoredSnapshotID,
			evalResultPath: input.evalResultPath,
			actor: resolution.actor,
			reason: resolution.reason,
			recordedAt: resolution.recordedAt,
		}

		const updatedLineage: LineageRecord = {
			...lineage,
			previous: lineage.current,
			current: {
				snapshotID: restoredSnapshot.id,
				sha256: restoredSnapshot.sha256,
				relativePath: restoredSnapshot.relativePath,
				acceptedAt: historyEntry.recordedAt,
				evalResultPath: input.evalResultPath,
				historyEntryID: historyEntry.id,
			},
			updatedAt: historyEntry.recordedAt,
		}

		await Promise.all([
			writeJsonFile(getLineagePath(agent), updatedLineage),
			appendHistory(historyEntry),
		])

		return { lineage: updatedLineage, history: historyEntry }
	}

	async function getState(): Promise<{
		knownAgents: string[]
		signals: SignalRecord[]
		proposals: ProposalRecord[]
	}> {
		await ensureInitialized()
		return {
			knownAgents: Array.from(knownAgents).sort(),
			signals: await loadSignals(),
			proposals: await loadProposals(),
		}
	}

	async function reviewOpenImprovements(): Promise<SelfImproveReview> {
		await ensureInitialized()
		const [signals, proposals] = await Promise.all([loadSignals(), loadProposals()])
		const signalMap = new Map(signals.map((signal) => [signal.id, signal]))
		const now = currentTime()
		const openProposals = proposals
			.filter((proposal) => proposal.status === "open")
			.sort((left, right) => right.updatedAt - left.updatedAt)
		const [acceptedProposalCount, dismissedProposalCount] = [
			proposals.filter((proposal) => proposal.status === "accepted").length,
			proposals.filter((proposal) => proposal.status === "dismissed").length,
		]

		const lineageEntries = await Promise.all(
			Array.from(new Set(openProposals.map((proposal) => proposal.agent))).map(async (agent) => [
				agent,
				await loadLineage(agent),
			] as const),
		)
		const lineageByAgent = new Map(lineageEntries)
		const evalResultsByProposal = new Map(
			await Promise.all(
				openProposals.map(async (proposal) => [proposal.id, await loadEvalResultForProposal(proposal)] as const),
			),
		)

		const reviewProposals = openProposals.map((proposal) => {
			const lineage = lineageByAgent.get(proposal.agent)
			const evalResult = evalResultsByProposal.get(proposal.id)
			const health = describeProposalHealth(proposal, evalResult, now)
			const proposalSignals = proposal.signalIDs
				.map((signalID) => signalMap.get(signalID))
				.filter((signal): signal is SignalRecord => Boolean(signal))
				.sort((left, right) => left.observedAt - right.observedAt)

			return {
				proposalID: proposal.id,
				agent: proposal.agent,
				kind: proposal.kind,
				summary: proposal.summary,
				health: health.state,
				evalStatus: health.evalStatus,
				isStale: health.isStale,
				staleSince: health.staleSince,
				lastActivityAt: evalResult ? Math.max(proposal.updatedAt, evalResult.recordedAt) : proposal.updatedAt,
				createdAt: proposal.createdAt,
				updatedAt: proposal.updatedAt,
				signalCount: proposal.signalCount,
				userCorrectionCount: proposal.userCorrectionCount,
				proposalPath: proposal.files.json,
				proposalMarkdownPath: proposal.files.markdown,
				evalManifestPath: proposal.evalManifestPath,
				candidateSnapshotID: proposal.candidateSnapshotID,
				evalResultPath: proposal.evalResultPath,
				lineageSnapshotID: lineage?.current.snapshotID,
				lineageProposalID: lineage?.current.proposalID,
				signals: proposalSignals.map((signal) => ({
					id: signal.id,
					source: signal.source,
					observedAt: signal.observedAt,
					summary: signal.summary,
					context: formatSignalContext(signal),
				})),
				nextSteps: buildProposalNextSteps(proposal, health),
			} satisfies SelfImproveProposalReview
		})

		return {
			generatedAt: now,
			capturedSignalCount: signals.length,
			openProposalCount: reviewProposals.length,
			staleOpenProposalCount: reviewProposals.filter((proposal) => proposal.isStale).length,
			acceptedProposalCount,
			dismissedProposalCount,
			agentsWithOpenProposals: Array.from(new Set(reviewProposals.map((proposal) => proposal.agent))).sort(),
			proposals: reviewProposals,
		}
	}

	return {
		paths: {
			profileRoot,
			dataRoot,
			signalsDir,
			proposalsDir,
			evalsDir,
			versionsDir,
			lineageDir,
			historyDir,
			historyLedgerPath,
		},
		ensureInitialized,
		captureUserMessage,
		observeCorrectionBlock,
		observeTaskInvocation,
		snapshotCandidate,
		recordEval,
		acceptProposal,
		dismissProposal,
		recordRollback,
		getState,
		reviewOpenImprovements,
	}
}

export const AgentTracerPlugin: Plugin = async ({ client, directory, worktree }) => {
	const service = createAgentTracerService({
		directory,
		worktree,
		onLog: async (level, message) => {
			await client.app.log({ body: { service: "agentTracer", level, message } }).catch(() => {})
		},
	})

	await service.ensureInitialized()

	return {
		config: async (input) => {
			registerSelfImproveCommand(input)
		},
		tool: {
			agenttracer_selfimprove: tool({
				description: "Review open evidence-backed agentTracer improvements and proposal health without mutating state",
				args: {},
				execute: async () => renderSelfImproveReview(await service.reviewOpenImprovements()),
			}),
			agenttracer_snapshot_candidate: tool({
				description: "Snapshot current agent candidate for an open agentTracer proposal",
				args: {
					proposal_id: tool.schema.string().min(1),
					note: tool.schema.string().optional(),
				},
				execute: async (args) => {
					const result = await service.snapshotCandidate(args.proposal_id, args.note)
					return [
						`Captured candidate snapshot ${result.candidate.id} for ${result.proposal.id}.`,
						`Manifest: ${result.proposal.evalManifestPath}`,
					].join(" ")
				},
			}),
			agenttracer_record_eval: tool({
				description: "Record a manual eval result for an agentTracer proposal",
				args: {
					proposal_id: tool.schema.string().min(1),
					status: tool.schema.enum(["pass", "fail"]),
					evaluator: tool.schema.string().min(1),
					summary: tool.schema.string().min(1),
					evidence: tool.schema.array(tool.schema.string().min(1)).optional(),
				},
				execute: async (args) => {
					const result = await service.recordEval({
						proposalID: args.proposal_id,
						status: args.status,
						evaluator: args.evaluator,
						summary: args.summary,
						evidence: args.evidence,
					})
					return `Recorded ${result.status} eval for ${result.proposalID} at ${result.manifestPath.replace("manifest.json", "result.json")}.`
				},
			}),
			agenttracer_accept_proposal: tool({
				description: "Accept an eval-passing agentTracer proposal and update lineage",
				args: {
					proposal_id: tool.schema.string().min(1),
					actor: tool.schema.string().min(1),
					reason: tool.schema.string().min(1),
				},
					execute: async (args) => {
						const result = await service.acceptProposal({
							proposalID: args.proposal_id,
							actor: args.actor,
							reason: args.reason,
						})
						return `Accepted ${result.proposal.id}; lineage for ${result.proposal.agent} now points to ${result.lineage.current.snapshotID}.`
					},
				}),
				agenttracer_dismiss_proposal: tool({
					description: "Dismiss an open agentTracer proposal with an explicit actor and reason",
					args: {
						proposal_id: tool.schema.string().min(1),
						actor: tool.schema.string().min(1),
						reason: tool.schema.string().min(1),
					},
					execute: async (args) => {
						const result = await service.dismissProposal({
							proposalID: args.proposal_id,
							actor: args.actor,
							reason: args.reason,
						})
						return `Dismissed ${result.proposal.id}; it remains on disk for auditability but is no longer open for review.`
					},
				}),
			agenttracer_record_rollback: tool({
				description: "Record a manual rollback to a stored agentTracer snapshot",
				args: {
					agent: tool.schema.string().min(1),
					restored_snapshot_id: tool.schema.string().min(1),
					actor: tool.schema.string().min(1),
					reason: tool.schema.string().min(1),
					eval_result_path: tool.schema.string().min(1).optional(),
				},
				execute: async (args) => {
					const result = await service.recordRollback({
						agent: args.agent,
						restoredSnapshotID: args.restored_snapshot_id,
						actor: args.actor,
						reason: args.reason,
						evalResultPath: args.eval_result_path,
					})
					return `Recorded rollback for ${args.agent}; lineage now points to ${result.lineage.current.snapshotID}.`
				},
			}),
		},
		"chat.message": async (input, output) => {
			try {
				const messageText = output.parts.filter(isTextPart).map((part) => part.text).join("\n\n")
				if (!messageText.includes(CORRECTION_BLOCK_NAME)) return

				await service.captureUserMessage({
					sessionID: input.sessionID,
					messageID: output.message.id,
					text: messageText,
					observedAt: output.message.time.created,
				})
			} catch (error) {
				await client.app
					.log({
						body: {
							service: "agentTracer",
							level: "warn",
							message: `Failed to capture correction block: ${error instanceof Error ? error.message : String(error)}`,
						},
					})
					.catch(() => {})
			}
		},
		"tool.execute.before": async (input, output) => {
			try {
				if (input.tool !== "task") return
				const agentName = output.args?.subagent_type
				if (typeof agentName !== "string" || !agentName.trim()) return

				await service.observeTaskInvocation({
					agent: agentName,
					sessionID: input.sessionID,
					callID: input.callID,
					retrySignal: extractRetrySignal(output.args),
				})
			} catch (error) {
				await client.app
					.log({
						body: {
							service: "agentTracer",
							level: "warn",
							message: `Failed to capture task flow: ${error instanceof Error ? error.message : String(error)}`,
						},
					})
					.catch(() => {})
			}
		},
	}
}

export default AgentTracerPlugin
