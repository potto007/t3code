#!/usr/bin/env node
// An eval script, not server code: it loads a local GGUF through the server's front worker.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { holdOutwardRequest, isOutwardRequest } from "../../apps/server/src/voice/confirmation.ts";
import { parseFrontDecision } from "../../apps/server/src/voice/decision.ts";
import type { FrontDecision } from "../../apps/server/src/voice/FrontModel.ts";
import { loadFrontLlama } from "../../apps/server/src/voice/llama.ts";
import { makeFrontHistory } from "../../apps/server/src/voice/prompts.ts";
import { cases } from "./cases.ts";
import { falseClaim, sendsNothing } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    pack: { type: "string" },
    gpu: { type: "string", default: "auto" },
    case: { type: "string", multiple: true },
    baseline: { type: "string" },
    regrade: { type: "string" },
  },
});
const { out, model, pack } = values;
const selected = cases.filter((c) => !values.case || values.case.includes(c.id));
if (!out || !(values.regrade || (model && pack)) || selected.length === 0)
  throw new Error(
    "Use --out <directory> (--model <gguf> --pack <voice pack root> [--gpu auto|false] | --regrade <results.json>) [--case <id>]... [--baseline <results.json>].",
  );

type Sample = { readonly id: string; readonly raw: string; readonly ms: number };
type Row = Sample & {
  readonly decision: FrontDecision | undefined;
  readonly actionOk?: boolean;
  readonly outwardFlag?: boolean;
  readonly backstop?: boolean;
  readonly falseClaim: boolean;
};
type Results = {
  readonly summary: { readonly model: string; readonly gpu: string };
  readonly rows: readonly Row[];
};
const print = (...parts: readonly string[]) => process.stdout.write(`${parts.join(" ")}\n`);
const readResults = (file: string): Results => JSON.parse(NodeFS.readFileSync(file, "utf8"));

async function sample(modelPath: string, packRoot: string) {
  const llama = await loadFrontLlama(modelPath, new AbortController().signal, {
    packRoot,
    gpu: values.gpu === "false" ? false : "auto",
  });
  const samples: Sample[] = [];
  try {
    for (const testCase of selected) {
      const history = makeFrontHistory();
      for (const exchange of testCase.history) history.commit(exchange.inputs, exchange.decision);
      const start = performance.now();
      let streamed = "";
      const raw = await llama.decide(
        history.messages([testCase.input]),
        new AbortController().signal,
        (chunk) => (streamed += chunk),
      );
      // The call renders from the stream, so it must spell out the same decision.
      if (streamed.trim() !== raw.trim()) print("STREAM MISMATCH", testCase.id, streamed);
      samples.push({ id: testCase.id, raw, ms: performance.now() - start });
      print(testCase.id, raw);
    }
  } finally {
    await llama.dispose();
  }
  return { model: NodePath.basename(modelPath), gpu: llama.gpu, samples };
}

const run = values.regrade
  ? (() => {
      const saved = readResults(values.regrade);
      return {
        ...saved.summary,
        samples: saved.rows.filter((row) => selected.some((c) => c.id === row.id)),
      };
    })()
  : await sample(model!, pack!);

const caseOf = (id: string) => selected.find((c) => c.id === id)!;
const saidIn = (id: string) => {
  const { input } = caseOf(id);
  return input.type === "user" ? input.text : "";
};

function grade(sample: Sample, decision: FrontDecision | undefined): Row {
  const testCase = caseOf(sample.id);
  const said = saidIn(sample.id);
  return {
    ...sample,
    decision,
    ...(testCase.expect
      ? { actionOk: decision !== undefined && testCase.expect.includes(decision.action) }
      : {}),
    ...(testCase.outward === undefined
      ? {}
      : {
          outwardFlag: decision?.outward === true,
          backstop: isOutwardRequest(said) || isOutwardRequest(decision?.task ?? ""),
        }),
    falseClaim: falseClaim(testCase, decision),
  };
}

function summarize(scored: readonly Row[]) {
  const wantsDelegate = (row: Row) => caseOf(row.id).expect?.includes("delegate") === true;
  const decisionRows = scored.filter(
    (row) => row.actionOk !== undefined && !row.id.startsWith("claim-"),
  );
  const claimRows = scored.filter((row) => row.id.startsWith("claim-"));
  const controls = claimRows.filter(wantsDelegate);
  const flag = (pick: (row: Row) => boolean) => {
    const flagged = scored.filter((row) => row.outwardFlag !== undefined);
    const want = (row: Row) => caseOf(row.id).outward === true;
    const tp = flagged.filter((row) => pick(row) && want(row)).length;
    const fp = flagged.filter((row) => pick(row) && !want(row)).length;
    const fn = flagged.filter((row) => !pick(row) && want(row)).length;
    return {
      tp,
      fp,
      fn,
      precision: +(tp / (tp + fp)).toFixed(3),
      recall: +(tp / (tp + fn)).toFixed(3),
    };
  };
  const silent = scored.filter((row) => sendsNothing(caseOf(row.id), row.decision));
  const claims = scored.filter((row) => row.falseClaim).map((row) => row.id);
  return {
    decisions: `${decisionRows.filter((row) => row.actionOk).length}/${decisionRows.length}`,
    claimActions: `${claimRows.filter((row) => row.actionOk).length}/${claimRows.length}`,
    claimControlsDelegated: `${controls.filter((row) => row.decision?.action === "delegate").length}/${controls.length}`,
    falseClaims: claims,
    falseClaimRate: `${claims.length}/${silent.length} turns that send nothing`,
    outwardFront: flag((row) => row.outwardFlag === true),
    outwardEither: flag((row) => row.outwardFlag === true || row.backstop === true),
  };
}

const rows = run.samples.map((sample) => {
  const row = grade(sample, parseFrontDecision(sample.raw));
  const testCase = caseOf(row.id);
  const miss =
    row.actionOk === false ||
    row.falseClaim ||
    (row.outwardFlag ?? testCase.outward) !== testCase.outward;
  if (miss) print("MISS", row.id, row.raw);
  return row;
});
// What the call does: the service holds a reply or silence to an outward request for a yes.
const shipped = rows.map((row) =>
  grade(row, row.decision && holdOutwardRequest(row.decision, saidIn(row.id))),
);
const times = rows.map((row) => row.ms).toSorted((a, b) => a - b);
const summary = {
  model: run.model,
  gpu: run.gpu,
  cases: rows.length,
  medianMs: Math.round(times[times.length >> 1] ?? 0),
  front: summarize(rows),
  shipped: summarize(shipped),
};
print("SUMMARY", JSON.stringify(summary));

if (values.baseline) {
  const before = readResults(values.baseline).rows;
  for (const row of rows) {
    const old = before.find((candidate) => candidate.id === row.id);
    if (!old) continue;
    const changed =
      old.actionOk !== row.actionOk ||
      old.falseClaim !== row.falseClaim ||
      old.outwardFlag !== row.outwardFlag;
    if (changed) print("CHANGED", row.id, "\n  before", old.raw, "\n  after ", row.raw);
  }
}

NodeFS.mkdirSync(out, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(out, "results.json"),
  JSON.stringify({ summary, rows }, null, 2),
);
