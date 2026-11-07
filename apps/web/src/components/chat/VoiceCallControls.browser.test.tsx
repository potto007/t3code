import type { VoiceCallState } from "@t3tools/client-runtime/voice-call";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ActiveVoiceCall } from "../../speech/voiceCall";
import { VoiceCallStrip } from "./VoiceCallControls";

const STATE: VoiceCallState = {
  phase: "confirming",
  muted: false,
  you: null,
  voice: null,
  delegated: null,
  confirm: { id: 1, text: 'Send "Push the branch" to the agent on Fix login?' },
  ended: null,
};

function activeCall(state: VoiceCallState, answer: (confirm: boolean) => void): ActiveVoiceCall {
  return {
    threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
    threadKey: "env:thread",
    state,
    call: { state: () => state, setMuted: vi.fn(), answer, stop: vi.fn() },
  };
}

it("shows a pending request with Confirm and Cancel until it ends", async () => {
  const answer = vi.fn<(confirm: boolean) => void>();
  await using screen = await render(
    <VoiceCallStrip call={activeCall(STATE, answer)} onThisThread />,
  );
  await expect.element(screen.getByText("Voice call · Waiting for your yes")).toBeVisible();
  await expect.element(screen.getByText(STATE.confirm!.text)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(answer.mock.calls).toEqual([[false], [true]]);

  await screen.rerender(
    <VoiceCallStrip
      call={activeCall({ ...STATE, phase: "delegated", confirm: null }, answer)}
      onThisThread
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
});
