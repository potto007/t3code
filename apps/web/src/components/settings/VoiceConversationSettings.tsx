import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  cancelEnvironmentVoiceFrontModelDownload,
  downloadEnvironmentVoiceFrontModel,
  getEnvironmentVoiceFrontModels,
  removeEnvironmentVoiceFrontModel,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  DEFAULT_VOICE_FRONT_MODEL,
  type EnvironmentVoiceFrontModel,
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

/** The environment's conversation model catalog, polled while a download runs. */
function useFrontModels(prepared: PreparedConnection | null) {
  const canManage = useEnvironmentScope(prepared?.environmentId ?? null, AuthSettingsWriteScope);
  const [models, setModels] = useState<readonly EnvironmentVoiceFrontModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [connection, setConnection] = useState(prepared);
  if (connection !== prepared) {
    setConnection(prepared);
    setModels(null);
    setBusy(false);
    setRequestedDownload(null);
  }
  const epoch = useRef(0);
  const refresh = useStableCallback(async (target: PreparedConnection) => {
    const current = epoch.current;
    const next = await runEnvironmentSpeech(getEnvironmentVoiceFrontModels(target)).catch(
      () => null,
    );
    if (next && current === epoch.current) setModels(next.models);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's conversation model catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared);
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading = requestedDownload !== null || (models ?? []).some(isModelDownloading);
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
  return { models, run, canManage, busy: busy || downloading || !canManage, requestedDownload };
}

function FrontModelList(props: {
  readonly prepared: PreparedConnection;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
}) {
  const { prepared } = props;
  const catalog = useFrontModels(prepared);
  if (catalog.models === null)
    return <span className="text-xs text-muted-foreground">{props.selected}</span>;
  return (
    <div className="w-full divide-y divide-border/60 rounded-lg border border-border/60">
      {catalog.models.map((listed) => {
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
