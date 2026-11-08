import {
  CommandId,
  MessageId,
  type RunId,
  type ThreadId,
  type VoiceConversationOptions,
  type VoiceConversationState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SpeechService from "../speech/SpeechService.ts";
import * as TextToSpeech from "../speech/TextToSpeech.ts";
import {
  DEFAULT_TURN_SETTINGS,
  makeTurnDetector,
  pauseText,
  utteranceWords,
} from "../speech/turns.ts";
import {
  cancelSpeech,
  confirmationReadback,
  holdOutwardRequest,
  isOutwardRequest,
  startConfirmation,
  stepConfirmation,
  type Confirmation,
  type ConfirmationEvent,
} from "./confirmation.ts";
import * as FrontModel from "./FrontModel.ts";
import {
  delegationText,
  limitSpeech,
  makeFrontHistory,
  nextTurn,
  noteText,
  type FrontInput,
} from "./prompts.ts";
import {
  firstPiece,
  makeSpeaker,
  type PreparedSpeech,
  type Speaker,
  type VoiceCallOutput,
} from "./speaker.ts";
import {
  IDLE_SPECULATION,
  stepSpeculation,
  type Speculation,
  type SpeculationEvent,
} from "./speculation.ts";
import { classifyInterruption, ECHO_WINDOW_SAMPLES, heardOnlyEcho } from "./turnTaking.ts";

export type { VoiceCallOutput } from "./speaker.ts";

const userWords = (inputs: readonly FrontInput[]) =>
  inputs.flatMap((input) => (input.type === "user" ? [input.text] : [])).join(" ");

const IDLE_MINUTES = { min_5: 5, min_10: 10, min_30: 30, never: Infinity } as const;
/** A delegated run is checked on this often, so a long one never holds a single wait forever. */
const RUN_WAIT_MS = 10 * 60 * 1000;

export class VoiceCallError extends Schema.TaggedError<VoiceCallError>()("VoiceCallError", {
  operation: Schema.Literals(["thread", "listen", "speak", "think"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    switch (this.operation) {
      case "thread":
        return "The voice call couldn't open this thread.";
      case "listen":
        return "Speech recognition failed during the voice call.";
      case "speak":
        return "The voice couldn't be loaded.";
      case "think":
        return "The conversation model couldn't be loaded.";
    }
  }
}

export type VoiceCall = {
  /** One frame of 16 kHz mic PCM. */
  readonly hear: (pcm: Uint8Array) => Effect.Effect<void, VoiceCallError>;
  readonly played: (seq: number, sample: number) => Effect.Effect<void>;
  readonly mute: Effect.Effect<void, VoiceCallError>;
  readonly unmute: Effect.Effect<void>;
  /** The client's Confirm or Cancel for confirmation `id`; a stale id does nothing. */
  readonly answer: (id: number, confirm: boolean) => Effect.Effect<void>;
  /** Completes when the call ends itself: `idle` after the idle timeout. */
  readonly ended: Effect.Effect<"idle">;
};

export class VoiceConversationService extends Context.Service<
  VoiceConversationService,
  {
    /**
     * Starts a call on a thread. It holds speech recognition, the voice and the front
     * model until the scope closes, which is how every way out of a call frees them.
     */
    readonly start: (input: {
      readonly threadId: ThreadId;
      readonly options: VoiceConversationOptions;
      readonly send: (output: VoiceCallOutput) => Effect.Effect<void>;
    }) => Effect.Effect<VoiceCall, VoiceCallError, Scope.Scope>;
  }
>()("t3/voice/VoiceConversationService") {}

const make = Effect.gen(function* () {
  const speech = yield* SpeechService.SpeechService;
  const tts = yield* TextToSpeech.TextToSpeech;
  const frontModel = yield* FrontModel.FrontModel;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;

  const start = Effect.fn("VoiceConversationService.start")(function* ({
    threadId,
    options,
    send,
  }: Parameters<VoiceConversationService["Service"]["start"]>[0]) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const scope = yield* Effect.scope;
    const target = yield* threads.getThreadRecords(threadId, []).pipe(
      Effect.filterOrFail(
        (records) => records.thread.deletedAt === null && records.thread.archivedAt === null,
        (records) => new Error(`Thread ${records.thread.id} is closed.`),
      ),
      Effect.mapError((cause) => new VoiceCallError({ operation: "thread", cause })),
    );
    const thread = { projectId: target.thread.projectId, threadId };
    const where = `the agent on ${target.thread.title}`;
    const [stt, , front] = yield* Effect.all(
      [
        speech
          .startStream(options.transcription, "conversation")
          .pipe(Effect.mapError((cause) => new VoiceCallError({ operation: "listen", cause }))),
        tts.hold.pipe(
          Effect.mapError((cause) => new VoiceCallError({ operation: "speak", cause })),
        ),
        frontModel.acquire.pipe(
          Effect.mapError((cause) => new VoiceCallError({ operation: "think", cause })),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const detector = makeTurnDetector({
      ...DEFAULT_TURN_SETTINGS,
      ...(options.endSilenceMs === undefined ? {} : { endSilenceMs: options.endSilenceMs }),
      ...(options.endSilenceLongMs === undefined
        ? {}
        : { endSilenceLongMs: options.endSilenceLongMs }),
    });
    const idleSamples = 16_000 * 60 * IDLE_MINUTES[options.idleTimeout ?? "min_10"];
    const ended = yield* Deferred.make<"idle">();
    const history = makeFrontHistory();
    let state: VoiceConversationState | undefined;
    let muted = false;
    /** Mic samples since the call began, muted or not: the call's clock. */
    let clock = 0;
    let silent = 0;
    /** `said` is finalized at pauses; `text` is the live rest after it. */
    let utterance = { said: "", text: "", heard: false };
    /** Speech that started while the voice was speaking, and what the voice had left to say. */
    let interruption: { start: number; rest: string | undefined } | undefined;
    let pending: FrontInput[] = [];
    let thinking: { fiber: Fiber.Fiber<void>; inputs: readonly FrontInput[] } | undefined;
    /** An answer prepared during a pause, held until the turn ends. */
    let early: Speculation = IDLE_SPECULATION;
    let earlyRun:
      | {
          fiber: Fiber.Fiber<void>;
          inputs: readonly FrontInput[];
          commit: Deferred.Deferred<void>;
        }
      | undefined;
    /** Bumped whenever input reaches the front other than through the user's turn. */
    let context = 0;
    const notes: string[] = [];
    const runs = new Set<RunId>();
    let playedWords: { word: string; at: number }[] = [];
    /** An outward request held until the user says yes; it is sent only from `confirm`. */
    let confirming:
      | {
          readonly id: number;
          state: Confirmation;
          readonly acknowledgement: string;
          readonly notes: readonly string[];
          readonly send: Effect.Effect<void>;
        }
      | undefined;
    let confirmations = 0;

    const refresh: Effect.Effect<void> = Effect.suspend(() => {
      const next: VoiceConversationState = speaker.busy()
        ? "speaking"
        : thinking
          ? "thinking"
          : confirming
            ? "confirming"
            : runs.size > 0
              ? "delegated"
              : "listening";
      if (next === state) return Effect.void;
      state = next;
      return send({ type: "state", state: next });
    });
    const speaker: Speaker = yield* makeSpeaker({
      send,
      tts,
      voice: options.voice,
      changed: refresh,
    });
    const echo = () => {
      playedWords = playedWords.filter(({ at }) => clock - at <= ECHO_WINDOW_SAMPLES);
      return new Set(playedWords.map(({ word }) => word));
    };
    const ids = Effect.fn("VoiceConversationService.ids")(function* () {
      const id = yield* random.uuidV4().pipe(Effect.orDie);
      return { commandId: CommandId.make(`voice:${id}`), messageId: MessageId.make(`voice:${id}`) };
    });
    const sendToThread = Effect.fn("VoiceConversationService.sendToThread")(function* (
      text: string,
      mode: "auto" | "steer",
    ) {
      return yield* threads.sendToThread({
        ...thread,
        ...(yield* ids()),
        text,
        attachments: [],
        mode,
        createdBy: "user",
        creationSource: options.source,
      });
    });

    // A note steers a run that is working; with none, it rides along with the next request.
    const deliverNote = Effect.fn("VoiceConversationService.deliverNote")(function* (note: string) {
      if (runs.size === 0) return void notes.push(note);
      yield* sendToThread(noteText(note), "steer").pipe(
        Effect.catch((cause) =>
          Effect.logWarning("voice call note held for the next request", { cause }).pipe(
            Effect.andThen(Effect.sync(() => notes.push(note))),
          ),
        ),
      );
    });

    const watch = Effect.fn("VoiceConversationService.watchRun")(function* (runId: RunId) {
      let waited = yield* threads.waitForThread({ ...thread, runId, timeoutMs: RUN_WAIT_MS });
      while (waited.timedOut) {
        waited = yield* threads.waitForThread({ ...thread, runId, timeoutMs: RUN_WAIT_MS });
      }
      const run = waited.run;
      if (!run) return;
      // A restart continues a cut run as a new one; its answer is the one to read.
      const records = yield* threads.getProjectThreadRecords(thread, ["turnItems"], {
        turnItemTypes: ["assistant_message"],
        turnItemRunIds: [run.id],
      });
      const answer = records.turnItems
        .filter((item) => item.type === "assistant_message" && !item.streaming)
        .at(-1);
      pending.push({
        type: "result",
        status: run.status,
        text: answer?.type === "assistant_message" ? answer.text : "",
      });
      context++;
    });
    const follow = Effect.fn("VoiceConversationService.follow")(function* (runId: RunId) {
      if (runs.has(runId)) return;
      runs.add(runId);
      yield* watch(runId).pipe(
        Effect.catch((cause) => Effect.logError("voice call lost track of a run", { cause })),
        Effect.ensuring(
          Effect.suspend(() => {
            runs.delete(runId);
            // Thinking first, so the call never reports listening on its way to a readback.
            return think.pipe(Effect.andThen(refresh));
          }),
        ),
        Effect.forkIn(scope),
      );
    });

    // A failed send is told to the user: it may run outside any front turn.
    const sendSafely = <E>(send: Effect.Effect<void, E>) =>
      send.pipe(
        Effect.catch((cause) =>
          Effect.logError("voice call send failed", { cause }).pipe(
            Effect.andThen(speaker.speak("Sorry, that didn't work. Please try again.")),
            Effect.asVoid,
          ),
        ),
      );
    const act = Effect.fn("VoiceConversationService.act")(function* (
      decision: FrontModel.FrontDecision,
      inputs: readonly FrontInput[],
      rendering: Fiber.Fiber<PreparedSpeech | undefined>,
    ) {
      const speech = limitSpeech(decision.speech);
      const prepared = Fiber.join(rendering);
      const said = userWords(inputs);
      // Only the user starts work: acting on a bare agent result would loop run after run.
      const steersNote = decision.action === "note" && runs.size > 0;
      if (!said || !(decision.action === "delegate" || steersNote)) {
        if (speech) yield* speaker.speak(speech, yield* prepared);
        if (said && decision.action === "note") yield* deliverNote(decision.task?.trim() || said);
        return;
      }
      const task = decision.task?.trim() || said;
      const taken = decision.action === "delegate" ? notes.splice(0) : [];
      const deliver =
        decision.action === "delegate"
          ? Effect.gen(function* () {
              const text = delegationText({ words: said, task: decision.task, notes: taken });
              const sent = yield* sendToThread(text, "auto");
              yield* send({ type: "delegated", runId: sent.run.id, text });
              yield* follow(sent.run.id);
            })
          : deliverNote(task);
      const outward =
        decision.outward === true || [said, task, ...taken].some((text) => isOutwardRequest(text));
      if (!outward) {
        if (speech) yield* speaker.speak(speech, yield* prepared);
        return yield* deliver;
      }
      // The acknowledgement waits for a yes; nothing rendered for it is spoken now.
      yield* Fiber.interrupt(rendering);
      const id = ++confirmations;
      // An answer prepared meanwhile assumed no question was pending.
      context++;
      confirming = {
        id,
        state: startConfirmation(),
        acknowledgement: speech || "On it.",
        notes: taken,
        send: sendSafely(deliver),
      };
      const readback = confirmationReadback({ task, where });
      yield* send({ type: "confirm", id, text: readback });
      yield* speaker.speak(readback);
    });
    /** Applies one event to the pending confirmation; only a `send` step sends. */
    const confirm = Effect.fn("VoiceConversationService.confirm")(function* (
      event: ConfirmationEvent,
    ) {
      const current = confirming;
      if (!current) return;
      const step = stepConfirmation(current.state, event);
      if (step.type === "pending") {
        current.state = step.confirmation;
        return;
      }
      confirming = undefined;
      yield* send({ type: "confirmed", id: current.id, sent: step.type === "send" });
      if (event.type === "hangUp") return;
      if (speaker.busy() && !interruption) yield* speaker.cut;
      if (step.type === "send") {
        yield* speaker.speak(current.acknowledgement);
        yield* current.send;
      } else {
        notes.unshift(...current.notes);
        yield* speaker.speak(cancelSpeech(step.reason));
        if (step.words) pending.push({ type: "user", text: step.words });
      }
      yield* think;
      yield* refresh;
    });

    /**
     * Decides and acts on one turn. The first piece of the speech renders as soon as the front
     * has streamed it, while the rest of the decision generates; only `act` may speak it. An
     * early turn decides and renders, then waits for `commit`: nothing it does reaches the
     * user or the thread before that.
     */
    const respond = Effect.fn("VoiceConversationService.respond")(
      function* (inputs: readonly FrontInput[], commit: Deferred.Deferred<void> | undefined) {
        const piece = yield* Deferred.make<string | undefined>();
        const rendering = yield* Deferred.await(piece).pipe(
          Effect.flatMap((text) => (text ? speaker.prepare(text) : Effect.undefined)),
          Effect.catch((cause) =>
            Effect.logWarning("voice call could not render early", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
          Effect.forkChild,
        );
        const answer = yield* front
          .decide(history.messages(inputs), ({ action, speech, complete }) => {
            const text = action === "none" ? undefined : firstPiece(speech, complete);
            if (action === "none" || text) Deferred.doneUnsafe(piece, Effect.succeed(text));
          })
          .pipe(
            // Without streaming, only an early turn renders ahead, from the whole decision.
            Effect.tap((decision) =>
              Deferred.succeed(
                piece,
                commit && decision.action !== "none"
                  ? firstPiece(limitSpeech(decision.speech), true)
                  : undefined,
              ),
            ),
            Effect.exit,
          );
        if (commit) yield* Deferred.await(commit);
        const decision = holdOutwardRequest(yield* answer, userWords(inputs));
        // Committed before acting, so a barge-in from here on no longer takes the turn back.
        history.commit(inputs, decision);
        thinking = undefined;
        yield* act(decision, inputs, rendering);
      },
      // The user hears that the turn failed rather than waiting on silence.
      Effect.catch((cause) =>
        Effect.logError("voice call turn failed", { cause }).pipe(
          Effect.andThen(speaker.speak("Sorry, that didn't work. Please try again.")),
          Effect.asVoid,
        ),
      ),
      (effect, inputs) =>
        Effect.ensuring(
          effect,
          Effect.suspend(() => {
            if (thinking?.inputs === inputs) thinking = undefined;
            return think.pipe(Effect.andThen(refresh));
          }),
        ),
      Effect.forkIn(scope),
    );

    // The front answers once the user has finished: what they say next joins this turn.
    const think: Effect.Effect<void> = Effect.suspend(() => {
      if (thinking || confirming || pending.length === 0 || utterance.heard || interruption)
        return Effect.void;
      const inputs = nextTurn(pending);
      pending = pending.slice(inputs.length);
      return respond(inputs, undefined).pipe(
        Effect.flatMap((fiber) =>
          Effect.sync(() => {
            thinking = { fiber, inputs };
          }),
        ),
        Effect.andThen(refresh),
      );
    });

    // The turn as it would be if the user stopped now: only when their words lead it.
    const earlyInputs = (text: string) => {
      if (thinking || confirming || interruption || muted) return undefined;
      const user: FrontInput = { type: "user", text };
      const inputs = nextTurn([...pending, user]);
      return inputs.at(-1) === user ? inputs : undefined;
    };
    const speculate = Effect.fn("VoiceConversationService.speculate")(function* (
      event: SpeculationEvent,
    ) {
      const inputs = event.type === "pause" ? earlyInputs(event.text) : undefined;
      if (event.type === "pause" && !inputs) return;
      const step = stepSpeculation(early, event);
      early = step.state;
      const run = earlyRun;
      if (step.effect === "start" && inputs) {
        const commit = yield* Deferred.make<void>();
        earlyRun = { fiber: yield* respond(inputs, commit), inputs, commit };
      } else if (step.effect === "discard" && run) {
        earlyRun = undefined;
        yield* Fiber.interrupt(run.fiber);
      } else if (step.effect === "commit" && run) {
        earlyRun = undefined;
        // The user's own words were never queued; anything ahead of them in the turn was.
        pending = pending.slice(run.inputs.length - 1);
        thinking = { fiber: run.fiber, inputs: run.inputs };
        yield* Deferred.succeed(run.commit, undefined);
        yield* refresh;
      }
      return step.effect;
    });
    const stopThinking = Effect.suspend(() => {
      const current = thinking;
      if (!current) return Effect.void;
      thinking = undefined;
      pending = [...current.inputs, ...pending];
      context++;
      return Fiber.interrupt(current.fiber).pipe(Effect.andThen(refresh));
    });

    const nextUtterance = Effect.fn("VoiceConversationService.nextUtterance")(function* () {
      const text = utteranceWords(utterance.said, yield* stt.next);
      utterance = { said: "", text: "", heard: false };
      detector.reset();
      return text;
    });
    // While a request waits for a yes, the user's next words answer it instead of the front.
    const heard = Effect.fn("VoiceConversationService.heard")(function* (text: string) {
      if (!confirming) return void pending.push({ type: "user", text });
      yield* confirm({ type: "utterance", text, echo: heardOnlyEcho(text, echo()) });
    });
    const listen = Effect.fn("VoiceConversationService.listen")(function* (pcm: Uint8Array) {
      const update = yield* stt.feed(pcm);
      if (update.text) {
        utterance.text = `${update.text.committed}${update.text.tentative}`;
        yield* send({
          type: "caption",
          who: "you",
          committed: utteranceWords(utterance.said, update.text.committed),
          tentative: update.text.tentative,
        });
      }
      const chunkStart = update.samples - pcm.byteLength / 4;
      const turn = detector.observe({
        samples: update.samples,
        voicedUntil: update.voicedUntil,
        text: pauseText(utterance.said, utterance.text),
      });
      const words = utteranceWords(utterance.said, utterance.text);
      if (turn.heard) utterance.heard = true;
      // Speech or new words after a pause make an early answer stale.
      if (turn.heard) yield* speculate({ type: "speech" });
      else if (update.text) yield* speculate({ type: "text", text: words });
      if (turn.speechStarted) {
        yield* stopThinking;
        if (speaker.busy() && !interruption) interruption = { start: chunkStart, rest: undefined };
      }
      if (interruption) {
        // Speech over the voice pauses it, unless every word so far is the voice's own echo.
        if (interruption.rest === undefined && !heardOnlyEcho(words, echo()))
          interruption.rest = yield* speaker.cut;
        const verdict = classifyInterruption({
          text: words,
          start: interruption.start,
          voicedUntil: update.voicedUntil,
          samples: update.samples,
          echo: echo(),
        });
        if (verdict === "echo" || verdict === "backchannel") {
          const { rest } = interruption;
          interruption = undefined;
          const heard = yield* nextUtterance();
          yield* send({ type: "caption", who: "you", committed: "", tentative: "" });
          if (rest) yield* speaker.speak(rest);
          if (verdict === "backchannel") yield* deliverNote(`The user said "${heard.trim()}".`);
          return turn;
        }
        if (verdict === "turn") {
          if (interruption.rest === undefined) yield* speaker.cut;
          interruption = undefined;
          yield* confirm({ type: "bargeIn" });
        }
      }
      if (turn.ended) {
        // An early answer goes out first; the stream resets behind it.
        const answered =
          (yield* speculate({ type: "endpoint", text: words, context })) === "commit";
        if (answered) yield* send({ type: "caption", who: "you", committed: words, tentative: "" });
        const said = (yield* nextUtterance()).trim();
        // Words finalized only now, after an early answer, are a turn of their own.
        const text = answered ? said.slice(words.length).trim() : said;
        if (text) {
          if (!answered)
            yield* send({ type: "caption", who: "you", committed: text, tentative: "" });
          yield* heard(text);
        }
      } else if (turn.paused) {
        // A pause: close the words so far, and prepare the answer they would get.
        const said = yield* stt.segment;
        if (said) {
          utterance.said = utteranceWords(utterance.said, said);
          utterance.text = "";
        }
        yield* speculate({ type: "pause", text: utterance.said, context });
      }
      yield* think;
      return turn;
    });

    const call: VoiceCall = {
      hear: Effect.fn("VoiceConversationService.hear")(
        function* (pcm: Uint8Array) {
          const samples = pcm.byteLength / 4;
          clock += samples;
          const turn = muted ? undefined : yield* listen(pcm);
          yield* confirm({
            type: "audio",
            samples,
            voicePlaying: speaker.busy(),
            userSpeaking:
              turn?.heard === true ||
              utterance.said !== "" ||
              utterance.text.trim() !== "" ||
              !!interruption,
          });
          silent = turn?.heard || state !== "listening" ? 0 : silent + samples;
          if (silent >= idleSamples) {
            yield* send({ type: "idle" });
            yield* Deferred.succeed(ended, "idle");
          }
        },
        Effect.mapError((cause) => new VoiceCallError({ operation: "listen", cause })),
      ),
      played: Effect.fn("VoiceConversationService.played")(function* (seq: number, sample: number) {
        const fresh = yield* speaker.played(seq, sample);
        echo();
        for (const word of fresh) playedWords.push({ word, at: clock });
      }),
      mute: Effect.gen(function* () {
        muted = true;
        interruption = undefined;
        yield* speculate({ type: "speech" });
        if (utterance.said || utterance.text || utterance.heard) {
          yield* nextUtterance();
          yield* send({ type: "caption", who: "you", committed: "", tentative: "" });
          yield* think;
        }
      }).pipe(
        Effect.mapError((cause) => new VoiceCallError({ operation: "listen", cause })),
        Effect.withSpan("VoiceConversationService.mute"),
      ),
      unmute: Effect.sync(() => {
        muted = false;
      }),
      answer: (id, yes) =>
        confirming?.id === id ? confirm({ type: "answer", confirm: yes }) : Effect.void,
      ended: Deferred.await(ended),
    };
    // A hang-up drops a request still waiting for its yes.
    yield* Scope.addFinalizer(scope, confirm({ type: "hangUp" }));
    yield* send({ type: "ready" });
    yield* refresh;
    return call;
  });

  return VoiceConversationService.of({ start });
});

export const layer = Layer.effect(VoiceConversationService, make);
