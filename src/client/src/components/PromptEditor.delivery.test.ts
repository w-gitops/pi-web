// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptDeliveryResult } from "../controllers/sessionController";
import { loadDraft } from "../promptDraftStorage";
import { machineSessionKey } from "../machineKeys";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("PromptEditor delivery retention", () => {
  it("clears the submitted draft only after confirmed success", async () => {
    const editor = await mountEditor();
    editor.replaceText("keep until accepted");
    await editor.updateComplete;

    let resolveSend!: (result: PromptDeliveryResult) => void;
    const onSend = vi.fn(() => new Promise<PromptDeliveryResult>((resolve) => { resolveSend = resolve; }));
    editor.onSend = onSend;

    clickSend(editor);
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledOnce();
    expect(editor.shadowRoot?.textContent).toContain("Sending…");
    expect(loadDraft(draftKey())).toBe("keep until accepted");

    resolveSend({ ok: true, kind: "accepted" });
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector(".delivery-warning")).toBeNull();
    });
    expect(loadDraft(draftKey())).toBe("");
    expect(editor.view?.state.doc.toString()).toBe("");
  });

  it("keeps draft and shows may-already-have-sent warning on delivery-unknown", async () => {
    const editor = await mountEditor();
    editor.replaceText("ambiguous prompt");
    editor.onSend = vi.fn(() => Promise.resolve({ ok: false, kind: "delivery-unknown" } satisfies PromptDeliveryResult));
    await editor.updateComplete;

    clickSend(editor);
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector(".delivery-warning")?.textContent).toContain("may already have been sent");
    });
    expect(editor.view?.state.doc.toString()).toBe("ambiguous prompt");
    expect(loadDraft(draftKey())).toBe("ambiguous prompt");
  });

  it("keeps draft on auth-required and rejected results without clearing attachments snapshot", async () => {
    const editor = await mountEditor();
    editor.replaceText("needs auth");
    const attachment = {
      id: "att-1",
      kind: "image" as const,
      mimeType: "image/png",
      data: "QUJD",
      name: "shot.png",
      size: 3,
    };
    Reflect.set(editor, "attachments", [attachment]);
    editor.onSend = vi.fn(() => Promise.resolve({ ok: false, kind: "auth-required" } satisfies PromptDeliveryResult));
    await editor.updateComplete;

    clickSend(editor);
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector(".delivery-warning")?.textContent).toContain("Sign in again");
    });
    expect(editor.view?.state.doc.toString()).toBe("needs auth");
    expect(Reflect.get(editor, "attachments")).toEqual([attachment]);
    expect(loadDraft(draftKey())).toBe("needs auth");
  });

  it("prevents concurrent sends while delivery is in flight", async () => {
    const editor = await mountEditor();
    editor.replaceText("once only");
    let resolveSend!: (result: PromptDeliveryResult) => void;
    const onSend = vi.fn(() => new Promise<PromptDeliveryResult>((resolve) => { resolveSend = resolve; }));
    editor.onSend = onSend;
    await editor.updateComplete;

    clickSend(editor);
    await Promise.resolve();
    clickSend(editor);
    clickSend(editor);
    expect(onSend).toHaveBeenCalledOnce();

    resolveSend({ ok: true, kind: "accepted" });
    await vi.waitFor(() => {
      expect(editor.view?.state.doc.toString()).toBe("");
    });
  });

  it("blocks send while authenticationRequired and leaves draft editable", async () => {
    const onSend = vi.fn();
    const editor = await mountEditor();
    editor.authenticationRequired = true;
    editor.onSend = onSend;
    editor.replaceText("held locally");
    await editor.updateComplete;

    const send = editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button");
    expect(editor.shadowRoot?.textContent).toContain("Session expired");
    expect(send?.disabled).toBe(true);
    expect(editor.shadowRoot?.querySelector<HTMLElement>(".markdown-editor")?.getAttribute("aria-disabled")).toBe("false");
    send?.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("treats a thrown onSend as ambiguous delivery and retains the draft", async () => {
    const editor = await mountEditor();
    editor.replaceText("thrown transport");
    editor.onSend = vi.fn(() => Promise.reject(new TypeError("Load failed")));
    await editor.updateComplete;

    clickSend(editor);
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector(".delivery-warning")?.textContent).toContain("may already have been sent");
    });
    expect(editor.view?.state.doc.toString()).toBe("thrown transport");
  });

  it("does not clear session B when an in-flight accepted send from session A completes", async () => {
    const editor = await mountEditor("session-a");
    const sharedText = "same draft text";
    const attachmentA = sampleAttachment("att-a");
    const attachmentB = sampleAttachment("att-b");
    editor.replaceText(sharedText);
    Reflect.set(editor, "attachments", [attachmentA]);
    await editor.updateComplete;

    let resolveSend!: (result: PromptDeliveryResult) => void;
    const onSend = vi.fn(() => new Promise<PromptDeliveryResult>((resolve) => { resolveSend = resolve; }));
    editor.onSend = onSend;
    clickSend(editor);
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledOnce();

    // Switch to B with the same visible text and its own attachment while A is in flight.
    editor.sessionId = "session-b";
    await editor.updateComplete;
    editor.replaceText(sharedText);
    Reflect.set(editor, "attachments", [attachmentB]);
    await editor.updateComplete;
    expect(editor.view?.state.doc.toString()).toBe(sharedText);
    expect(Reflect.get(editor, "attachments")).toEqual([attachmentB]);

    resolveSend({ ok: true, kind: "accepted" });
    await vi.waitFor(() => {
      expect(loadDraft(draftKey("session-a"))).toBe("");
    });

    expect(editor.sessionId).toBe("session-b");
    expect(editor.view?.state.doc.toString()).toBe(sharedText);
    expect(loadDraft(draftKey("session-b"))).toBe(sharedText);
    expect(Reflect.get(editor, "attachments")).toEqual([attachmentB]);
    expect(editor.shadowRoot?.querySelector(".delivery-warning")).toBeNull();

    // A's accepted cleanup applies only to A.
    editor.sessionId = "session-a";
    await editor.updateComplete;
    expect(editor.view?.state.doc.toString()).toBe("");
    expect(Reflect.get(editor, "attachments")).toEqual([]);
  });

  it("retains session A failure state without mutating session B after a switch", async () => {
    const editor = await mountEditor("session-a");
    const sharedText = "same draft text";
    const attachmentA = sampleAttachment("att-a");
    const attachmentB = sampleAttachment("att-b");
    editor.replaceText(sharedText);
    Reflect.set(editor, "attachments", [attachmentA]);
    await editor.updateComplete;

    let resolveSend!: (result: PromptDeliveryResult) => void;
    editor.onSend = vi.fn(() => new Promise<PromptDeliveryResult>((resolve) => { resolveSend = resolve; }));
    clickSend(editor);
    await Promise.resolve();

    editor.sessionId = "session-b";
    await editor.updateComplete;
    editor.replaceText(sharedText);
    Reflect.set(editor, "attachments", [attachmentB]);
    await editor.updateComplete;

    resolveSend({ ok: false, kind: "auth-required" });
    await Promise.resolve();
    await Promise.resolve();

    expect(editor.view?.state.doc.toString()).toBe(sharedText);
    expect(Reflect.get(editor, "attachments")).toEqual([attachmentB]);
    expect(editor.shadowRoot?.querySelector(".delivery-warning")).toBeNull();
    expect(loadDraft(draftKey("session-b"))).toBe(sharedText);
    expect(loadDraft(draftKey("session-a"))).toBe(sharedText);

    editor.sessionId = "session-a";
    await editor.updateComplete;
    expect(editor.view?.state.doc.toString()).toBe(sharedText);
    expect(loadDraft(draftKey("session-a"))).toBe(sharedText);
    expect(Reflect.get(editor, "attachments")).toEqual([attachmentA]);
    expect(editor.shadowRoot?.querySelector(".delivery-warning")?.textContent).toContain("Sign in again");
  });
});

async function mountEditor(sessionId = "session-1"): Promise<PromptEditor> {
  const editor = new PromptEditor();
  editor.sessionId = sessionId;
  editor.machineId = "local";
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function clickSend(editor: PromptEditor): void {
  editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
}

function draftKey(sessionId = "session-1"): string {
  return machineSessionKey("local", sessionId);
}

function sampleAttachment(id: string) {
  return {
    id,
    kind: "image" as const,
    mimeType: "image/png",
    data: "QUJD",
    name: `${id}.png`,
    size: 3,
  };
}
