import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createAgentTracerService } from "../src/index.js"

async function main() {
	const profileRoot = await mkdtemp(path.join(tmpdir(), "agenttracer-dryrun-"))
	const agentPath = path.join(profileRoot, "agents", "coder.md")
	let now = Date.UTC(2026, 3, 16, 18, 0, 0)

	try {
		await mkdir(path.dirname(agentPath), { recursive: true })
		await writeFile(agentPath, "# coder\n\nBase instructions.\n", "utf8")

		const service = createAgentTracerService({
			profileRoot,
			now: () => now,
		})
		await service.ensureInitialized()

		const openProposal = async (sessionID: string, summary: string, observedAt: number) => {
			await service.observeTaskInvocation({
				agent: "coder",
				sessionID,
				callID: `${sessionID}-call-1`,
				retrySignal: "Initial attempt before correction.",
				observedAt,
			})
			await service.captureUserMessage({
				sessionID,
				messageID: `${sessionID}-message-1`,
				observedAt: observedAt + 1,
				text: [`\`\`\`agenttracer-correction`, `agent: coder`, `kind: instruction`, `summary: ${summary}`, `why: Dry-run feedback.`, "```"].join("\n"),
			})
			await service.observeTaskInvocation({
				agent: "coder",
				sessionID,
				callID: `${sessionID}-call-2`,
				retrySignal: "Retry after reviewer feedback.",
				observedAt: observedAt + 2,
			})

			const review = await service.reviewOpenImprovements()
			const proposal = review.proposals.find((candidate) => candidate.summary === summary)
			if (!proposal) {
				throw new Error(`Failed to open dry-run proposal for summary: ${summary}`)
			}

			return proposal.proposalID
		}

		const dismissedProposalID = await openProposal(
			"dryrun-dismiss",
			"Ask one clarifying question before coding when the API surface is ambiguous.",
			now,
		)
		now += 10_000
		await service.dismissProposal({
			proposalID: dismissedProposalID,
			actor: "dryrun-reviewer",
			reason: "Captured as obsolete for this pass.",
		})

		const acceptedSummary = "Keep verification steps explicit when asking for follow-up work."
		const acceptedProposalID = await openProposal("dryrun-accept", acceptedSummary, now)
		await writeFile(agentPath, "# coder\n\nUpdated instructions for accepted dry run.\n", "utf8")
		const snapshotResult = await service.snapshotCandidate(acceptedProposalID, "Dry-run candidate snapshot")
		const evalResult = await service.recordEval({
			proposalID: acceptedProposalID,
			status: "pass",
			evaluator: "dryrun-reviewer",
			summary: "Dry-run candidate passed the manifest.",
			evidence: ["Candidate snapshot differs from base.", "Manifest links and eval links resolve."],
		})
		const accepted = await service.acceptProposal({
			proposalID: acceptedProposalID,
			actor: "dryrun-reviewer",
			reason: "Approved in dry-run lifecycle proof.",
		})

		const baseSnapshotPath = path.join(
			profileRoot,
			".agentTracer",
			"versions",
			accepted.proposal.agent,
			`${accepted.proposal.baseSnapshotID}.md`,
		)
		await writeFile(agentPath, await readFile(baseSnapshotPath, "utf8"), "utf8")
		const rollback = await service.recordRollback({
			agent: accepted.proposal.agent,
			restoredSnapshotID: accepted.proposal.baseSnapshotID,
			actor: "dryrun-reviewer",
			reason: "Restore baseline in dry-run proof.",
			evalResultPath: evalResult.manifestPath.replace("manifest.json", "result.json"),
		})

		const finalReview = await service.reviewOpenImprovements()
		const proposalsDirEntries = await readdir(service.paths.proposalsDir)
		const evalDirEntries = await readdir(service.paths.evalsDir)
		const historyEntries = (await readFile(service.paths.historyLedgerPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string; proposalID?: string; toSnapshotID?: string })

		console.log(
			JSON.stringify(
				{
					profileRoot,
					openReviewAfterLifecycle: {
						openProposalCount: finalReview.openProposalCount,
						acceptedProposalCount: finalReview.acceptedProposalCount,
						dismissedProposalCount: finalReview.dismissedProposalCount,
					},
					dismissedProposalID,
					acceptedProposalID,
					candidateSnapshotID: snapshotResult.candidate.id,
					acceptedLineageSnapshotID: accepted.lineage.current.snapshotID,
					rollbackLineageSnapshotID: rollback.lineage.current.snapshotID,
					artifactDirs: {
						proposals: proposalsDirEntries,
						evals: evalDirEntries,
					},
					historyEntries,
				},
				null,
				2,
			),
		)
	} finally {
		await rm(profileRoot, { recursive: true, force: true })
	}
}

await main()
