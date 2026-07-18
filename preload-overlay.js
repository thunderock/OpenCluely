// SEC-03 minimal preload for the MODEL-OUTPUT window classes (llmResponse,
// chat) — these renderers display untrusted model/screen-derived content, so
// their bridge exposes the smallest audited surface (05-RESEARCH "IPC
// surface"). The load-bearing gate is the main-process channel→audience
// allowlist (src/core/ipc-scope.js); this file is defense-in-depth: even a
// fully compromised overlay renderer has no settings/model/whisper bridge to
// call.
//
// DELIBERATELY ABSENT from this bridge (by main.js channel name) and why:
//   - get-settings / save-settings          → settings read/write is privileged
//     (main, settings, onboarding only); the overlay must never read config.
//   - select-notes-folder                   → notes picker is settings-only (CONT-05).
//   - download-whisper-model / get-whisper-status / whisper-recover
//     → voice-engine lifecycle is settings/onboarding surface.
//   - download-model / get-model-status / list-installed-models /
//     model-preflight / recover-model / test-provider-connection
//     → local-model lifecycle is privileged surface.
//   - take-screenshot / list-displays / capture-area
//     → capture triggers stay with the main overlay.
//   - open-privacy-settings / relaunch-app  → SEC-02 recovery is main-window-only.
//   - audio-chunk                           → the mic lives in the main overlay.
//   - window binding/management (move/resize/stats/gap/binding, show/hide-all,
//     interaction toggles, show-settings, first-run/onboarding channels)
//     → control-surface channels are privileged; the overlay keeps only its
//       own expand/resize/close.
//   - legacy api.send                       → reduced to ['quit-app', 'window-loaded'].
//
// KEPT (audited actual usage of llm-response.html + chat.html, 05-02 links
// included): clipboard copy, sanitized-link open (http(s)-validated in main),
// chat send, speech toggles + availability, the overlay's own window
// expand/resize/close, the ready signal, and receive-only events.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Speech recognition (chat window toggles)
  startSpeechRecognition: () => ipcRenderer.invoke('start-speech-recognition'),
  stopSpeechRecognition: () => ipcRenderer.invoke('stop-speech-recognition'),
  getSpeechAvailability: () => ipcRenderer.invoke('get-speech-availability'),

  // Chat
  sendChatMessage: (text) => ipcRenderer.invoke('send-chat-message', text),
  notifyChatWindowReady: () => {
    try {
      ipcRenderer.send('chat-window-ready');
    } catch (error) {
      console.error('Error notifying chat window ready:', error);
    }
  },

  // External links from sanitized model output (05-02): the handler in main
  // validates http(s)-only before shell.openExternal.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // The overlay's own window controls
  closeWindow: () => ipcRenderer.invoke('close-window'),
  expandLlmWindow: (contentMetrics) => ipcRenderer.invoke('expand-llm-window', contentMetrics),
  resizeLlmWindowForContent: (contentMetrics) => ipcRenderer.invoke('resize-llm-window-for-content', contentMetrics),

  // Clipboard helper for reliable copy actions
  copyToClipboard: (text) => {
    try {
      return ipcRenderer.invoke('copy-to-clipboard', String(text ?? ''));
    } catch (e) {
      console.error('copyToClipboard failed:', e);
      return false;
    }
  },

  // Event listeners (receive-only — main picks the targets; not gated)
  onTranscriptionReceived: (callback) => ipcRenderer.on('transcription-received', callback),
  onInterimTranscription: (callback) => ipcRenderer.on('interim-transcription', callback),
  onSpeechStatus: (callback) => ipcRenderer.on('speech-status', callback),
  onSpeechError: (callback) => ipcRenderer.on('speech-error', callback),
  onSpeechAvailability: (callback) => ipcRenderer.on('speech-availability', callback),
  onSessionCleared: (callback) => ipcRenderer.on('session-cleared', callback),
  onLlmResponse: (callback) => ipcRenderer.on('llm-response', callback),
  onTranscriptionLlmResponse: (callback) => ipcRenderer.on('transcription-llm-response', callback),
  onTranscriptionLlmResponseStart: (callback) => ipcRenderer.on('transcription-llm-response-start', callback),
  onTranscriptionLlmResponseChunk: (callback) => ipcRenderer.on('transcription-llm-response-chunk', callback),
  onDisplayLlmResponse: (callback) => ipcRenderer.on('display-llm-response', callback),
  onShowLoading: (callback) => ipcRenderer.on('show-loading', callback),
  onRecordingStarted: (callback) => ipcRenderer.on('recording-started', callback),
  onRecordingStopped: (callback) => ipcRenderer.on('recording-stopped', callback),

  // Generic receive method
  receive: (channel, callback) => ipcRenderer.on(channel, callback),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        let validChannels = [
            'quit-app',
            'window-loaded'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        } else {
            console.warn('Invalid IPC channel:', channel);
        }
    },
    receive: (channel, func) => {
        let validChannels = [
            'load-settings',
            'recording-state-changed',
            'interaction-mode-changed',
            'skill-updated',
            'update-skill',
            'recording-started',
            'recording-stopped'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});
