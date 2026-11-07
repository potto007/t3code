import { expect, it, vi } from "vite-plus/test";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import { createBrowserVoiceCallPlatform } from "./browserVoiceCall";

it("cancels an unanswered permission prompt and stops a late microphone stream", async () => {
  let grantPermission!: (media: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  const rejected = vi.fn();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal).catch(rejected);
  // Dictation keeps the raw signal; only calls ask for voice processing.
  expect(microphone).toHaveBeenCalledExactlyOnceWith({ audio: true });
  abort.abort();
  const stop = vi.fn();
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(abort.signal.reason));
  } finally {
    grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await preparing;
  }
  expect(stop).toHaveBeenCalledOnce();
});

it("asks for echo cancellation on a call's microphone and abandons a late grant", async () => {
  let grantPermission!: (media: MediaStream) => void;
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(
    new Promise<MediaStream>((resolve) => {
      grantPermission = resolve;
    }),
  );
  const abort = new AbortController();
  const starting = createBrowserVoiceCallPlatform({ microphoneId: "usb-mic" }).startCapture({
    signal: abort.signal,
    onPcm: vi.fn(),
    onError: vi.fn(),
  });
  expect(microphone).toHaveBeenCalledExactlyOnceWith({
    audio: {
      deviceId: { exact: "usb-mic" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  abort.abort();
  await expect(starting).rejects.toBe(abort.signal.reason);
  const stop = vi.fn();
  grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
});
