import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

import { SettingsPageContainer, SettingsSearchTarget } from "./settingsLayout";

function Page(props: { above: number }) {
  return (
    <SettingsPageContainer>
      {/* Tailwind is not loaded here, so the scroller gets its height inline. */}
      <style>{"[data-settings-page-scroll] { height: 400px; overflow-y: auto }"}</style>
      <div style={{ height: props.above }} />
      <SettingsSearchTarget id="row">Row</SettingsSearchTarget>
      <div style={{ height: 3000 }} />
    </SettingsPageContainer>
  );
}

const inView = (row: HTMLElement) => {
  const scroller = row.closest<HTMLElement>("[data-settings-page-scroll]")!.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  return rect.top >= scroller.top && rect.bottom <= scroller.bottom;
};

it("keeps a linked row in view when content above it loads late", async () => {
  await using screen = await render(<Page above={1000} />, { router: "/#row" });
  const row = screen.getByText("Row").element() as HTMLElement;
  // The smooth scroll toward the row is still running when the content above grows.
  await screen.rerender(<Page above={2500} />);
  await vi.waitFor(() => expect(inView(row)).toBe(true));
});
