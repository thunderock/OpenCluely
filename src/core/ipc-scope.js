// SEC-03 — central IPC channel → allowed-window-types allowlist (05-05).
//
// Every ipcMain channel MUST declare its audience here. New channels: add a
// row or the completeness test (test/ipc-scope.test.js) + the runtime gate
// (guardedHandle/guardedOn in main.js) will deny them. Default-deny: unknown
// channel OR unknown/null sender window type => not allowed.
//
// Audiences come from the audited per-renderer usage (05-RESEARCH.md "IPC
// surface" section — the ground truth). Where a channel has no live renderer
// caller today, the audience widens toward the PRIVILEGED window classes
// (main, settings) and NEVER toward the model-output renderers
// (chat, llmResponse), which render untrusted content.
//
// Outbound main → renderer events (webContents.send / broadcastToAllWindows)
// are deliberately NOT gated — main picks its targets. Only inbound ipcMain
// registrations are scoped.
//
// PURE CommonJS, zero requires — node:test-able without Electron.

// Window types (window.manager.js createWindow): main | chat | llmResponse |
// settings | onboarding. chat + llmResponse are the minimal-surface overlay
// class (preload-overlay.js); the rest load the privileged preload.js.
const CHANNEL_AUDIENCES = {
  // ── SEC-03 trio + Phase-5 channels (rows locked by the 05-05 plan) ──
  'get-settings': ['main', 'settings', 'onboarding'], // NEVER chat/llmResponse
  'save-settings': ['main', 'settings', 'onboarding'], // handle + legacy on (settings-window.js api.send)
  'open-external': ['chat', 'llmResponse', 'onboarding'], // http(s)-validated handler; overlay needs it for sanitized links (05-02)
  'copy-to-clipboard': ['main', 'chat', 'llmResponse'], // overlay copy buttons + main
  'open-privacy-settings': ['main'], // SEC-02 enum→x-apple deep link (05-04); URL mapped in MAIN
  'relaunch-app': ['main'], // SEC-02 one-click relaunch (05-04)
  'select-notes-folder': ['settings'], // CONT-05 native folder picker (05-03)

  // ── Screenshot / capture ──
  'take-screenshot': ['main'], // main-window.js camera button + shortcut path
  'list-displays': ['main', 'settings'], // no live renderer caller; privileged-widen
  'capture-area': ['main', 'settings'], // no live renderer caller; privileged-widen

  // ── Speech / audio (mic lives in the main overlay; chat has speech toggles) ──
  'get-speech-availability': ['main', 'chat'], // chat.html speech probe + main-window.js
  'start-speech-recognition': ['main', 'chat'], // handle + on; chat.html toggle + main mic button
  'stop-speech-recognition': ['main', 'chat'], // handle + on
  'speech-reattach-channel': ['main'], // main-window.js devicechange re-attach (AirPods)
  'audio-chunk': ['main'], // on; main-window.js getUserMedia → sendAudioChunk

  // ── Window-ready signals ──
  'chat-window-ready': ['chat'], // on; chat window announces readiness
  'main-window-ready': ['main'], // on; main-window.js notifyMainWindowReady
  'test-chat-window': ['main', 'settings'], // on; debug channel, no live caller; privileged-widen

  // ── Window management / control (privileged; never the overlay class) ──
  'show-all-windows': ['main', 'settings'], // no live renderer caller; privileged-widen
  'hide-all-windows': ['main', 'settings'], // no live renderer caller; privileged-widen
  'enable-window-interaction': ['main', 'settings'], // no live renderer caller; privileged-widen
  'disable-window-interaction': ['main', 'settings'], // no live renderer caller; privileged-widen
  'switch-to-chat': ['main', 'settings'], // no live renderer caller; privileged-widen
  'switch-to-skills': ['main', 'settings'], // no live renderer caller; privileged-widen
  'resize-window': ['main'], // main-window.js width handling
  'move-window': ['main'], // main-window.js drag
  'get-window-stats': ['main'], // main-window.js
  'set-window-binding': ['main', 'settings'], // no live renderer caller; privileged-widen
  'toggle-window-binding': ['main', 'settings'], // no live renderer caller; privileged-widen
  'get-window-binding-status': ['main', 'settings'], // no live renderer caller; privileged-widen
  'set-window-gap': ['main', 'settings'], // settings surface per audit; widened to main
  'move-bound-windows': ['main', 'settings'], // no live renderer caller; privileged-widen
  'force-always-on-top': ['main', 'settings'], // no live renderer caller; privileged-widen
  'test-always-on-top': ['main', 'settings'], // no live renderer caller; privileged-widen

  // ── Session memory ──
  'get-session-history': ['main', 'settings'], // no live renderer caller; privileged-widen
  'clear-session-memory': ['main', 'settings'], // no live renderer caller (shortcut path is main-process); privileged-widen

  // ── Chat / skills ──
  'send-chat-message': ['chat'], // chat.html sendChatMessage
  'get-skill-prompt': ['main', 'settings'], // only dead chat-window.js referenced it; privileged-widen

  // ── Settings / onboarding lifecycle ──
  'show-settings': ['main'], // main-window.js gear button
  'get-first-run-status': ['onboarding'], // onboarding.js
  'complete-first-run': ['onboarding'], // onboarding.js
  'close-onboarding': ['onboarding'], // onboarding.js
  'close-settings': ['settings'], // on; settings-window.js api.send
  'update-skill': ['settings'], // on; settings-window.js api.send
  'update-app-icon': ['settings'], // settings icon grid
  'update-active-skill': ['main', 'settings'], // main-window.js skill switch + settings picker
  'restart-app-for-stealth': ['settings'], // settings stealth-name relaunch

  // ── Whisper (voice engine) ──
  'download-whisper-model': ['settings', 'onboarding'], // settings repair panel + onboarding download
  'get-whisper-status': ['settings', 'onboarding'],
  'whisper-recover': ['settings'], // settings-window.js recoverWhisper

  // ── Local model engine ──
  'download-model': ['settings', 'onboarding'], // pullModel: settings repair + onboarding model-pull
  'get-model-status': ['main', 'settings', 'onboarding'], // main recovery panel (03-06) + settings + onboarding detect
  'list-installed-models': ['settings', 'onboarding'],
  'model-preflight': ['settings', 'onboarding'], // onboarding preflight; settings = model channel (privileged)
  'recover-model': ['main', 'settings'], // main-window.js recovery panel; settings = model channel
  'test-provider-connection': ['settings'], // settings-window.js

  // ── Window lifecycle ──
  'close-window': ['chat', 'llmResponse', 'settings'], // overlay close buttons + settings
  'expand-llm-window': ['llmResponse'], // llm-response preload surface
  'resize-llm-window-for-content': ['llmResponse'], // llm-response.html content sizing
  'quit-app': ['main', 'settings', 'llmResponse'], // handle + on; electronAPI.quit (main/settings) + llm-response api.send
};

/**
 * Default-deny allowlist check: a channel is allowed only when it has a
 * declared audience row AND the sender's window type is a string member of
 * that audience. Unknown channel, unknown/null/non-string window type => deny.
 *
 * @param {string} channel - ipcMain channel name
 * @param {string|null} windowType - sender window type from the WindowManager
 *   WebContents-id registry (null when the sender is unknown/destroyed)
 * @returns {boolean}
 */
function isChannelAllowed(channel, windowType) {
  const audience = CHANNEL_AUDIENCES[channel];
  return Array.isArray(audience) && typeof windowType === 'string' && audience.includes(windowType);
}

module.exports = { CHANNEL_AUDIENCES, isChannelAllowed };
