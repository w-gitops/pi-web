import { html, type TemplateResult } from "lit";

export interface ErrorBannerAction {
  label: string;
  onClick: () => void;
}

/**
 * The shared error banner. It stays until the user dismisses it, another
 * message replaces it, or the owning action clears it, so a background refresh
 * cannot hide a failure the user has not read yet.
 *
 * Pass `onDismiss` as undefined to render a non-dismissible banner (used when
 * authentication is required so Reauthenticate cannot be removed while writes
 * remain gated). Ordinary errors keep a dismiss control.
 */
export function errorBanner(error: string, onDismiss?: () => void, action?: ErrorBannerAction): TemplateResult | null {
  if (error === "") return null;
  return html`<div class="error app-error" role="alert">
    <span class="error-text">${error}</span>
    ${action !== undefined ? html`<button type="button" class="error-action" @click=${() => { action.onClick(); }}>${action.label}</button>` : null}
    ${onDismiss !== undefined ? html`<button type="button" class="error-dismiss" aria-label="Dismiss error" title="Dismiss error" @click=${() => { onDismiss(); }}>✕</button>` : null}
  </div>`;
}
