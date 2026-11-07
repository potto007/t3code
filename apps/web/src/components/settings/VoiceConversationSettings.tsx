import {
  DEFAULT_VOICE_FRONT_MODEL,
  VOICE_TTS_VOICES,
  VoiceFrontModel,
  type VoiceIdleTimeout,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
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

/** The front model answers on the thread's environment, so it is an environment setting there. */
function FrontModelRow() {
  const { environment } = useSettingsScope();
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
          : `A small model on ${environment?.label ?? "this environment"} answers small talk and hands real work to the thread's agent. It downloads on first use.`
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
