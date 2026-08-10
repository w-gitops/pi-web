// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("PromptEditor connection recovery", () => {
  it("keeps draft editing available but prevents prompt dispatch while reconnecting", async () => {
    const onSend = vi.fn();
    const editor = new PromptEditor();
    editor.reconnecting = true;
    editor.onSend = onSend;
    document.body.append(editor);
    await editor.updateComplete;

    const send = editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button");
    expect(editor.shadowRoot?.textContent).toContain("Reconnecting…");
    expect(send?.disabled).toBe(true);
    expect(editor.shadowRoot?.querySelector<HTMLElement>(".markdown-editor")?.getAttribute("aria-disabled")).toBe("false");

    send?.click();
    expect(onSend).not.toHaveBeenCalled();
  });
});
