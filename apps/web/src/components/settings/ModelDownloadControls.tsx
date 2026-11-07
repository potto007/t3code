import type { EnvironmentSpeechModelState } from "@t3tools/contracts";
import { CheckIcon, DownloadIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";

/** What the download controls need from a speech or conversation model. */
export type DownloadableModel = {
  readonly name: string;
  readonly size: number;
  readonly downloaded?: number;
  readonly state: EnvironmentSpeechModelState;
  readonly active: boolean;
};

export const formatModelSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export const isModelDownloading = (model: DownloadableModel) =>
  model.state === "downloading" || model.state === "verifying";

export function ModelDownloadProgress(props: { readonly model: DownloadableModel }) {
  const { model } = props;
  if (!isModelDownloading(model)) return null;
  const progress = model.downloaded === undefined ? 0 : (model.downloaded / model.size) * 100;
  return (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-label={`${model.name} download progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-2xs text-muted-foreground">
        {model.state === "verifying"
          ? "Verifying download…"
          : `${Math.round(progress)}% downloaded`}
      </p>
    </div>
  );
}

export function ModelActions(props: {
  readonly model: DownloadableModel;
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly children?: ReactNode;
}) {
  const { model } = props;
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
      {props.children}
      {isModelDownloading(model) ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Cancel ${model.name} download`}
          disabled={!props.canCancel}
          onClick={props.onCancel}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : model.state === "downloadable" ? (
        <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onDownload}>
          <DownloadIcon className="mr-1.5 size-3.5" />
          Download
        </Button>
      ) : model.active ? (
        <Button size="sm" variant="secondary" disabled>
          <CheckIcon className="mr-1.5 size-3.5" />
          Selected
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
          Use model
        </Button>
      )}
      {model.state === "installed" ? (
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={props.busy}
          aria-label={`Delete ${model.name}`}
          onClick={props.onDelete}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
