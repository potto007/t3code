import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("offers each linked environment, disabled with its reason when it cannot take the thread", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      handoffTargets: [
        { environmentId: "environment-box", label: "Box", reason: null },
        {
          environmentId: "environment-vps",
          label: "VPS",
          reason: "No project with this repository",
        },
      ],
    });
    const continueOn = items.find((item) => item.id === "continue-on");
    expect(continueOn?.children).toEqual([
      { id: "continue-on:environment-box", label: "Box", disabled: false },
      {
        id: "continue-on:environment-vps",
        label: "VPS (No project with this repository)",
        disabled: true,
      },
    ]);
    // Without targets there is nothing to offer, and a running thread cannot move.
    expect(buildThreadActionMenuItems(baseState).some((item) => item.id === "continue-on")).toBe(
      false,
    );
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        isRunning: true,
        handoffTargets: [{ environmentId: "environment-box", label: "Box", reason: null }],
      }).find((item) => item.id === "continue-on")?.disabled,
    ).toBe(true);
    // A connection that cannot change threads cannot move one either.
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        handoffTargets: [{ environmentId: "environment-box", label: "Box", reason: null }],
      }).find((item) => item.id === "continue-on")?.disabled,
    ).toBe(true);
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
