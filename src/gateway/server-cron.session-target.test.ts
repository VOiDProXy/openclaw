import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAgentTurnJob,
  createCronConfig,
  loadCronService,
  resetGatewayCronMocks,
  runCronIsolatedAgentTurnMock,
  runCronSessionTurnMock,
} from "./server-cron.test-support.js";

describe("Gateway Cron session target routing", () => {
  beforeEach(resetGatewayCronMocks);

  it("passes opaque explicit session targets through to controller-owned cron turns", async () => {
    const cfg = createCronConfig("server-cron-custom-session");
    const state = loadCronService(cfg);
    try {
      const sessionKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
      const job = await addAgentTurnJob(state, "custom-session", "hello", {
        sessionTarget: `session:${sessionKey}`,
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(runCronSessionTurnMock).toHaveBeenCalledOnce();
      const [options] = expectDefined(runCronSessionTurnMock.mock.calls[0], "session turn");
      expect(options).toMatchObject({
        agentId: "main",
        sessionKey,
        text: "hello",
        job: { id: job.id },
      });
      expect(options.cfg).toBe(cfg);
      expect(options.admissionSource).toBeDefined();
      expect(options.prepare).toBeTypeOf("function");
      expect(options.assertCurrent).toBeTypeOf("function");
    } finally {
      state.cron.stop();
    }
  });

  it.each(["current", "isolated"] as const)(
    "keeps %s turns on detached execution despite a captured result conversation",
    async (sessionTarget) => {
      const cfg = createCronConfig(`server-cron-detached-${sessionTarget}`);
      const state = loadCronService(cfg);
      try {
        const job = await addAgentTurnJob(state, "detached", "hello", {
          sessionTarget,
          sessionKey: "agent:main:captured-result",
        });
        await state.cron.run(job.id, "force");
        expect(runCronSessionTurnMock).not.toHaveBeenCalled();
        const [options] = expectDefined(
          runCronIsolatedAgentTurnMock.mock.calls[0],
          "detached turn",
        );
        expect(options).toMatchObject({ trigger: "cron", sessionKey: `cron:${job.id}` });
      } finally {
        state.cron.stop();
      }
    },
  );
});
