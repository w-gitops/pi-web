import { html, type TemplateResult } from "lit";
import type { ServerNoticeSeverity } from "../../../shared/apiTypes";

export interface ErrorBannerAction {
  label: string;
  onClick: () => void;
}

export type ErrorBannerOption = ErrorBannerAction | ServerNoticeSeverity;

/**
 * The shared application banner. Browser-local failures use the default error
 * severity; server-owned notices reuse the same presentation with their own
 * severity and dismissal callback.
 *
 * Pass `onDismiss` as undefined to render a non-dismissible banner (used when
 * authentication is required so Reauthenticate cannot be removed while writes
 * remain gated). Ordinary errors keep a dismiss control.
 */
export function errorBanner(error: string, onDismiss?: () => void, option: ErrorBannerOption = "error"): TemplateResult | null {
  if (error === "") return null;
  const severity = typeof option === "string" ? option : "error";
  const action = typeof option === "string" ? undefined : option;
  const severityLabel = bannerSeverityLabel(severity);
  const dismissLabel = `Dismiss ${severityLabel.toLowerCase()}`;
  return html`<div class=${`error ${severity} app-error`} role="alert">
    <span class="error-text">${error}</span>
    ${action !== undefined ? html`<button type="button" class="error-action" @click=${() => { action.onClick(); }}>${action.label}</button>` : null}
    ${onDismiss !== undefined ? html`<button type="button" class="error-dismiss" aria-label=${dismissLabel} title=${dismissLabel} @click=${() => { onDismiss(); }}>✕</button>` : null}
  </div>`;
}

function bannerSeverityLabel(severity: ServerNoticeSeverity): "Info" | "Warning" | "Error" {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}
