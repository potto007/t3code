import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  getEnvironmentSpeechStatus,
  getEnvironmentVoiceFrontModels,
  getEnvironmentVoicePack,
  getEnvironmentVoiceTtsModel,
} from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  VOICE_CALL_PAUSE_MS,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import { getClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironment } from "../state/environments";
import { registerCommands } from "../shortcuts/dispatcher";
import { useVoiceTranscriptionDestination } from "./useEnvironmentSpeechInput";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import {
  beginVoiceCall,
  readActiveVoiceCall,
  registerVoiceCallStarter,
  useActiveVoiceCall,
} from "./voiceCall";
import { bindAudioGrant } from "./voiceConsent";

/** Why the call button is unavailable on this thread, or null when a call can start. */
type Blocker = { readonly kind: "setup" } | { readonly kind: "blocked"; readonly reason: string };

/**
 * A voice call on a thread. Audio goes only to the environment chosen in Voice settings, and
 * a call runs where its thread lives, so the two must be the same environment.
 */
export function useVoiceCall(input: {
  readonly environmentId: EnvironmentId;
  /** Null on a draft: a call needs a thread to send work to. */
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
  readonly disabled: boolean;
}) {
  const navigate = useNavigate();
  const destination = useVoiceTranscriptionDestination();
  const environmentId = input.environmentId;
  const threadRef = input.threadId ? { environmentId, threadId: input.threadId } : null;
  const threadEnvironment = useEnvironment(environmentId);
  const projectWords = useEnvironmentSettings(
    environmentId,
    (settings) =>
      resolveProjectSettings(settings, input.projectId).settings.speechProjectCustomWords,
  );
  const activeCall = useActiveVoiceCall();
  const [starting, setStarting] = useState(false);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const supportsBrowserAudio =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioWorkletNode !== "undefined";

  const blocker: Blocker | null = !supportsBrowserAudio
    ? {
        kind: "blocked",
        reason: "Voice calls need microphone access. Use HTTPS or the desktop app.",
      }
    : destination.grantId === null
      ? { kind: "setup" }
      : destination.cloudProvider || destination.environmentId !== environmentId
        ? {
            kind: "blocked",
            reason: `Voice calls run on the thread's environment. Choose ${threadEnvironment?.label ?? "it"} under Settings → Voice → Transcribe with.`,
          }
        : !destination.prepared
          ? {
              kind: "blocked",
              reason: "Voice calls aren't available on this environment right now.",
            }
          : null;

  const start = useStableCallback(async () => {
    if (input.disabled || starting || !threadRef) return;
    if (blocker?.kind === "setup") {
      toastManager.add({
        type: "info",
        title: "Choose where to transcribe first",
        description: `A voice call transcribes you on ${threadEnvironment?.label ?? "the thread's environment"}. Choose it under Transcribe with.`,
      });
      await navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
      return;
    }
    const prepared = destination.prepared;
    if (blocker || !prepared || !destination.grantId) {
      if (blocker)
        toastManager.add({
          type: "info",
          title: "Voice call unavailable",
          description: blocker.reason,
        });
      return;
    }
    const canSend = bindAudioGrant(destination.grantId);
    setStarting(true);
    const [status, frontModels, pack, ttsModel] = await Promise.all([
      runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared)).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start the voice call",
          description: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
      // A server-hosted conversation model has no catalog entry; the call reports its own errors.
      runEnvironmentSpeech(getEnvironmentVoiceFrontModels(prepared)).catch(() => null),
      // An older environment has no pack endpoint and runs the runtime it bundles.
      runEnvironmentSpeech(getEnvironmentVoicePack(prepared)).catch(() => null),
      // An older environment downloads the voice model on the call's first sentence.
      runEnvironmentSpeech(getEnvironmentVoiceTtsModel(prepared)).catch(() => null),
    ]);
    setStarting(false);
    if (!status) return;
    if (!status.supported || status.state === "missing-model") {
      toastManager.add({
        type: "info",
        title: "Download a transcription model first",
        description: status.supported
          ? "A voice call transcribes you with the environment's speech model."
          : status.reason,
      });
      if (status.supported) await navigate({ to: "/settings/voice", hash: "speech-models" });
      return;
    }
    if (pack && !pack.supported) {
      toastManager.add({
        type: "info",
        title: "Voice call unavailable",
        description: `Voice calls aren't available on ${threadEnvironment?.label ?? "this environment"}'s platform.`,
      });
      return;
    }
    if (pack && pack.state !== "installed") {
      toastManager.add({
        type: "info",
        title: "Download the voice pack first",
        description: "Voice calls speak and answer with a runtime downloaded to the environment.",
      });
      await navigate({
        to: "/settings/voice",
        search: { machine: environmentId },
        hash: "voice-call-pack",
      });
      return;
    }
    if (ttsModel && ttsModel.state !== "installed") {
      const downloading = ttsModel.state !== "downloadable";
      toastManager.add({
        type: "info",
        title: downloading
          ? "The voice model is still downloading"
          : "Download the voice model first",
        description: downloading
          ? `${ttsModel.name} is ${Math.round(((ttsModel.downloaded ?? 0) / ttsModel.size) * 100)}% downloaded. Settings shows its progress.`
          : `${ttsModel.name} speaks during a voice call.`,
      });
      await navigate({
        to: "/settings/voice",
        search: { machine: environmentId },
        hash: "voice-call-tts-model",
      });
      return;
    }
    // The managed model is gigabytes; a call that silently waits on it would look hung.
    const frontModel = frontModels?.models.find((model) => model.active);
    if (frontModel && frontModel.state !== "installed") {
      toastManager.add({
        type: "info",
        title: "Download the conversation model first",
        description: `${frontModel.name} answers you during a voice call.`,
      });
      await navigate({
        to: "/settings/voice",
        search: { machine: environmentId },
        hash: "voice-call-front-model",
      });
      return;
    }
    const settings = getClientSettings();
    beginVoiceCall({
      prepared,
      threadRef,
      canSend,
      microphoneId: settings.voiceMicrophone,
      options: {
        transcription: {
          speechLanguage: settings.speechLanguage,
          speechTranslateToEnglish: false,
          speechCustomWords: resolveSpeechVocabulary({
            personal: settings.speechCustomWords,
            project: projectWords,
            hints: [input.projectName ?? ""],
          }),
          speechRemoveFillerWords: settings.speechRemoveFillerWords,
          speechSilenceFiltering: settings.speechSilenceFiltering,
        },
        voice: settings.voiceTtsVoice,
        idleTimeout: settings.voiceCallIdleTimeout,
        endSilenceMs: VOICE_CALL_PAUSE_MS[settings.voiceCallPause],
        source: "web",
      },
    });
  });

  const toggle = useStableCallback(() => {
    const call = readActiveVoiceCall();
    if (call && call.threadKey === threadKey) call.call.stop();
    else void start();
  });

  const canStart = blocker?.kind !== "blocked" && !input.disabled;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the call shortcut and palette entry while this thread's composer is mounted
  useEffect(() => {
    if (!threadKey) return;
    const disposeCommand = registerCommands({
      "composer.voiceCall": (event) => {
        event.preventDefault();
        if (!event.repeat) toggle();
      },
    });
    const disposeStarter = canStart ? registerVoiceCallStarter(threadKey, toggle) : undefined;
    return () => {
      disposeCommand();
      disposeStarter?.();
    };
  }, [threadKey, toggle, canStart]);

  return {
    /** False hides the button: nothing on this thread can start a call. */
    visible: threadRef !== null,
    blockedReason: blocker?.kind === "blocked" ? blocker.reason : null,
    starting,
    activeCall,
    onThisThread: activeCall !== null && activeCall.threadKey === threadKey,
    start,
    toggle,
  };
}
