import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  startVoiceCall,
  type VoiceCall,
  type VoiceCallState,
} from "@t3tools/client-runtime/voice-call";
import { getEnvironmentMediaSocketUrl } from "@t3tools/client-runtime/voice-input";
import {
  VOICE_CONVERSATION_PATH,
  type ScopedThreadRef,
  type VoiceConversationOptions,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { createBrowserVoiceCallPlatform } from "./browserVoiceCall";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

/** Kokoro renders at 24 kHz; the player opens its context at this rate before any speech arrives. */
const VOICE_SAMPLE_RATE = 24_000;

export type ActiveVoiceCall = {
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  readonly state: VoiceCallState;
  readonly call: VoiceCall;
};

let active: ActiveVoiceCall | null = null;
const listeners = new Set<() => void>();
const publish = (next: ActiveVoiceCall | null) => {
  active = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The one call this client runs, on whichever thread started it. */
export function useActiveVoiceCall() {
  return useSyncExternalStore(
    subscribe,
    () => active,
    () => null,
  );
}

export function readActiveVoiceCall() {
  return active;
}

// A thread's composer registers how to start its call, so the palette starts it the same way.
const starters = new Map<string, () => void>();
export function registerVoiceCallStarter(threadKey: string, start: () => void) {
  starters.set(threadKey, start);
  for (const listener of listeners) listener();
  return () => {
    if (starters.get(threadKey) === start) starters.delete(threadKey);
    for (const listener of listeners) listener();
  };
}

export function useVoiceCallStarter(threadKey: string | null) {
  return useSyncExternalStore(
    subscribe,
    () => (threadKey ? (starters.get(threadKey) ?? null) : null),
    () => null,
  );
}

const ENDED_TITLES = {
  idle: "Voice call ended after a quiet stretch",
  error: "Voice call ended",
} as const;

export function beginVoiceCall(input: {
  readonly prepared: PreparedConnection;
  readonly threadRef: ScopedThreadRef;
  readonly canSend: () => boolean;
  readonly microphoneId: string;
  readonly options: VoiceConversationOptions;
}) {
  active?.call.stop();
  const threadKey = scopedThreadKey(input.threadRef);
  // Closing or reloading the tab hangs up, so the environment frees its speech slot at once.
  const hangUp = () => call.stop();
  window.addEventListener("pagehide", hangUp);
  const call: VoiceCall = startVoiceCall({
    platform: createBrowserVoiceCallPlatform({ microphoneId: input.microphoneId }),
    connect: (signal) =>
      runEnvironmentSpeech(getEnvironmentMediaSocketUrl(input.prepared, VOICE_CONVERSATION_PATH), {
        signal,
      }),
    canSend: input.canSend,
    threadId: input.threadRef.threadId,
    options: input.options,
    sampleRate: VOICE_SAMPLE_RATE,
    onState: (state) => {
      if (active && active.call !== call) return;
      if (!state.ended) {
        publish({ threadRef: input.threadRef, threadKey, state, call });
        return;
      }
      window.removeEventListener("pagehide", hangUp);
      publish(null);
      if (state.ended.reason !== "stopped")
        toastManager.add({
          type: state.ended.reason === "error" ? "error" : "info",
          title: ENDED_TITLES[state.ended.reason],
          ...(state.ended.reason === "error" ? { description: state.ended.message } : {}),
        });
    },
  });
  publish({ threadRef: input.threadRef, threadKey, state: call.state(), call });
}
