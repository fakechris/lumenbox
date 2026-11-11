/** Conservative, explicit recovery of user requests. It never queues work or attributes mixed tool steps. */
import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import { personAuthoredText, type HistoryEntry } from "./compaction.ts";
import type { TaskStore } from "./tasks.ts";
import { redactText } from "./secret-redaction.ts";

type Opening = HistoryEntry & { causedBy?: string[]; turnId?: string };
export function recoverUserRequests(
	registry: AgentRegistry,
	tasks: TaskStore,
	agentId: string,
	apply = false,
) {
	const found: {
			source: string;
			conversation: string;
			epoch: number;
			turnId?: string;
			text: string;
			sourceIds: string[];
			taskId?: string;
		}[] = [],
		gaps: string[] = [];
	const known = new Set(
		tasks
			.list()
			.flatMap((task) => [
				task.sourceMessageId,
				...(task.workRoot?.requests?.map((row) => row.id) ?? []),
			])
			.filter(Boolean),
	);
	for (const conversation of registry.listConversations(agentId)) {
		if (/^(work-|peer-|fork\/|audit-|goalverify-)/.test(conversation.id))
			continue;
		const epochs = registry.readContextTranscriptsByEpoch(
			agentId,
			conversation.id,
			{ bytes: 32 * 1024 * 1024, entries: 20000 },
		);
		if (epochs.partial) gaps.push(conversation.id);
		for (const epoch of epochs)
			for (const entry of epoch.entries as Opening[]) {
				const text = personAuthoredText(entry)?.trim();
				if (!text || !entry.causedBy?.length) continue;
				const sourceIds = [...new Set(entry.causedBy)];
				const source =
					sourceIds.length === 1
						? sourceIds[0]!
						: "historical-" +
							createHash("sha256")
								.update(
									JSON.stringify([
										agentId,
										conversation.id,
										epoch.epoch,
										entry.turnId,
										sourceIds,
									]),
								)
								.digest("hex");
				if (known.has(source)) continue;
				known.add(source);
				const record = {
					source,
					conversation: conversation.id,
					epoch: epoch.epoch,
					turnId: entry.turnId,
					text: redactText(text),
					sourceIds,
				};
				const task = apply
					? tasks.workRoots.recover(agentId, record)
					: undefined;
				found.push({ ...record, ...(task ? { taskId: task.id } : {}) });
			}
	}
	return { applied: apply, requests: found, gaps };
}

export async function recoverWorkCommand(
	args: string[],
	io: { out: (text: string) => void; err: (text: string) => void },
) {
	const { AgentRegistry } = await import("../agents/registry.ts"),
		{ TaskStore } = await import("./tasks.ts");
	if (!args[0]) {
		io.err(
			"recover-work <agent> [--apply]: preview historical user requests; --apply records them without running them",
		);
		return 1;
	}
	const registry = new AgentRegistry(),
		agent = registry.resolve(args[0]);
	const result = recoverUserRequests(
		registry,
		new TaskStore(),
		agent.id,
		args.includes("--apply"),
	);
	io.out(JSON.stringify(result, null, 2));
	return 0;
}
