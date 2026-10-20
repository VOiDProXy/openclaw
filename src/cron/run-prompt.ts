import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

export function appendCronUnattendedRunPreamble(
  commandBody: string,
  opts: { externalHook: boolean; restartContinuation?: boolean },
) {
  // Keep the suffix static for prompt caching. External hooks cannot override
  // this trusted guidance or gain permission to remove jobs through fenced content.
  const core = `This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply with exactly ${SILENT_REPLY_TOKEN} as the entire final answer. ${SILENT_REPLY_TOKEN} discards anything written this turn that was not sent, so send confirmations before ending silently. If you cannot complete the task, explain what blocked it and what you tried.`;
  const trustedExtra =
    " Where the job's own instructions conflict with this preamble, the job's instructions win (a question or plan the job explicitly requests is a valid deliverable). If this job is no longer needed, remove it if your available tools allow.";
  const restartGuidance = opts.restartContinuation
    ? "\n\nThe previous attempt was interrupted by a Gateway restart. Continue the unfinished task. " +
      "Inspect the retained conversation and any tool effects before acting; do not repeat work or deliveries that already completed."
    : "";
  return `${commandBody}\n\n${core}${opts.externalHook ? "" : trustedExtra}${restartGuidance}`;
}
