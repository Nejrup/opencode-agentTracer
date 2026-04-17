import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createAgentTracerService } from "../src/index.js"

type LogEntry = {
	level: "debug" | "info" | "warn" | "error"
	message: string
}

type Harness = Awaited<ReturnType<typeof createHarness>>

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf8")) as T
}

async function createHarness(
	t: TestContext,
	agentContent = "# coder\n\nBase instructions.\n",
	options: { now?: number; agents?: Record<string, string> } = {},
) {
	const profileRoot = await mkdtemp(path.join(tmpdir(), "agenttracer-"))
	const agentsDir = path.join(profileRoot, "agents")
	const logs: LogEntry[] = []
	let now = options.now ?? Date.UTC(2026, 3, 16, 12, 0, 0)

	await mkdir(agentsDir, { recursive: true })
	const agents = options.agents ?? { coder: agentContent }
	await Promise.all(
		Object.entries(agents).map(([agentName, content]) =>
			writeFile(path.join(agentsDir, `${agentName}.md`), content, "utf8"),
		),
	)

	const service = createAgentTracerService({
		profileRoot,
		now: () => now,
		onLog: (level, message) => {
			logs.push({ level, message })
		},
	})

	await service.ensureInitialized()
	t.after(async () => {
		await rm(profileRoot, { recursive: true, force: true })
	})

	return {
		profileRoot,
		agentPath: path.join(agentsDir, "coder.md"),
		logs,
		getNow: () => now,
		setNow: (value: number) => {
			now = value
		},
		service,
	}
}

async function createOpenProposal(
	harness: Harness,
	options: {
		sessionID?: string
		messageID?: string
		observedAt?: number
		summary?: string
	} = {},
) {
	const { service } = harness
	const sessionID = options.sessionID ?? "session-1"
	const messageID = options.messageID ?? "message-1"
	const observedAt = options.observedAt ?? harness.getNow()
	const summary = options.summary ?? "Ask one clarifying question before coding when the API surface is ambiguous."

	await service.observeTaskInvocation({
		agent: "coder",
		sessionID,
		callID: "call-1",
		retrySignal: "Initial implementation attempt",
		observedAt,
	})

	const [userCorrection] = await service.captureUserMessage({
		sessionID,
		messageID,
		observedAt: observedAt + 1,
		text: [`\`\`\`agenttracer-correction`, `agent: coder`, `kind: instruction`, `summary: ${summary}`, `why: The last pass guessed the contract.`, "```"].join("\n"),
	})

	assert.ok(userCorrection, "expected a user correction signal")

	const retrySignal = await service.observeTaskInvocation({
		agent: "coder",
		sessionID,
		callID: "call-2",
		retrySignal: "Retry after review feedback and correct the workflow.",
		observedAt: observedAt + 2,
	})

	if (!retrySignal) {
		throw new Error("expected a same-agent correction-loop signal")
	}

	const state = await service.getState()
	assert.equal(state.proposals.length, 1, "expected a single open proposal")
	assert.ok(state.proposals[0], "expected the proposal to exist")

	return {
		proposal: state.proposals[0],
		state,
		userCorrection,
		retrySignal,
	}
}

test("ensureInitialized keeps all runtime paths under .agentTracer", async (t: TestContext) => {
	const { profileRoot, service } = await createHarness(t)
	const dataRoot = path.join(profileRoot, ".agentTracer")
	const runtimePaths = [
		service.paths.dataRoot,
		service.paths.signalsDir,
		service.paths.proposalsDir,
		service.paths.evalsDir,
		service.paths.versionsDir,
		service.paths.lineageDir,
		service.paths.historyDir,
	]

	assert.equal(service.paths.dataRoot, dataRoot)
	for (const targetPath of runtimePaths) {
		assert.ok(targetPath.startsWith(dataRoot), `${targetPath} should stay under ${dataRoot}`)
		assert.equal((await stat(targetPath)).isDirectory(), true)
	}

	assert.deepEqual((await service.getState()).knownAgents, ["coder"])
})

test("service defaults runtime storage to the current profile root instead of directory/worktree", async (t: TestContext) => {
	const previousCwd = process.cwd()
	const profileRoot = await mkdtemp(path.join(tmpdir(), "agenttracer-profile-root-"))
	const worktreeRoot = await mkdtemp(path.join(tmpdir(), "agenttracer-worktree-root-"))

	await mkdir(path.join(profileRoot, "agents"), { recursive: true })
	await writeFile(path.join(profileRoot, "agents", "coder.md"), "# coder\n\nBase instructions.\n", "utf8")
	t.after(async () => {
		process.chdir(previousCwd)
		await Promise.all([
			rm(profileRoot, { recursive: true, force: true }),
			rm(worktreeRoot, { recursive: true, force: true }),
		])
	})

	process.chdir(profileRoot)
	const service = createAgentTracerService({
		directory: worktreeRoot,
		worktree: path.join(worktreeRoot, "nested-repo"),
	})
	await service.ensureInitialized()

	const resolvedProfileRoot = await realpath(profileRoot)
	assert.equal(service.paths.profileRoot, resolvedProfileRoot)
	assert.equal(service.paths.dataRoot, path.join(resolvedProfileRoot, ".agentTracer"))
	assert.ok(service.paths.dataRoot.startsWith(resolvedProfileRoot))
	assert.equal(service.paths.dataRoot.startsWith(worktreeRoot), false)
	assert.deepEqual((await service.getState()).knownAgents, ["coder"])
})

test("service rejects data roots outside the current profile root", async (t: TestContext) => {
	const { profileRoot } = await createHarness(t)
	const outsideRoot = path.join(tmpdir(), "agenttracer-outside-root")

	assert.throws(
		() => createAgentTracerService({ profileRoot, dataRoot: outsideRoot }),
		/data root must stay inside the current profile root/i,
	)
})

test("ensureInitialized rejects default data roots that escape through a symlink", async (t: TestContext) => {
	const profileRoot = await mkdtemp(path.join(tmpdir(), "agenttracer-symlink-profile-"))
	const outsideRoot = await mkdtemp(path.join(tmpdir(), "agenttracer-symlink-outside-"))

	await mkdir(path.join(profileRoot, "agents"), { recursive: true })
	await writeFile(path.join(profileRoot, "agents", "coder.md"), "# coder\n\nBase instructions.\n", "utf8")
	await symlink(outsideRoot, path.join(profileRoot, ".agentTracer"))

	t.after(async () => {
		await Promise.all([
			rm(profileRoot, { recursive: true, force: true }),
			rm(outsideRoot, { recursive: true, force: true }),
		])
	})

	const service = createAgentTracerService({ profileRoot })
	await assert.rejects(service.ensureInitialized(), /data root must stay inside the current profile root/i)
	await assert.rejects(stat(path.join(outsideRoot, "signals")), /ENOENT/)
})

test("captureUserMessage ingests canonical correction blocks and dedupes repeated signals", async (t: TestContext) => {
	const { logs, service } = await createHarness(t)
	const text = [
		"```agenttracer-correction",
		"agent: coder",
		"kind: instruction",
		"summary: Ask for the missing API shape before coding.",
		"why: The previous pass guessed the contract.",
		"```",
		"",
		"```agenttracer-correction",
		"agent: coder",
		"kind: invalid-kind",
		"summary: This should be ignored.",
		"```",
		"",
		"```agenttracer-correction",
		"agent: unknown-agent",
		"kind: instruction",
		"summary: This should also be ignored.",
		"```",
	].join("\n")

	const firstPass = await service.captureUserMessage({
		sessionID: "session-parse",
		messageID: "message-parse",
		observedAt: Date.UTC(2026, 3, 16, 12, 10, 0),
		text,
	})
	const secondPass = await service.captureUserMessage({
		sessionID: "session-parse",
		messageID: "message-parse",
		observedAt: Date.UTC(2026, 3, 16, 12, 10, 0),
		text,
	})

	assert.equal(firstPass.length, 1)
	assert.equal(secondPass.length, 1)

	const state = await service.getState()
	assert.equal(state.signals.length, 1, "expected the repeated correction to dedupe")
	assert.equal(state.proposals.length, 0, "a single user correction should not open a proposal")
	assert.equal(state.signals[0]?.metadata.contract, "agenttracer-correction")
	assert.match(logs[0]?.message ?? "", /ignored correction for unknown agent/i)
})

test("same-agent correction loops create thresholded proposals and reviewer-facing artifacts", async (t: TestContext) => {
	const harness = await createHarness(t)
	const { service } = harness
	const { proposal, retrySignal, userCorrection } = await createOpenProposal(harness)

	assert.equal(userCorrection.source, "user-correction")
	assert.equal(retrySignal.source, "same-agent-correction-loop")
	assert.equal(proposal.status, "open")
	assert.equal(proposal.signalCount, 2)
	assert.equal(proposal.userCorrectionCount, 1)

	const proposalJson = await readJson<typeof proposal>(path.join(service.paths.profileRoot, proposal.files.json))
	const proposalMarkdown = await readFile(path.join(service.paths.profileRoot, proposal.files.markdown), "utf8")
	const manifest = await readJson<{
		base: { snapshotID: string; path: string }
		candidate: { path: string }
	}>(path.join(service.paths.profileRoot, proposal.evalManifestPath))
	const lineageFiles = await readdir(service.paths.lineageDir)

	assert.equal(proposalJson.id, proposal.id)
	assert.equal(manifest.base.snapshotID, proposal.baseSnapshotID)
	assert.equal(manifest.candidate.path, "agents/coder.md")
	assert.match(proposalMarkdown, /# agentTracer proposal:/)
	assert.match(proposalMarkdown, /\/agent-selfimprove/)
	assert.match(proposalMarkdown, /agenttracer_snapshot_candidate/)
	assert.deepEqual(lineageFiles, ["coder.json"])

	const review = await service.reviewOpenImprovements()
	assert.equal(review.openProposalCount, 1)
	assert.equal(review.staleOpenProposalCount, 0)
	assert.deepEqual(review.agentsWithOpenProposals, ["coder"])
	assert.equal(review.proposals[0]?.health, "awaiting-candidate")
	assert.match(review.proposals[0]?.nextSteps.join("\n") ?? "", /agenttracer_record_eval/)
})

test("repeated blocked tool misuse emits workflow evidence and opens a proposal without a tagged correction block", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			coder: "# coder\n\nBase instructions.\n",
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness
	const retrySignal = "Blocked: do not use `py`; that tool is not allowed for explore in this repo."

	const firstSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-blocked-tool",
		callID: "call-1",
		retrySignal,
		observedAt: harness.getNow(),
	})
	const secondSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-blocked-tool",
		callID: "call-2",
		retrySignal,
		observedAt: harness.getNow() + 1,
	})
	const thirdSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-blocked-tool",
		callID: "call-3",
		retrySignal,
		observedAt: harness.getNow() + 2,
	})

	assert.equal(firstSignal?.source, "agent-stuck-state")
	assert.equal(firstSignal?.metadata.issueCategory, "blocked-tool")
	assert.equal(secondSignal?.metadata.blockedTool, "py")
	assert.equal(thirdSignal?.metadata.blockedTool, "py")

	const state = await service.getState()
	assert.equal(state.signals.length, 3)
	assert.equal(state.proposals.length, 1)
	assert.equal(state.proposals[0]?.agent, "explore")
	assert.equal(state.proposals[0]?.kind, "workflow")
	assert.equal(state.proposals[0]?.userCorrectionCount, 0)
	assert.match(state.proposals[0]?.summary ?? "", /blocked from using tool `py`/i)
})

test("blocked tool parsing prefers the actual unquoted tool name over filler words", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-blocked-tool-unquoted",
		callID: "call-1",
		retrySignal: "Blocked: do not use the bash tool here; it is not allowed for explore.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.blockedTool, "bash")
	assert.match(signal?.summary ?? "", /tool `bash`/i)
})

test("blocked tool parsing still works for contraction phrasing like isn't allowed", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-blocked-tool-contraction",
		callID: "call-1",
		retrySignal: "The bash tool isn't allowed here.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "blocked-tool")
	assert.equal(signal?.metadata.blockedTool, "bash")
	assert.match(signal?.summary ?? "", /tool `bash`/i)
})

test("blocked tool wording without a stable tool name still records a generic blocked-tool signal", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-blocked-tool-generic",
		callID: "call-1",
		retrySignal: "Blocked: do not use the forbidden terminal here.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "blocked-tool")
	assert.equal(signal?.metadata.blockedTool, undefined)
	assert.match(signal?.summary ?? "", /disallowed or forbidden tool/i)
})

test("missing permission or ungranted access wording records a permission signal", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-permission-access-not-granted",
		callID: "call-1",
		retrySignal: "I do not have permission to finish this because access is not granted yet and it requires approval.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "permission")
	assert.equal(signal?.metadata.issueTrigger, "approval-required")
	assert.match(signal?.summary ?? "", /permission or sandbox limits/i)
})

test("tool not installed and command-not-found wording records a capability signal", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-capability-command-not-found",
		callID: "call-1",
		retrySignal: "I cannot continue because command `kubectl` not found; the tool is not installed here.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "capability")
	assert.equal(signal?.metadata.issueTrigger, "tool-not-installed")
	assert.equal(signal?.metadata.capability, "kubectl")
	assert.match(signal?.summary ?? "", /capability `kubectl`/i)
})

test("sandbox timeout and resource-cap wording records an environment signal", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-environment-resource-cap",
		callID: "call-1",
		retrySignal: "The run timed out because this environment is resource capped.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "environment")
	assert.equal(signal?.metadata.issueTrigger, "timeout-or-resource-cap")
	assert.match(signal?.summary ?? "", /environment restrictions/i)
})

test("explicit inability wording records a stuck signal even without complete or fulfill phrasing", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-explicit-inability",
		callID: "call-1",
		retrySignal: "I can't do that with the current constraints.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "stuck")
	assert.equal(signal?.metadata.issueTrigger, "explicit-inability")
	assert.match(signal?.summary ?? "", /stuck or unable to fulfill/i)
})

test("need-more-info and missing-information wording records a confusion signal", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-confusion-need-more-info",
		callID: "call-1",
		retrySignal: "I need more info because the request is missing information about the target file.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "confusion")
	assert.equal(signal?.metadata.issueTrigger, "missing-context")
	assert.match(signal?.summary ?? "", /ask a targeted clarification/i)
})

test("permission, capability, confusion, and stuck text each emit aggressive evidence signals", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const permissionSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-permission",
		callID: "call-permission",
		retrySignal: "Permission denied by sandbox; approval required before I can continue.",
		observedAt: harness.getNow(),
	})
	const capabilitySignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-capability",
		callID: "call-capability",
		retrySignal: "The required tool git is unavailable here, so I cannot execute that step.",
		observedAt: harness.getNow() + 1,
	})
	const environmentSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-environment",
		callID: "call-environment",
		retrySignal: "This step needs network access, but network access is unavailable in this environment.",
		observedAt: harness.getNow() + 2,
	})
	const confusionSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-confusion",
		callID: "call-confusion",
		retrySignal: "I'm not sure which target file is correct and need clarification before changing anything.",
		observedAt: harness.getNow() + 3,
	})
	const stuckSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-stuck",
		callID: "call-stuck",
		retrySignal: "I'm stuck and unable to fulfill the request with the current constraints.",
		observedAt: harness.getNow() + 4,
	})

	assert.equal(permissionSignal?.metadata.issueCategory, "permission")
	assert.equal(capabilitySignal?.metadata.issueCategory, "capability")
	assert.equal(environmentSignal?.metadata.issueCategory, "environment")
	assert.equal(confusionSignal?.metadata.issueCategory, "confusion")
	assert.equal(stuckSignal?.metadata.issueCategory, "stuck")

	const state = await service.getState()
	assert.equal(state.signals.length, 5)
	assert.equal(state.proposals.length, 0)
})

test("repeated explicit inability wording records a loop signal and opens a proposal", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness
	const retrySignal = "I can't do that with the current constraints."

	const firstSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-explicit-inability-loop",
		callID: "call-1",
		retrySignal,
		observedAt: harness.getNow(),
	})
	const secondSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-explicit-inability-loop",
		callID: "call-2",
		retrySignal,
		observedAt: harness.getNow() + 1,
	})

	assert.equal(firstSignal?.metadata.issueCategory, "stuck")
	assert.equal(firstSignal?.metadata.issueTrigger, "explicit-inability")
	assert.equal(secondSignal?.metadata.loopType, "repeated-agent-stuck-state")

	const state = await service.getState()
	assert.equal(state.signals.length, 2)
	assert.equal(state.proposals.length, 1)
	assert.equal(state.proposals[0]?.agent, "explore")
	assert.match(state.proposals[0]?.summary ?? "", /stuck or unable to fulfill/i)
})

test("repeated explicit inability records loop metadata and opens a proposal path", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness
	const retrySignal = "I cannot complete this step because the required deploy access is unavailable."

	const firstSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-unfulfillable-loop",
		callID: "call-1",
		retrySignal,
		observedAt: harness.getNow(),
	})
	const secondSignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-unfulfillable-loop",
		callID: "call-2",
		retrySignal,
		observedAt: harness.getNow() + 1,
	})

	assert.equal(firstSignal?.source, "agent-stuck-state")
	assert.equal(firstSignal?.metadata.issueCategory, "capability")
	assert.equal(secondSignal?.metadata.loopType, "repeated-agent-stuck-state")

	const state = await service.getState()
	assert.equal(state.signals.length, 2)
	assert.equal(state.proposals.length, 1)
	assert.equal(state.proposals[0]?.agent, "explore")
	assert.match(state.proposals[0]?.summary ?? "", /required capability `deploy`|required tool or capability/i)
})

test("capability parsing isolates the actual unquoted capability name", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	const signal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-capability-unquoted",
		callID: "call-1",
		retrySignal: "The required tool git is unavailable here, so I cannot execute that step.",
		observedAt: harness.getNow(),
	})

	assert.equal(signal?.source, "agent-stuck-state")
	assert.equal(signal?.metadata.issueCategory, "capability")
	assert.equal(signal?.metadata.capability, "git")
	assert.match(signal?.summary ?? "", /capability `git`/i)
})

test("one tagged correction plus one blocked-tool retry records evidence but does not open a proposal without explicit corrective retry wording", async (t: TestContext) => {
	const harness = await createHarness(t, undefined, {
		agents: {
			coder: "# coder\n\nBase instructions.\n",
			explore: "# explore\n\nUse the allowed exploration tools only.\n",
		},
	})
	const { service } = harness

	await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-correction-blocked-tool",
		callID: "call-1",
		retrySignal: "Initial attempt before correction.",
		observedAt: harness.getNow(),
	})
	const [userCorrection] = await service.captureUserMessage({
		sessionID: "session-correction-blocked-tool",
		messageID: "message-1",
		observedAt: harness.getNow() + 1,
		text: [
			"```agenttracer-correction",
			"agent: explore",
			"kind: workflow",
			"summary: Use only allowed tools for this profile.",
			"why: The prior pass used a forbidden tool.",
			"```",
		].join("\n"),
	})
	const blockedToolOnlySignal = await service.observeTaskInvocation({
		agent: "explore",
		sessionID: "session-correction-blocked-tool",
		callID: "call-2",
		retrySignal: "Blocked: do not use `py`; that tool is not allowed for explore in this repo.",
		observedAt: harness.getNow() + 2,
	})

	assert.equal(userCorrection?.source, "user-correction")
	assert.equal(blockedToolOnlySignal?.source, "agent-stuck-state")
	assert.equal(blockedToolOnlySignal?.metadata.issueCategory, "blocked-tool")

	const state = await service.getState()
	assert.equal(state.signals.length, 2)
	assert.equal(state.proposals.length, 0)
	assert.equal(state.signals[0]?.source, "user-correction")
})

test("lifecycle flow snapshots, records evals, accepts proposals, and records rollbacks", async (t: TestContext) => {
	const harness = await createHarness(t)
	const { agentPath, profileRoot, service } = harness
	const { proposal } = await createOpenProposal(harness)

	await assert.rejects(
		service.acceptProposal({
			proposalID: proposal.id,
			actor: "reviewer",
			reason: "Should fail before candidate and eval exist.",
		}),
		/incomplete acceptance lineage/i,
	)

	await writeFile(agentPath, "# coder\n\nUpdated instructions after approved proposal.\n", "utf8")
	const { candidate, manifest } = await service.snapshotCandidate(proposal.id, "Candidate under test")

	assert.notEqual(candidate.id, proposal.baseSnapshotID)
	assert.equal(manifest.candidate.snapshotID, candidate.id)
	assert.equal(manifest.candidate.path, "agents/coder.md")

	const evalResult = await service.recordEval({
		proposalID: proposal.id,
		status: "pass",
		evaluator: "reviewer",
		summary: "Candidate satisfies the manifest.",
		evidence: ["Verified candidate snapshot linkage.", "Verified proposal and manifest references."],
	})
	assert.equal(evalResult.status, "pass")

	const readyReview = await service.reviewOpenImprovements()
	assert.equal(readyReview.proposals[0]?.health, "ready-to-accept")
	assert.equal(readyReview.proposals[0]?.evalStatus, "pass")

	const accepted = await service.acceptProposal({
		proposalID: proposal.id,
		actor: "reviewer",
		reason: "Approved after passing eval.",
	})

	assert.equal(accepted.proposal.status, "accepted")
	assert.equal(accepted.lineage.current.snapshotID, candidate.id)
	assert.equal(accepted.lineage.previous?.snapshotID, proposal.baseSnapshotID)

	const baseSnapshotPath = path.join(profileRoot, ".agentTracer", "versions", proposal.agent, `${proposal.baseSnapshotID}.md`)
	await writeFile(agentPath, await readFile(baseSnapshotPath, "utf8"), "utf8")

	const rollback = await service.recordRollback({
		agent: proposal.agent,
		restoredSnapshotID: proposal.baseSnapshotID,
		actor: "reviewer",
		reason: "Restore the original baseline.",
		evalResultPath: evalResult.manifestPath.replace("manifest.json", "result.json"),
	})

	assert.equal(rollback.lineage.current.snapshotID, proposal.baseSnapshotID)
	assert.equal(rollback.lineage.previous?.snapshotID, candidate.id)

	const ledger = (await readFile(service.paths.historyLedgerPath, "utf8"))
		.trim()
		.split("\n")
		.map((line: string) => JSON.parse(line) as { action: string; toSnapshotID: string })
	assert.deepEqual(
		ledger.map((entry: { action: string; toSnapshotID: string }) => entry.action),
		["accept", "rollback"],
	)
	assert.equal(ledger[0]?.toSnapshotID, candidate.id)
	assert.equal(ledger[1]?.toSnapshotID, proposal.baseSnapshotID)
})

test("reviewOpenImprovements surfaces stale and eval-failed proposal health", async (t: TestContext) => {
	const start = Date.UTC(2026, 3, 16, 9, 0, 0)
	const harness = await createHarness(t, undefined, { now: start })
	const { agentPath, service, setNow } = harness
	const { proposal } = await createOpenProposal(harness, { observedAt: start })

	setNow(start + 20 * 24 * 60 * 60 * 1000)
	const staleReview = await service.reviewOpenImprovements()
	assert.equal(staleReview.staleOpenProposalCount, 1)
	assert.equal(staleReview.proposals[0]?.health, "awaiting-candidate")
	assert.equal(staleReview.proposals[0]?.isStale, true)

	await writeFile(agentPath, "# coder\n\nRefined instructions before eval.\n", "utf8")
	await service.snapshotCandidate(proposal.id, "Refresh candidate after stale review")

	const awaitingEvalReview = await service.reviewOpenImprovements()
	assert.equal(awaitingEvalReview.proposals[0]?.health, "awaiting-eval")
	assert.equal(awaitingEvalReview.proposals[0]?.isStale, false)

	await service.recordEval({
		proposalID: proposal.id,
		status: "fail",
		evaluator: "reviewer",
		summary: "The candidate still needs revision.",
		evidence: ["The updated instructions still missed one edge case."],
	})

	const failedReview = await service.reviewOpenImprovements()
	assert.equal(failedReview.proposals[0]?.health, "eval-failed")
	assert.equal(failedReview.proposals[0]?.evalStatus, "fail")
	assert.match(renderSelfImproveReviewText(failedReview), /Stale open proposals: 0/)

	setNow(start + 20 * 24 * 60 * 60 * 1000 + 60_000)
	await writeFile(agentPath, "# coder\n\nRefined instructions after failed eval.\n", "utf8")
	await service.snapshotCandidate(proposal.id, "Refresh candidate after failed eval")

	const refreshedAfterFailReview = await service.reviewOpenImprovements()
	assert.equal(refreshedAfterFailReview.proposals[0]?.health, "awaiting-eval")
	assert.equal(refreshedAfterFailReview.proposals[0]?.evalStatus, undefined)
})

test("resnapshot after a passing eval resets proposal health back to awaiting-eval", async (t: TestContext) => {
	const harness = await createHarness(t)
	const { agentPath, service } = harness
	const { proposal } = await createOpenProposal(harness)

	await writeFile(agentPath, "# coder\n\nFirst approved candidate instructions.\n", "utf8")
	await service.snapshotCandidate(proposal.id, "First candidate under test")
	await service.recordEval({
		proposalID: proposal.id,
		status: "pass",
		evaluator: "reviewer",
		summary: "First candidate passed review.",
		evidence: ["First candidate differs from base and satisfies the manifest."],
	})

	const readyReview = await service.reviewOpenImprovements()
	assert.equal(readyReview.proposals[0]?.health, "ready-to-accept")
	assert.equal(readyReview.proposals[0]?.evalStatus, "pass")

	await writeFile(agentPath, "# coder\n\nSecond candidate after follow-up edits.\n", "utf8")
	await service.snapshotCandidate(proposal.id, "Refresh candidate after passing eval")

	const refreshedAfterPassReview = await service.reviewOpenImprovements()
	assert.equal(refreshedAfterPassReview.proposals[0]?.health, "awaiting-eval")
	assert.equal(refreshedAfterPassReview.proposals[0]?.evalStatus, undefined)
	assert.match(renderSelfImproveReviewText(refreshedAfterPassReview), /pending/)
})

test("dismissed proposals leave an audit trail and require fresh corroboration to reopen", async (t: TestContext) => {
	const start = Date.UTC(2026, 3, 16, 15, 0, 0)
	const harness = await createHarness(t, undefined, { now: start })
	const { service, setNow } = harness
	const summary = "Keep verification steps explicit when asking for follow-up work."
	const { proposal } = await createOpenProposal(harness, { observedAt: start, summary })

	setNow(start + 10_000)
	const dismissed = await service.dismissProposal({
		proposalID: proposal.id,
		actor: "reviewer",
		reason: "The issue is no longer worth pursuing in its current form.",
	})

	assert.equal(dismissed.proposal.status, "dismissed")
	assert.equal(dismissed.proposal.resolution?.actor, "reviewer")

	const emptyReview = await service.reviewOpenImprovements()
	assert.equal(emptyReview.openProposalCount, 0)
	assert.equal(emptyReview.dismissedProposalCount, 1)

	setNow(start + 60_000)
	await service.observeTaskInvocation({
		agent: "coder",
		sessionID: "session-reopen",
		callID: "call-reopen-1",
		retrySignal: "Initial attempt before new correction",
		observedAt: start + 60_000,
	})
	await service.captureUserMessage({
		sessionID: "session-reopen",
		messageID: "message-reopen",
		observedAt: start + 60_001,
		text: [`\`\`\`agenttracer-correction`, `agent: coder`, `kind: instruction`, `summary: ${summary}`, `why: The issue came back in a new review.`, "```"].join("\n"),
	})

	assert.equal((await service.reviewOpenImprovements()).openProposalCount, 0)

	await service.observeTaskInvocation({
		agent: "coder",
		sessionID: "session-reopen",
		callID: "call-reopen-2",
		retrySignal: "Retry after reviewer feedback.",
		observedAt: start + 60_002,
	})

	const reopenedReview = await service.reviewOpenImprovements()
	assert.equal(reopenedReview.openProposalCount, 1)
	assert.equal(reopenedReview.dismissedProposalCount, 1)
	assert.notEqual(reopenedReview.proposals[0]?.proposalID, proposal.id)

	const ledger = (await readFile(service.paths.historyLedgerPath, "utf8"))
		.trim()
		.split("\n")
		.map((line: string) => JSON.parse(line) as { action: string; reason?: string })
	assert.equal(ledger[0]?.action, "dismiss")
	assert.match(ledger[0]?.reason ?? "", /no longer worth pursuing/i)
})

function renderSelfImproveReviewText(review: Awaited<ReturnType<Harness["service"]["reviewOpenImprovements"]>>) {
	return [
		`Open proposals: ${review.openProposalCount}`,
		`Stale open proposals: ${review.staleOpenProposalCount}`,
		...review.proposals.map((proposal) => `${proposal.proposalID}:${proposal.health}:${proposal.evalStatus ?? "pending"}`),
	].join("\n")
}
