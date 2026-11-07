import type { VoiceCallCaption, VoiceCallPhase } from "@t3tools/client-runtime/voice-call";
import { useNavigate } from "@tanstack/react-router";
import { AudioLinesIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ActiveVoiceCall } from "../../speech/voiceCall";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PHASE_LABELS: Record<VoiceCallPhase, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  delegated: "Agent is working",
  ended: "Ended",
};

export function ComposerVoiceCallButton(props: {
  blockedReason: string | null;
  starting: boolean;
  disabled: boolean;
  shortcutLabel: string | null;
  onStart(): void;
}) {
  const label = props.blockedReason ?? "Start voice";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Start voice"
            disabled={props.disabled || props.starting || props.blockedReason !== null}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onStart}
            className="shrink-0"
          >
            {props.starting ? <Spinner aria-hidden /> : <AudioLinesIcon />}
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {props.blockedReason === null && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function Caption(props: { who: string; caption: VoiceCallCaption | null }) {
  if (!props.caption || !(props.caption.committed + props.caption.tentative).trim()) return null;
  return (
    <p className="min-w-0 break-words">
      <span className="me-1.5 text-xs font-medium text-muted-foreground">{props.who}</span>
      <span>{props.caption.committed}</span>
      <span className="text-muted-foreground">{props.caption.tentative}</span>
    </p>
  );
}

/** The live call: who said what, and the way out. Static styling only; captions carry the motion. */
export function VoiceCallStrip(props: { call: ActiveVoiceCall; onThisThread: boolean }) {
  const navigate = useNavigate();
  const { state, call, threadRef } = props.call;
  return (
    <div
      role="region"
      aria-label="Voice call"
      className="mx-3 mb-3 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm sm:mx-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            state.phase === "speaking"
              ? "bg-primary"
              : state.phase === "listening"
                ? "bg-success"
                : "bg-muted-foreground/50",
          )}
        />
        <span role="status" className="min-w-0 flex-1 truncate font-medium">
          {props.onThisThread
            ? `Voice call · ${PHASE_LABELS[state.phase]}`
            : "Voice call on another thread"}
          {state.muted ? " · Muted" : ""}
        </span>
        {props.onThisThread ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={state.muted}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => call.setMuted(!state.muted)}
          >
            {state.muted ? <MicOffIcon /> : <MicIcon />}
            {state.muted ? "Unmute" : "Mute"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadRef),
              })
            }
          >
            Go to call
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => call.stop()}
        >
          <PhoneOffIcon />
          Stop
        </Button>
      </div>
      {props.onThisThread ? (
        <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
          <Caption who="You" caption={state.you} />
          <Caption who="Voice" caption={state.voice} />
        </div>
      ) : null}
    </div>
  );
}
