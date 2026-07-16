const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, globalShortcut, session, ipcMain, powerMonitor } = require("electron");
const { upsertEnvContent } = require("./src/core/env-file");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    return path.join(process.cwd(), ".env");
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). OpenCluely's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes on macOS/Linux (the sox/rec/arecord
// mic recorders via node-record-lpcm16). A missing recorder binary makes that
// library emit an 'error' on its child process with no listener, which would
// otherwise become an uncaughtException and quit the entire app the moment the
// user clicks the mic. We log and stay alive — the speech service surfaces a
// friendly status to the UI instead. (STT itself is now the resident
// whisper-server — no per-utterance process spawn.)
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

// Sleep/wake re-warm settle delay (openwhispr #766): give the audio/GPU drivers
// a beat to come back after resume before we re-probe/restart the engine + tap.
const REWARM_SETTLE_MS = 1500;

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "general";
  // Default to C++ so language is enforced from first run
  this.codingLanguage = "cpp";
    this.speechAvailable = false;

    // Ambient listening (STT-03/SC3): the audio stream stays open launch→quit.
    // `_ambientDesired` is the user's LAST on/off intent — the interim mic
    // control (mic button + Alt+R) flips it, and `_ensureAmbientListening()`
    // honors it so a deferred first-run start, a speech-'status' event, or a
    // sleep/wake re-warm never force-starts listening the user had paused.
    this._ambientDesired = true;
    // Sleep/wake re-warm re-entrancy guard (openwhispr #766). A burst of resume
    // events must never re-enter and double-restart the whisper-server / tap.
    this._rewarmInFlight = false;
    this._powerMonitorWired = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects a missing .env / uncompleted setup and
    // triggers the onboarding wizard on first launch so users are guided
    // through local model + speech setup.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".opencluely-firstrun-completed"),
    });
    // Resident STT engine (STT-01) + ggml model downloader (STT-02) — lazily
    // initialised in getWhisperServerManager()/getWhisperModelDownloader() so
    // importing or running tests never spawns a whisper-server.
    this._whisperServerManager = null;
    this._whisperModelDownloader = null;
    // Local engine lifecycle (PROV-05) — lazily-initialised in
    // getLocalModelManager() so it never runs during import/tests.
    this._localModelManager = null;
    // macOS system-audio tap (STT-04) — lazily-initialised in
    // getSystemAudioTapManager() so importing/tests never spawn the helper.
    this._systemAudioTapManager = null;
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "OpenCluely" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      // Resilience (STT-03/SC3 "survive a full session"): arm the sleep/wake
      // re-warm as soon as the app is ready — it lazily resolves the managers
      // in onWakeFromSleep, so it must NOT wait on the (potentially slow) model
      // warmup + whisper/tap starts below. openwhispr #766: sleep evicts the
      // GPU/stream state.
      this._setupPowerMonitor();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");

      // Local engine (PROV-05): adopt a running Ollama or start one so the app
      // is answer-ready. NEVER blocks startup — start() degrades gracefully and
      // any failure here is logged so the app continues (the Local-down UX
      // surfaces recovery). On first run we only start/adopt the daemon; the
      // onboarding flow (03-06) drives the visible model pull, not this path.
      try {
        const modelStatus = await this.getLocalModelManager().start();
        logger.info("Local model manager started", modelStatus);
      } catch (e) {
        logger.warn("Local model manager start failed (continuing)", {
          error: e.message,
        });
      }

      // Resident STT engine (STT-01/SC1): pre-warm the whisper-server so each
      // VAD segment transcribes with NO per-utterance spawn/cold-start. Mirrors
      // the LocalModelManager start above — NON-BLOCKING (the overlay is already
      // shown) + NON-FATAL (a failure is logged, the app continues; the inline
      // "voice unavailable" UX surfaces recovery; typing + screenshot keep
      // working). Unlike the Ollama daemon, whisper-server cannot start without
      // its model file, so we only pre-warm once the ggml model is on disk — the
      // first-run download is driven by onboarding/settings (04-07), not here.
      try {
        const whisperMgr = this.getWhisperServerManager();
        if (typeof whisperMgr.modelPresent === "function" && !whisperMgr.modelPresent()) {
          logger.info(
            "Voice model not downloaded yet; skipping whisper-server pre-warm (onboarding/settings drives the download)",
          );
        } else {
          const whisperStatus = await whisperMgr.start();
          logger.info("Whisper server manager started", whisperStatus);
        }
      } catch (e) {
        logger.warn("Whisper server manager start failed (continuing)", {
          error: e.message,
        });
      }
      // Inject the (possibly-not-yet-ready) resident manager into the speech
      // service so the flush seam transcribes against it. setWhisperServerManager
      // re-evaluates availability + emits a status the existing speech-status /
      // speech-availability broadcast carries to the overlay.
      try {
        if (typeof speechService.setWhisperServerManager === "function") {
          speechService.setWhisperServerManager(this.getWhisperServerManager());
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
        }
      } catch (e) {
        logger.warn("Failed to inject whisper manager into speech service", {
          error: e.message,
        });
      }

      // macOS system-audio tap (STT-04/SC4): capture the OTHER party's audio as a
      // separate source:'system' channel. Sits behind isSupported() (darwin &&
      // >=14.4) -> consent -> degrade-to-mic, so any failure just leaves the
      // system channel OFF and mic-only ambient listening (the guaranteed
      // baseline) keeps working. NON-BLOCKING + NON-FATAL, like the whisper/local
      // starts above. The tap's 16 kHz PCM feeds speechService.handleSystemAudioChunk;
      // setSystemChannelEnabled gates the second pipeline. NOTE (04-RESEARCH Flag 3):
      // the NSAudioCaptureUsageDescription TCC prompt does not fire on unsigned
      // builds — the 04-05 signing spike + Phase 8 signing gate whether this is
      // actually live in the shipped app.
      try {
        const tap = this.getSystemAudioTapManager();
        if (!tap.isSupported()) {
          logger.info(
            "System audio tap not supported on this OS (needs macOS 14.4+) — microphone only",
          );
        } else if (typeof speechService.handleSystemAudioChunk !== "function") {
          logger.info("Speech service has no system-audio channel — microphone only");
        } else {
          const tapStatus = await tap.start({
            onPcm: (buf) => speechService.handleSystemAudioChunk(buf),
          });
          const live = !!(tapStatus && tapStatus.running && tapStatus.granted);
          if (typeof speechService.setSystemChannelEnabled === "function") {
            speechService.setSystemChannelEnabled(live);
          }
          if (live) {
            logger.info(
              "System audio tap live — capturing the other party's audio",
              tapStatus,
            );
          } else {
            logger.info(
              "System audio unavailable — using microphone only (degrade-to-mic)",
              tapStatus,
            );
          }
        }
      } catch (e) {
        logger.warn("System audio tap start failed (continuing mic-only)", {
          error: e.message,
        });
      }

      // Ambient listening (STT-03/SC3): auto-start from launch so the stream
      // stays open launch→quit — NON-BLOCKING + guarded. If the engine isn't
      // ready yet (first-run: the ggml model is still downloading, so
      // isAvailable() is false), this simply DEFERS — the speech-'status'
      // handler re-invokes it the moment the engine reports ready. Launch is
      // never blocked on it, and it is skipped while the onboarding wizard is
      // up (complete-first-run re-invokes it) so we never grab the mic
      // mid-setup.
      this._ensureAmbientListening("launch");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Delegate any provider-owned network hardening to the selected provider.
    // LocalProvider needs none, so it does not implement configureNetworkSession
    // and this guarded delegate simply no-ops — no global cert/UA overrides run.
    const ses = session.defaultSession;
    const provider = require("./src/services/providers").getSelected();
    if (provider && typeof provider.configureNetworkSession === "function") {
      provider.configureNetworkSession(ses);
    }

    logger.debug('Network configuration applied for selected provider');
  }

  setupPermissions() {
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = ["microphone", "camera", "display-capture"];
        const granted = allowedPermissions.includes(permission);

        logger.debug("Permission request", { permission, granted });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    speechService.on("recording-stopped", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
    });

    speechService.on("transcription", (payload) => {
      // The flush now emits { text, source:'mic'|'system' } (04-04). Stay
      // tolerant of a bare string (any legacy emit) → treat as mic.
      if (typeof payload === "string") {
        this.handleTranscriptionFragment({ text: payload, source: "mic" });
      } else {
        this.handleTranscriptionFragment(payload || {});
      }
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
      // Deferred ambient auto-listen (STT-03/SC3): when the engine first
      // reports ready (e.g. a first-run ggml download just finished + the
      // whisper-server came up), begin ambient listening WITHOUT a manual
      // trigger. Idempotent + honors the interim pause, so this never
      // double-starts and never overrides a user who paused.
      this._ensureAmbientListening("status");
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      // Interim ON via the mic button: this IS the ambient on/off control this
      // phase, so record the desired-listening intent for auto-resume.
      this._ambientDesired = true;
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      // Interim OFF via the mic button: pause ambient listening (halts mic
      // capture; the system-tap ingest is gated off by isRecording).
      this._ambientDesired = false;
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Mic-device-change re-attach (AirPods in/out): the renderer signals here
    // just before it re-acquires getUserMedia so we drop the truncated partial
    // from the now-dead device + reset that channel's VAD (no stranded
    // half-word, no double-flush). Degrade-never-crash.
    ipcMain.handle("speech-reattach-channel", (_event, source) => {
      try {
        if (typeof speechService.resetChannelForReattach === "function") {
          speechService.resetChannelForReattach(source === "system" ? "system" : "mic");
        }
        return { ok: true };
      } catch (e) {
        logger.warn("speech-reattach-channel failed", { error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      this._ambientDesired = true;
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      this._ambientDesired = false;
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        // Onboarding is done + the main overlay is shown: now that we won't
        // interrupt setup, begin ambient listening if the engine is ready
        // (STT-03/SC3). Defers silently if the model still isn't downloaded.
        this._ensureAmbientListening("onboarding-complete");
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Download the ggml voice model via the 04-02 downloader (resumable HTTP
    // Range + SHA256 verify; atomic-rename-after-verify; no Python install
    // step). Streams STRUCTURED { percent, downloadedBytes, totalBytes } on the same
    // `install-progress` channel the onboarding/settings UI already listens on.
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const sender = event.sender;
        const downloader = this.getWhisperModelDownloader();
        const model = modelName || config.get("speech.whisper.model") || "small.en";
        const result = await downloader.download(model, {
          onProgress: (p) => {
            try { sender.send("install-progress", p); } catch (_) { /* ignore */ }
          },
        });
        // If a fresh model just landed, (re)start the server + refresh the speech
        // service so the mic path becomes available without a relaunch.
        if (result && result.ok) {
          try {
            const mgr = this.getWhisperServerManager();
            await mgr.start();
            if (typeof speechService.setWhisperServerManager === "function") {
              speechService.setWhisperServerManager(mgr);
            }
          } catch (_) { /* best effort — inline status surfaces any failure */ }
        }
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, reason: "error", message: e.message };
      }
    });

    // Resident STT engine health (mirrors get-model-status). Three-level health:
    // binary present / model present / server up (+ optional async responding).
    ipcMain.handle("get-whisper-status", async (_event, opts) => {
      try {
        return await this.getWhisperServerManager().getStatus(opts);
      } catch (e) {
        return { serverUp: false, error: e.message };
      }
    });

    // Voice-engine recovery (mirrors recover-model). 'download' → (re)fetch the
    // ggml model with progress then restart; anything else → (re)start the owned
    // server. Either way the speech service is refreshed so the mic recovers.
    ipcMain.handle("whisper-recover", async (event, action) => {
      try {
        const mgr = this.getWhisperServerManager();
        if (action === "download") {
          const sender = event.sender;
          const downloader = this.getWhisperModelDownloader();
          const result = await downloader.download(
            config.get("speech.whisper.model") || "small.en",
            {
              onProgress: (p) => {
                try { sender.send("install-progress", p); } catch (_) { /* ignore */ }
              },
            },
          );
          try {
            await mgr.start();
            if (typeof speechService.setWhisperServerManager === "function") {
              speechService.setWhisperServerManager(mgr);
            }
          } catch (_) { /* best effort */ }
          return result;
        }
        const status = await mgr.start();
        if (typeof speechService.setWhisperServerManager === "function") {
          speechService.setWhisperServerManager(mgr);
        }
        return status;
      } catch (e) {
        logger.error("Whisper recovery failed", { action, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // ── Local model engine (PROV-05) ──
    // Provider-neutral / local-named handlers (they outlived the cloud path
    // removed at PROV-07). Mirrors the whisper download-progress pattern but
    // emits STRUCTURED { status, percent } events.
    ipcMain.handle("download-model", async (event, modelTag) => {
      try {
        const sender = event.sender;
        return await this.getLocalModelManager().pullModel(
          modelTag || config.get("llm.local.model"),
          {
            onProgress: (p) => {
              try { sender.send("model-pull-progress", p); } catch (_) { /* ignore */ }
            },
          },
        );
      } catch (e) {
        logger.error("Model pull failed", { error: e.message });
        return { ok: false, message: e.message };
      }
    });

    ipcMain.handle("get-model-status", async (_event, opts) => {
      try {
        // opts.probeResponds:false → fast detection path (no model generate); the
        // onboarding serverUp gate uses it so it never blocks on "Probing".
        return await this.getLocalModelManager().getStatus(opts);
      } catch (e) {
        return { serverUp: false, error: e.message };
      }
    });

    ipcMain.handle("list-installed-models", async () => {
      try {
        return await this.getLocalModelManager().listInstalledModels();
      } catch (_) {
        return [];
      }
    });

    ipcMain.handle("model-preflight", async () => {
      try {
        return await this.getLocalModelManager().preflight();
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // Local-down recovery (03-06 UX). action: 'restart' → start() only when WE
    // own the daemon (an adopted daemon isn't ours to restart — surface status
    // so the UI guides the user); 'repull' → re-pull the model with progress;
    // anything else → just report status.
    ipcMain.handle("recover-model", async (event, action) => {
      try {
        const manager = this.getLocalModelManager();
        if (action === "restart") {
          const status = await manager.getStatus();
          return status.owned ? await manager.start() : status;
        }
        if (action === "repull") {
          const sender = event.sender;
          return await manager.pullModel(config.get("llm.local.model"), {
            onProgress: (p) => {
              try { sender.send("model-pull-progress", p); } catch (_) { /* ignore */ }
            },
          });
        }
        return await manager.getStatus();
      } catch (e) {
        logger.error("Model recovery failed", { action, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Provider-neutral connection test (survives PROV-07; llmService is the
    // registry-selected provider — Local, the sole engine after removal).
    ipcMain.handle("test-provider-connection", async () => {
      try {
        return await llmService.testConnection();
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      windowManager.windows.forEach((win, _type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  /**
   * The single entry point for ambient auto-listen (STT-03/SC3). Starts
   * listening ONLY when it is the desired state AND the resident engine is
   * ready — idempotent + NON-BLOCKING. Called at launch, when the engine first
   * reports ready (deferred first-run case, via the speech-'status' handler),
   * after onboarding completes, and on wake-from-sleep. It NEVER force-starts a
   * session the user paused (honors `_ambientDesired`) and NEVER blocks: if the
   * engine isn't ready it returns immediately and a later 'status' re-invokes.
   */
  _ensureAmbientListening(reason = "auto") {
    try {
      if (!this._ambientDesired) {
        return; // user paused via the interim mic control — do not resume
      }
      if (this.isFirstRun) {
        return; // onboarding wizard is up — don't grab the mic mid-setup
      }
      const available = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      if (!available) {
        return; // engine not ready yet — defer (a 'status' event re-invokes us)
      }
      const status = speechService.getStatus ? speechService.getStatus() : {};
      if (status.isRecording) {
        return; // already ambient-listening — idempotent
      }
      speechService.startRecording(); // ambient listening on (auto, from onAppReady/status)
      logger.info("Ambient listening started", { reason });
    } catch (e) {
      logger.warn("Ambient listening auto-start failed (will retry on next status)", {
        error: e.message,
      });
    }
  }

  /**
   * Register the sleep/wake re-warm (openwhispr #766: sleep evicts the local
   * GPU/stream state — the whisper-server can die and the mic/tap streams go
   * stale on resume). powerMonitor is only available after app-ready, so this
   * is called from onAppReady. Guarded so a double-register can't happen, and
   * wrapped so a missing powerMonitor (non-Electron test import) never crashes.
   */
  _setupPowerMonitor() {
    if (this._powerMonitorWired) {
      return;
    }
    try {
      if (!powerMonitor || typeof powerMonitor.on !== "function") {
        return;
      }
      powerMonitor.on("resume", () => {
        this.onWakeFromSleep().catch((e) =>
          logger.warn("onWakeFromSleep threw (ignored)", { error: e && e.message }),
        );
      });
      this._powerMonitorWired = true;
      logger.debug("powerMonitor resume handler registered");
    } catch (e) {
      logger.warn("Failed to register powerMonitor resume handler", { error: e.message });
    }
  }

  /**
   * Re-warm after the machine wakes (openwhispr #766). Delegates to the pure
   * src/core/wake-rewarm orchestrator so the guarded sequence (settle → whisper
   * re-probe/restart → tap reopen → replay ambient) is unit-testable +
   * degrade-never-crash. Re-entrancy is guarded via `_rewarmInFlight`; an
   * in-flight transcription is NOT interrupted (the server is only restarted
   * when actually down).
   */
  async onWakeFromSleep() {
    const { rewarmAfterWake } = require("./src/core/wake-rewarm");
    const result = await rewarmAfterWake({
      isInFlight: () => this._rewarmInFlight,
      setInFlight: (v) => { this._rewarmInFlight = v; },
      getWhisperManager: () => this.getWhisperServerManager(),
      getTapManager: () => this.getSystemAudioTapManager(),
      speechService,
      onSystemPcm: (buf) => speechService.handleSystemAudioChunk(buf),
      setSystemChannelEnabled: (live) => {
        if (typeof speechService.setSystemChannelEnabled === "function") {
          speechService.setSystemChannelEnabled(live);
        }
        if (live && typeof speechService.resetChannelForReattach === "function") {
          speechService.resetChannelForReattach("system");
        }
      },
      reacquireAmbientMic: () => this._reacquireAmbientMic(),
      settleMs: REWARM_SETTLE_MS,
      logger,
    });
    logger.info("Wake-from-sleep re-warm complete", result);
    return result;
  }

  /**
   * Replay the LAST known ambient state after a wake. If ambient was actively
   * listening, re-acquire the renderer getUserMedia stream (sleep can evict it)
   * by resetting the mic VAD channel + replaying `recording-started` (which the
   * renderer handles by tearing down + re-acquiring capture). If ambient is
   * desired-but-idle (engine just recovered), start it. NEVER resumes a paused
   * session (honors `_ambientDesired`).
   */
  _reacquireAmbientMic() {
    if (!this._ambientDesired) {
      return "paused";
    }
    const status = speechService.getStatus ? speechService.getStatus() : {};
    if (status.isRecording) {
      if (typeof speechService.resetChannelForReattach === "function") {
        speechService.resetChannelForReattach("mic");
      }
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) {
          try { w.webContents.send("recording-started"); } catch (_) { /* ignore */ }
        }
      });
      return "reacquired";
    }
    this._ensureAmbientListening("wake");
    return "ensured";
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        // Interim OFF: record the paused intent FIRST so a concurrent
        // 'status'/wake re-warm can't auto-resume what the user just paused.
        this._ambientDesired = false;
        speechService.stopRecording();
        windowManager.hideChatWindow();
        logger.info("Ambient listening paused via mic control (Alt+R)");
      } catch (error) {
        logger.error("Error pausing ambient listening:", error);
      }
    } else {
      try {
        // Interim ON: resume ambient listening.
        this._ambientDesired = true;
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Ambient listening resumed via mic control (Alt+R)");
      } catch (error) {
        logger.error("Error resuming ambient listening:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "general",
      "programming",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['programming'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['programming'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment({ text, source } = {}) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }
    // Channel tag threaded from the flush ('mic'|'system'); default 'mic' for a
    // bare/legacy emit. Phase 4 only PRESERVES the tag end-to-end (no mic/system
    // fusion or dedup — deferred to Phase 6).
    const channel = source === "system" ? "system" : "mic";

    // Show the live transcript right away in all windows. addUserInput's 2nd arg
    // stays the input-KIND ('speech'); the audio channel rides as SEPARATE
    // metadata so the input-kind param is never overloaded.
    sessionManager.addUserInput(fragment, 'speech', { channel });
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("transcription-received", { text: fragment, source: channel });
    });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
    }
    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['programming'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer so it renders progressively in the chat + overlay.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      // Surface the overlay immediately so streamed tokens are visible there
      // too, instead of the overlay only appearing once the full answer lands.
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      // Send response to chat windows
      this.broadcastTranscriptionLLMResponse(llmResult);

      // Also display in the overlay (LLM response) window so the answer
      // appears in both the chat panel and the floating overlay, mirroring
      // the behaviour of screenshot/image responses.
      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the chat/overlay replace the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        // Mirror to overlay window for consistency
        windowManager.showLLMResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true
        });
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, _type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    // Stop the local engine only if WE own it — supervisor.stop() no-ops for an
    // adopted daemon (we never kill an Ollama we didn't start). Fire-and-forget:
    // quit must not wait on a graceful SIGTERM race.
    try {
      const stopping = this.getLocalModelManager().stop();
      if (stopping && typeof stopping.catch === "function") stopping.catch(() => {});
    } catch (_) { /* best effort */ }

    // Stop the resident whisper-server we own (own-only; never lingers after
    // quit). Fire-and-forget — quit must not wait on the SIGTERM->SIGKILL grace.
    try {
      const stoppingWhisper = this.getWhisperServerManager().stop();
      if (stoppingWhisper && typeof stoppingWhisper.catch === "function") stoppingWhisper.catch(() => {});
    } catch (_) { /* best effort */ }

    // SIGTERM the system-audio tap helper we spawned (own-only; never lingers
    // after quit). Fire-and-forget — quit must not wait on it.
    try {
      const stoppingTap = this.getSystemAudioTapManager().stop();
      if (stoppingTap && typeof stoppingTap.catch === "function") stoppingTap.catch(() => {});
    } catch (_) { /* best effort */ }

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  // Resident STT engine (STT-01): supervises the from-source whisper-server,
  // reports three-level health, transcribes over POST /inference. Lazily
  // constructed so import-time and tests never spawn a server.
  getWhisperServerManager() {
    if (!this._whisperServerManager) {
      const WhisperServerManager = require("./src/core/whisper-server.manager");
      this._whisperServerManager = new WhisperServerManager();
    }
    return this._whisperServerManager;
  }

  // ggml voice-model downloader (STT-02): resumable, SHA256-verified download of
  // ggml-<model>.bin into <userData>/.whisper-models. Lazily constructed.
  getWhisperModelDownloader() {
    if (!this._whisperModelDownloader) {
      const WhisperModelDownloader = require("./src/core/whisper-model-downloader");
      this._whisperModelDownloader = new WhisperModelDownloader();
    }
    return this._whisperModelDownloader;
  }

  // Local engine (PROV-05): adopts/owns the Ollama daemon, ensures the
  // configured model, keeps it resident, and reports owned/adopted + health.
  // Lazily constructed so import-time and tests never touch Ollama.
  getLocalModelManager() {
    if (!this._localModelManager) {
      const LocalModelManager = require("./src/core/local-model.manager");
      this._localModelManager = new LocalModelManager();
    }
    return this._localModelManager;
  }

  // macOS system-audio tap (STT-04): spawns the Core Audio Process Tap helper,
  // parses its stderr status, persists grant/deny, and pipes 16 kHz PCM into the
  // speech service's system channel. Everything sits behind isSupported() (darwin
  // && >=14.4) + consent + a uniform degrade-to-mic path. Lazily constructed so
  // import-time and tests never spawn the helper.
  getSystemAudioTapManager() {
    if (!this._systemAudioTapManager) {
      const SystemAudioTapManager = require("./src/core/system-audio-tap.manager");
      this._systemAudioTapManager = new SystemAudioTapManager();
    }
    return this._systemAudioTapManager;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "general",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,

      // STT is the single resident whisper engine now (no provider selection).
      speechProvider: "whisper",
      whisperModel: process.env.WHISPER_MODEL || "small.en",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "en",
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",

      // AI model engine (PROV-06). Read from config so the UI reflects the live
      // provider/model resolution (config derives these from LLM_PROVIDER /
      // LOCAL_MODEL in .env).
      provider: config.get("llm.provider"),
      model: config.get("llm.local.model"),
      curatedModels: config.get("llm.local.curatedModels"),

      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots.
      const envUpdates = {};
      // STT is the single resident whisper engine (no provider selection). Only
      // the whisper-server knobs persist to .env; config.speech.whisper reads them.
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }

      // AI model engine (PROV-06). Persist to .env so the selection survives a
      // restart and is applied on next launch: the provider facade resolves the
      // selected provider at module load, so this is restart-to-apply (no live
      // hot-swap), matching the app's other .env-backed settings.
      if (settings.provider === "local") {
        envUpdates.LLM_PROVIDER = settings.provider;
      }
      if (settings.model !== undefined) {
        envUpdates.LOCAL_MODEL = settings.model;
      }

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      if (settings.provider !== undefined || settings.model !== undefined) {
        // Meta only — no live provider hot-swap; the switch applies on next launch.
        logger.info("LLM provider/model updated", {
          provider: settings.provider,
          model: settings.model,
        });
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const content = upsertEnvContent(existing, updates);

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, content, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys });
    return keys;
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon
        app.dock.setIcon(fullIconPath);

        // Force dock refresh with multiple attempts
        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 100);

        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 500);
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, _type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Force update the bundle name for macOS stealth
        try {
          // Update the app's Info.plist CFBundleName in memory
          if (process.mainModule && process.mainModule.filename) {
            // Force set the bundle name directly
            process.env.CFBundleName = appName.trim();
          }
        } catch (e) {
          // Silently fail if we can't modify bundle info
        }

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping
      app.setAppUserModelId(`${appName.trim()}-${iconKey}`);

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, _type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
