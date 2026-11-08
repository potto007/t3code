import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  cancelEnvironmentVoiceFrontModelDownload,
  cancelEnvironmentVoicePackDownload,
  cancelEnvironmentVoiceTtsModelDownload,
  downloadEnvironmentVoiceFrontModel,
  downloadEnvironmentVoicePack,
  downloadEnvironmentVoiceTtsModel,
  getEnvironmentVoiceFrontModels,
  getEnvironmentVoicePack,
  getEnvironmentVoiceTtsModel,
  removeEnvironmentVoiceFrontModel,
  removeEnvironmentVoicePack,
  removeEnvironmentVoiceTtsModel,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  DEFAULT_VOICE_FRONT_MODEL,
  type EnvironmentVoiceFrontModels,
  type EnvironmentVoicePack,
  type EnvironmentVoiceTtsModel,
  VOICE_TTS_VOICES,
  VoiceFrontModel,
  type VoiceIdleTimeout,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { StarIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  formatModelSize,
  isModelDownloading,
  ModelActions,
  ModelDownloadProgress,
} from "./ModelDownloadControls";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const IDLE_LABELS: Record<VoiceIdleTimeout, string> = {
  min_5: "After 5 minutes",
  min_10: "After 10 minutes",
  min_30: "After 30 minutes",
  never: "Never",
};

const isFrontModel = Schema.is(VoiceFrontModel);

/** An environment's download catalog (models or the voice pack), polled while a download runs. */
function useEnvironmentDownloads<T>(
  prepared: PreparedConnection | null,
  load: (prepared: PreparedConnection) => Promise<T>,
  isDownloading: (data: T) => boolean,
) {
  const canManage = useEnvironmentScope(prepared?.environmentId ?? null, AuthSettingsWriteScope);
  const [data, setData] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [connection, setConnection] = useState(prepared);
  if (connection !== prepared) {
    setConnection(prepared);
    setData(null);
    setBusy(false);
    setRequestedDownload(null);
  }
  const epoch = useRef(0);
  const refresh = useStableCallback(async (target: PreparedConnection) => {
    const current = epoch.current;
    const next = await load(target).catch(() => null);
    if (next && current === epoch.current) setData(next);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared);
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading = requestedDownload !== null || (data !== null && isDownloading(data));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls progress while a local request or the environment reports an active download
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared);
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloading, prepared, refresh]);
  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    const error = await work().then(
      () => null,
      (cause: unknown) => cause,
    );
    if (current !== epoch.current) return;
    if (error !== null)
      toastManager.add({
        type: "error",
        title: label,
        description: error instanceof Error ? error.message : String(error),
      });
    if (downloadId) setRequestedDownload(null);
    else setBusy(false);
    await refresh(prepared);
  };
  return { data, run, canManage, busy: busy || downloading || !canManage, requestedDownload };
}

const loadFrontModels = (prepared: PreparedConnection) =>
  runEnvironmentSpeech(getEnvironmentVoiceFrontModels(prepared));
const anyFrontModelDownloading = (catalog: EnvironmentVoiceFrontModels) =>
  catalog.models.some(isModelDownloading);

function FrontModelList(props: {
  readonly prepared: PreparedConnection;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
}) {
  const { prepared } = props;
  const catalog = useEnvironmentDownloads(prepared, loadFrontModels, anyFrontModelDownloading);
  if (catalog.data === null)
    return <span className="text-xs text-muted-foreground">{props.selected}</span>;
  return (
    <div className="w-full divide-y divide-border/60 rounded-lg border border-border/60">
      {catalog.data.models.map((listed) => {
        const model = {
          ...listed,
          // The setting is the selection; reading it here keeps the badge current before a refetch.
          active: listed.id === props.selected,
          state:
            listed.id === catalog.requestedDownload && listed.state === "downloadable"
              ? ("downloading" as const)
              : listed.state,
        };
        return (
          <div key={model.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium leading-5">{model.name}</span>
                {model.recommended ? (
                  <Badge variant="outline">
                    <StarIcon className="mr-1 size-3" />
                    Recommended
                  </Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {model.description} · {formatModelSize(model.size)}
              </p>
              <ModelDownloadProgress model={model} />
            </div>
            <ModelActions
              model={model}
              busy={catalog.busy}
              canCancel={catalog.canManage}
              onDownload={() =>
                void catalog.run(
                  "Could not download the conversation model",
                  () =>
                    runEnvironmentSpeech(downloadEnvironmentVoiceFrontModel(prepared, model.id)),
                  model.id,
                )
              }
              onSelect={() => props.onSelect(model.id)}
              onCancel={() =>
                void catalog.run("Could not cancel the download", () =>
                  runEnvironmentSpeech(
                    cancelEnvironmentVoiceFrontModelDownload(prepared, model.id),
                  ),
                )
              }
              onDelete={() =>
                void catalog.run("Could not delete the conversation model", () =>
                  runEnvironmentSpeech(removeEnvironmentVoiceFrontModel(prepared, model.id)),
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}

const VARIANT_LABELS: Record<EnvironmentVoicePack["variant"], string> = {
  cpu: "CPU",
  vulkan: "Vulkan GPU",
  cuda: "NVIDIA CUDA",
  metal: "Apple Metal",
};

const loadVoicePack = (prepared: PreparedConnection) =>
  runEnvironmentSpeech(getEnvironmentVoicePack(prepared));
const isPackDownloading = (pack: EnvironmentVoicePack) =>
  pack.state === "downloading" || pack.state === "verifying";

function VoicePackDetails(props: {
  readonly prepared: PreparedConnection;
  readonly environmentLabel: string;
}) {
  const { prepared } = props;
  const pack = useEnvironmentDownloads(prepared, loadVoicePack, isPackDownloading);
  if (pack.data === null) return null;
  if (!pack.data.supported)
    return (
      <p className="text-xs text-muted-foreground">
        Voice calls aren't available on {props.environmentLabel}'s platform.
      </p>
    );
  const status = pack.data;
  const model = {
    name: "Voice pack",
    size: status.size,
    ...(status.downloaded === undefined ? {} : { downloaded: status.downloaded }),
    state:
      pack.requestedDownload !== null && status.state === "downloadable"
        ? ("downloading" as const)
        : status.state,
    active: status.state === "installed",
  };
  const download = (variant: "auto" | "cpu") =>
    void pack.run(
      "Could not download the voice pack",
      () => runEnvironmentSpeech(downloadEnvironmentVoicePack(prepared, variant)),
      variant,
    );
  return (
    <div className="flex w-full flex-wrap items-start gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-5">{VARIANT_LABELS[status.variant]}</span>
          <Badge variant="outline">{formatModelSize(status.size)}</Badge>
        </div>
        {status.cudaRuntimeSize !== undefined ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Includes {formatModelSize(status.cudaRuntimeSize)} of NVIDIA's CUDA runtime, because{" "}
            {props.environmentLabel} has the NVIDIA driver but not the CUDA toolkit. It is licensed
            under the{" "}
            <a
              className="underline"
              href="https://docs.nvidia.com/cuda/eula/index.html"
              target="_blank"
              rel="noreferrer"
            >
              NVIDIA CUDA EULA
            </a>
            .
          </p>
        ) : null}
        {status.gpuError !== undefined ? (
          <p className="mt-0.5 text-xs leading-relaxed text-warning-foreground">
            The {VARIANT_LABELS[status.variant]} build didn't load, so calls run on the CPU:{" "}
            {status.gpuError}
          </p>
        ) : null}
        <ModelDownloadProgress model={model} />
      </div>
      <ModelActions
        model={model}
        installedLabel="Installed"
        busy={pack.busy}
        canCancel={pack.canManage}
        onDownload={() => download("auto")}
        onSelect={() => undefined}
        onCancel={() =>
          void pack.run("Could not cancel the download", () =>
            runEnvironmentSpeech(cancelEnvironmentVoicePackDownload(prepared)),
          )
        }
        onDelete={() =>
          void pack.run("Could not delete the voice pack", () =>
            runEnvironmentSpeech(removeEnvironmentVoicePack(prepared)),
          )
        }
      >
        {status.cpuSize !== undefined && model.state === "downloadable" ? (
          <Button size="sm" variant="ghost" disabled={pack.busy} onClick={() => download("cpu")}>
            Use CPU ({formatModelSize(status.cpuSize)})
          </Button>
        ) : null}
      </ModelActions>
    </div>
  );
}

/** Voice calls run their speech and conversation runtime on the thread's environment. */
function VoicePackRow() {
  const { environment } = useSettingsScope();
  const prepared = Option.getOrNull(usePreparedConnection(environment?.environmentId ?? null));
  const label = environment?.label ?? "this environment";
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("voice-call-pack")}
      title="Voice pack"
      description={
        <>
          The speech and conversation runtime for voice calls, downloaded to {label}. It includes{" "}
          <a
            className="underline"
            href="https://github.com/espeak-ng/espeak-ng"
            target="_blank"
            rel="noreferrer"
          >
            eSpeak NG
          </a>{" "}
          (GPL-3.0-or-later) for pronunciation.
        </>
      }
    >
      <div className="pb-3.5">
        {prepared ? <VoicePackDetails prepared={prepared} environmentLabel={label} /> : null}
      </div>
    </SettingsRow>
  );
}

const loadTtsModel = (prepared: PreparedConnection) =>
  runEnvironmentSpeech(getEnvironmentVoiceTtsModel(prepared));
const isTtsModelDownloading = (model: EnvironmentVoiceTtsModel) =>
  model.state === "downloading" || model.state === "verifying";

function TtsModelDetails(props: { readonly prepared: PreparedConnection }) {
  const { prepared } = props;
  const tts = useEnvironmentDownloads(prepared, loadTtsModel, isTtsModelDownloading);
  if (tts.data === null) return null;
  const status = tts.data;
  const model = {
    name: status.name,
    size: status.size,
    ...(status.downloaded === undefined ? {} : { downloaded: status.downloaded }),
    state:
      tts.requestedDownload !== null && status.state === "downloadable"
        ? ("downloading" as const)
        : status.state,
    active: status.state === "installed",
  };
  return (
    <div className="flex w-full flex-wrap items-start gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-5">{status.name}</span>
          <Badge variant="outline">{formatModelSize(status.size)}</Badge>
        </div>
        {status.error !== undefined && model.state === "downloadable" ? (
          <p className="mt-0.5 text-xs leading-relaxed text-warning-foreground">
            The last download failed: {status.error}
          </p>
        ) : null}
        <ModelDownloadProgress model={model} />
      </div>
      <ModelActions
        model={model}
        installedLabel="Installed"
        busy={tts.busy}
        canCancel={tts.canManage}
        onDownload={() =>
          void tts.run(
            "Could not download the voice model",
            () => runEnvironmentSpeech(downloadEnvironmentVoiceTtsModel(prepared)),
            "tts",
          )
        }
        onSelect={() => undefined}
        onCancel={() =>
          void tts.run("Could not cancel the download", () =>
            runEnvironmentSpeech(cancelEnvironmentVoiceTtsModelDownload(prepared)),
          )
        }
        onDelete={() =>
          void tts.run("Could not delete the voice model", () =>
            runEnvironmentSpeech(removeEnvironmentVoiceTtsModel(prepared)),
          )
        }
      />
    </div>
  );
}

/** The voice renders on the thread's environment, so its model downloads there. */
function TtsModelRow() {
  const { environment } = useSettingsScope();
  const prepared = Option.getOrNull(usePreparedConnection(environment?.environmentId ?? null));
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("voice-call-tts-model")}
      title="Voice model"
      description={`The speech model a voice call talks with, downloaded to ${environment?.label ?? "this environment"}.`}
    >
      <div className="pb-3.5">{prepared ? <TtsModelDetails prepared={prepared} /> : null}</div>
    </SettingsRow>
  );
}

/** The front model answers on the thread's environment, so it is an environment setting there. */
function FrontModelRow() {
  const { environment } = useSettingsScope();
  const prepared = Option.getOrNull(usePreparedConnection(environment?.environmentId ?? null));
  const frontModel = useScopedSettings((settings) => settings.voiceFrontModel);
  const updateSettings = useUpdateScopedSettings();
  const server = typeof frontModel === "string" ? null : frontModel;
  // Choosing a server saves nothing until both its URL and model name are filled in.
  const [choosingServer, setChoosingServer] = useState(false);
  const showServer = server !== null || choosingServer;
  const [draft, setDraft] = useState({ url: "", model: "" });
  const saveServer = (next: { url: string; model: string }) => {
    const value = { url: next.url.trim(), model: next.model.trim() };
    if (!value.url || !value.model) return;
    if (!isFrontModel(value)) {
      toastManager.add({
        type: "error",
        title: "Conversation model not saved",
        description: "Enter an http or https URL.",
      });
      return;
    }
    if (value.url !== server?.url || value.model !== server?.model)
      updateSettings({ voiceFrontModel: value });
    setChoosingServer(false);
  };
  const current = server ?? draft;
  const edit = (patch: Partial<typeof draft>) => {
    const next = { ...current, ...patch };
    if (!server) setDraft(next);
    saveServer(next);
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["voiceFrontModel"]}
      {...searchableSetting("voice-call-front-model")}
      title="Conversation model"
      description={
        server
          ? `${environment?.label ?? "This environment"} sends each turn to this OpenAI-compatible server instead of loading a model of its own.`
          : `A small model on ${environment?.label ?? "this environment"} answers small talk and hands real work to the thread's agent.`
      }
      resetAction={
        frontModel !== DEFAULT_VOICE_FRONT_MODEL ? (
          <SettingResetButton
            label="conversation model"
            onClick={() => updateSettings({ voiceFrontModel: DEFAULT_VOICE_FRONT_MODEL })}
          />
        ) : null
      }
      control={
        <Select
          value={showServer ? "server" : "managed"}
          onValueChange={(value) => {
            setChoosingServer(value === "server");
            if (value === "managed" && server)
              updateSettings({ voiceFrontModel: DEFAULT_VOICE_FRONT_MODEL });
          }}
        >
          <SelectTrigger size="sm" aria-label="Conversation model source" className="max-w-64">
            <SelectValue>{showServer ? "OpenAI-compatible server" : "Managed model"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="managed">Managed model</SelectItem>
            <SelectItem value="server">OpenAI-compatible server</SelectItem>
          </SelectPopup>
        </Select>
      }
    >
      <div className="flex flex-wrap gap-2 pb-3.5">
        {showServer ? (
          <>
            <Input
              key={`url:${current.url}`}
              aria-label="Conversation server URL"
              placeholder="http://127.0.0.1:8080/v1"
              defaultValue={current.url}
              className="min-w-56 flex-1"
              onBlur={(event) => edit({ url: event.target.value })}
            />
            <Input
              key={`model:${current.model}`}
              aria-label="Conversation server model name"
              placeholder="Model name"
              defaultValue={current.model}
              className="w-48"
              onBlur={(event) => edit({ model: event.target.value })}
            />
          </>
        ) : prepared && typeof frontModel === "string" ? (
          <FrontModelList
            prepared={prepared}
            selected={frontModel}
            onSelect={(id) => updateSettings({ voiceFrontModel: id })}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {typeof frontModel === "string" ? frontModel : null}
          </span>
        )}
      </div>
    </SettingsRow>
  );
}

export function VoiceConversationSettings() {
  const settings = useClientSettings();
  const settingsScope = useOptionalSettingsScope();
  return (
    <SettingsSection id="voice-conversation" title="Conversation">
      <SettingsRow
        {...searchableSetting("voice-call-voice")}
        title="Voice"
        description="How the voice call sounds. Rendered on the thread's environment."
        control={
          <Select
            value={settings.voiceTtsVoice}
            onValueChange={(value) => {
              if (value) void updateClientSettings({ voiceTtsVoice: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Call voice" className="max-w-64">
              <SelectValue>
                {VOICE_TTS_VOICES[settings.voiceTtsVoice] ?? settings.voiceTtsVoice}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(VOICE_TTS_VOICES).map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {settingsScope !== null ? <VoicePackRow /> : null}
      {settingsScope !== null ? <TtsModelRow /> : null}
      {settingsScope !== null ? <FrontModelRow /> : null}
      <SettingsRow
        {...searchableSetting("voice-call-idle-timeout")}
        title="Hang up when quiet"
        description="End the call after this long without anyone speaking."
        control={
          <Select
            value={settings.voiceCallIdleTimeout}
            onValueChange={(value) => {
              if (value)
                void updateClientSettings({ voiceCallIdleTimeout: value as VoiceIdleTimeout });
            }}
          >
            <SelectTrigger size="sm" aria-label="Hang up when quiet" className="max-w-64">
              <SelectValue>{IDLE_LABELS[settings.voiceCallIdleTimeout]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(IDLE_LABELS) as VoiceIdleTimeout[]).map((timeout) => (
                <SelectItem key={timeout} value={timeout}>
                  {IDLE_LABELS[timeout]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
