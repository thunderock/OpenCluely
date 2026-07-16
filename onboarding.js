/**
 * Onboarding wizard controller.
 *
 * Drives the onboarding flow rendered in onboarding.html and persists
 * everything via the electronAPI bridge exposed by preload.js:
 *
 *   1. Welcome
 *   2. Speech provider choice (Whisper / Azure / Skip)
 *   3. Voice engine check (resident whisper.cpp) — only shown when whisper
 *   4. Voice model (ggml-small.en) download — only shown when whisper
 *   5. Local model engine (Ollama) guide-install + re-check (openwhispr-style)
 *   6. Local model pull (qwen3-vl:8b) with resumable progress + preflight warn
 *   7. Star-the-repo prompt + summary
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = $$('.screen');
  const stepperDots = $$('.step-dot');
  const stepBadge = $('#stepBadge');
  const backBtn = $('#backBtn');
  const nextBtn = $('#nextBtn');
  const skipBtn = $('#skipBtn');

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    step: 0,
    speechProvider: null, // 'whisper' | 'azure' | 'skip'
    azureKey: '',
    azureRegion: '',
    whisperDetected: false,
    skippingWhisper: false,
    modelDownloadChoice: null, // 'now' | 'later'
    modelDownloading: false,
    modelDownloaded: false,
    ollamaDetected: false, // local model engine (Ollama) server reachable
    modelPulling: false, // qwen3-vl:8b pull in flight
    modelPulled: false,
    finished: false,
  };

  // Screens are: welcome → speech → whisper? → ollama → model-pull → finish
  // The whisper screen is only visited if state.speechProvider === 'whisper'.
  // Local is the default (and only) engine, so the app works with no cloud key.
  const stepScreens = ['welcome', 'speech'];

  // ── Step rendering ────────────────────────────────────────────────
  function totalSteps() {
    return stepScreens.length + (state.speechProvider === 'whisper' ? 1 : 0) + 1;
  }

  function refreshStepper() {
    const total = totalSteps();
    const current = state.step + 1;
    stepBadge.textContent = `Step ${current} of ${total}`;
    stepperDots.forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < state.step) dot.classList.add('done');
      else if (i === state.step) dot.classList.add('active');
    });
  }

  function showScreen(name) {
    screens.forEach((s) => {
      s.classList.toggle('active', s.dataset.screen === name);
    });
    // Welcome screen uses an inline hero CTA — hide the regular nav row.
    const wizardEl = document.getElementById('wizard');
    if (wizardEl) {
      wizardEl.classList.toggle('welcome-active', name === 'welcome');
    }
    refreshStepper();
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    // Reset next button state unless we're actively downloading/pulling a model
    const busy = (name === 'model-download' && state.modelDownloading)
      || (name === 'model-pull' && state.modelPulling);
    if (!busy) {
      nextBtn.disabled = false;
      nextBtn.classList.remove('success');
      nextBtn.classList.add('primary');
    }
    // The primary action label changes by step
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else if (name === 'whisper') nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    else nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
  }

  function _navigate(direction) {
    const order = computeScreenOrder();
    const idx = order.indexOf(currentScreenName());
    const next = direction === 'next' ? idx + 1 : idx - 1;
    if (next < 0 || next >= order.length) return;
    state.step = orderScreenToStep(order[next]);
    showScreen(order[next]);
  }

  function currentScreenName() {
    const active = Array.from(screens).find((s) => s.classList.contains('active'));
    return active ? active.dataset.screen : 'welcome';
  }

  // Order depends on choices — e.g. whisper path inserts the install screen.
  // The local-model screens (ollama guide-install + qwen3-vl:8b pull) always
  // run: Local is the default engine, so this is core setup, not optional.
  function computeScreenOrder() {
    const out = ['welcome', 'speech'];
    if (state.speechProvider === 'whisper') out.push('whisper');
    if (state.speechProvider === 'whisper') out.push('model-download');
    out.push('ollama');
    out.push('model-pull');
    out.push('finish');
    return out;
  }

  // Map a screen name to its position in the stepper (0..n).
  function orderScreenToStep(name) {
    return computeScreenOrder().indexOf(name);
  }

  // ── Validation gates before "Continue" ───────────────────────────
  function canAdvance() {
    const name = currentScreenName();
    switch (name) {
      case 'welcome':
        return true;
      case 'speech':
        if (state.speechProvider === 'azure') {
          return !!state.azureKey.trim() && !!state.azureRegion.trim();
        }
        return !!state.speechProvider;
      case 'whisper':
        // Allow advancing whether whisper is detected OR user skipped
        return state.whisperDetected || state.skippingWhisper;
      case 'model-download':
        return !!state.modelDownloadChoice && !state.modelDownloading;
      case 'ollama':
        // openwhispr-style: must have a running engine before we can pull.
        return state.ollamaDetected;
      case 'model-pull':
        // Friendly failure: once the pull settles (ok or not) let them proceed;
        // a failed/partial pull resumes on retry or first use.
        return !state.modelPulling;
      case 'finish':
        return true;
      default:
        return true;
    }
  }

  // ── Wire up: Speech choices ───────────────────────────────────────
  $$('#speechChoices .choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      const value = card.dataset.value;
      state.speechProvider = value;
      $$('#speechChoices .choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const azurePanel = $('#azurePanel');
      azurePanel.style.display = value === 'azure' ? 'block' : 'none';
      if (value !== 'azure') {
        state.azureKey = '';
        state.azureRegion = '';
      }
    });
  });

  $('#azureKey').addEventListener('input', (e) => { state.azureKey = e.target.value.trim(); });
  $('#azureRegion').addEventListener('input', (e) => { state.azureRegion = e.target.value.trim(); });

  // ── Wire up: Whisper screen ───────────────────────────────────────
  const installLog = $('#installLog');
  const detectCmd = $('#detectCmd');
  const detectStatus = $('#detectStatus');
  const installList = $('#installList');
  const installCardTitle = $('#installCardTitle');

  function appendLog(line) {
    installLog.textContent += (installLog.textContent ? '\n' : '') + line;
    installLog.scrollTop = installLog.scrollHeight;
  }

  function setDetectStatus(state_, text) {
    detectStatus.className = `status-pill ${state_}`;
    const icon = detectStatus.querySelector('i');
    if (state_ === 'success') icon.className = 'fas fa-check-circle';
    else if (state_ === 'error') icon.className = 'fas fa-circle-xmark';
    else if (state_ === 'idle') icon.className = 'fas fa-circle-info';
    else icon.className = 'fas fa-circle-notch fa-spin';
    detectStatus.querySelector('.text').textContent = text;
  }

  async function runWhisperEngineCheck() {
    detectCmd.textContent = 'checking…';
    setDetectStatus('testing', 'Checking');
    try {
      // The whisper.cpp engine is built into the app — there is NO user install
      // step (the deleted Python detect/install path is gone). We only surface
      // whether the binary is present; the voice model download is the next
      // screen. getWhisperStatus() → { binaryPresent, modelPresent, serverUp }.
      const s = (await window.electronAPI.getWhisperStatus()) || {};
      state.whisperDetected = !!s.binaryPresent;
      if (s.binaryPresent) {
        detectCmd.textContent = 'whisper.cpp (built-in)';
        setDetectStatus('success', 'Voice engine ready');
        appendLog('✓ Resident whisper.cpp voice engine is built into OpenCluely.');
        appendLog(s.modelPresent
          ? '✓ Voice model already downloaded.'
          : '· Voice model will be downloaded on the next step.');
      } else {
        detectCmd.textContent = 'not found';
        setDetectStatus('error', 'Engine missing');
        appendLog('✗ Voice engine binary is missing — reinstall or rebuild the app to restore it. You can skip voice for now.');
      }
    } catch (e) {
      // Bridge/status unavailable — degrade to a friendly line, never crash.
      state.whisperDetected = false;
      detectCmd.textContent = 'unavailable';
      setDetectStatus('error', 'Status unavailable');
      appendLog(`! Could not check the voice engine: ${e.message || e}`);
    }
  }

  // Whisper screen logic
  let whisperInitialized = false;
  function enterWhisperScreen() {
    if (whisperInitialized) return;
    whisperInitialized = true;
    // Resident-engine copy: no venv, no pip, no per-platform Python guidance.
    // The whisper.cpp engine ships with the app; the only first-run step is the
    // one-time voice-model download on the next screen.
    installCardTitle.textContent = 'How local voice input works';
    const steps = [
      'The whisper.cpp voice engine is built into OpenCluely — nothing to install.',
      'The only first-run step is downloading the <code>ggml-small.en</code> English voice model (~488 MB).',
      'The model is cached in your app data folder, resumes if interrupted, and works offline afterward.',
    ];
    installList.innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
    runWhisperEngineCheck();
  }

  // ── Wire up: Model Download screen ───────────────────────────────
  const modelDownloadLog = $('#modelDownloadLog');
  const modelDownloadBar = $('#modelDownloadBar');
  const modelDownloadStatus = $('#modelDownloadStatus');

  function appendModelLog(line) {
    modelDownloadLog.textContent += (modelDownloadLog.textContent ? '\n' : '') + line;
    modelDownloadLog.scrollTop = modelDownloadLog.scrollHeight;
  }

  let modelDownloadInitialized = false;
  function enterModelDownloadScreen() {
    if (!modelDownloadInitialized) {
      modelDownloadInitialized = true;

      // Set up choice card click handlers once
      $$('#modelDownloadChoices .choice-card').forEach((card) => {
        card.addEventListener('click', () => {
          const value = card.dataset.value;
          state.modelDownloadChoice = value;
          $$('#modelDownloadChoices .choice-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          
          if (value === 'now') {
            // Start downloading the model immediately
            startModelDownload();
          } else {
            nextBtn.disabled = false;
          }
        });
      });
    }

    // Restore selection state when navigating back
    $$('#modelDownloadChoices .choice-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.value === state.modelDownloadChoice);
    });

    // Re-enable continue button if a choice has been made and not actively downloading
    if (state.modelDownloadChoice && !state.modelDownloading) {
      nextBtn.disabled = false;
    }
  }

  // Human-readable megabytes for the structured download progress.
  function _mb(n) {
    return (typeof n === 'number' && isFinite(n)) ? `${(n / (1024 * 1024)).toFixed(0)} MB` : '';
  }

  async function startModelDownload() {
    state.modelDownloading = true;
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';

    if (modelDownloadBar) modelDownloadBar.style.width = '0%';
    if (modelDownloadStatus) modelDownloadStatus.textContent = 'Starting download…';
    appendModelLog('Downloading ggml-small.en voice model…');

    // The ggml downloader streams STRUCTURED { percent, downloadedBytes,
    // totalBytes } over the reused `install-progress` channel (04-02/04-03),
    // not raw log lines. Render percent into the bar; guard defensively for a
    // possibly-string payload. onInstallProgress returns an unsubscribe fn.
    let unsubscribe = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      unsubscribe = window.electronAPI.onInstallProgress((p) => {
        if (!p) return;
        if (typeof p === 'string') { appendModelLog(p); return; }
        if (typeof p.percent === 'number') {
          if (modelDownloadBar) modelDownloadBar.style.width = `${p.percent}%`;
          if (modelDownloadStatus) modelDownloadStatus.textContent = `Downloading — ${p.percent}%`;
        }
        const parts = [];
        if (typeof p.percent === 'number') parts.push(`${p.percent}%`);
        if (typeof p.downloadedBytes === 'number' && typeof p.totalBytes === 'number') {
          parts.push(`${_mb(p.downloadedBytes)} / ${_mb(p.totalBytes)}`);
        }
        if (parts.length) appendModelLog(parts.join('  ·  '));
      });
    }

    try {
      const r = await window.electronAPI.downloadWhisperModel('small.en');
      state.modelDownloading = false;
      if (r && r.ok) {
        state.modelDownloaded = true;
        if (modelDownloadBar) modelDownloadBar.style.width = '100%';
        if (modelDownloadStatus) modelDownloadStatus.textContent = 'Voice model ready';
        appendModelLog(`\n✓ Voice model ready${r.path ? `: ${r.path}` : ''}`);
        nextBtn.disabled = false;
        nextBtn.classList.remove('primary');
        nextBtn.classList.add('success');
        nextBtn.innerHTML = '<i class="fas fa-check-circle"></i> Continue';
      } else {
        if (modelDownloadStatus) modelDownloadStatus.textContent = 'Download did not finish';
        appendModelLog(`\n✗ Download failed: ${(r && r.message) || 'unknown error'} — you can continue anyway; it resumes on retry.`);
        // Let user continue anyway; they'll download on first use / retry.
        nextBtn.disabled = false;
      }
    } catch (e) {
      state.modelDownloading = false;
      if (modelDownloadStatus) modelDownloadStatus.textContent = 'Download error';
      appendModelLog(`\n! Error: ${e.message || e} — you can continue anyway; it resumes on retry.`);
      nextBtn.disabled = false;
    } finally {
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_) { /* ignore */ }
      } else if (window.electronAPI && window.electronAPI.removeAllListeners) {
        try { window.electronAPI.removeAllListeners('install-progress'); } catch (_) { /* ignore */ }
      }
    }
  }

  // ── Wire up: Local model engine (Ollama) screen ──────────────────
  const ollamaSubtitle = $('#ollamaSubtitle');
  const ollamaDetectState = $('#ollamaDetectState');
  const ollamaDetectStatus = $('#ollamaDetectStatus');
  const ollamaInstallCard = $('#ollamaInstallCard');

  function setOllamaStatus(state_, text) {
    ollamaDetectStatus.className = `status-pill ${state_}`;
    const icon = ollamaDetectStatus.querySelector('i');
    if (state_ === 'success') icon.className = 'fas fa-check-circle';
    else if (state_ === 'error') icon.className = 'fas fa-circle-xmark';
    else if (state_ === 'idle') icon.className = 'fas fa-circle-info';
    else icon.className = 'fas fa-circle-notch fa-spin';
    ollamaDetectStatus.querySelector('.text').textContent = text;
  }

  async function runOllamaDetect() {
    ollamaDetectState.textContent = 'checking…';
    setOllamaStatus('testing', 'Probing');
    // Guide-install path: the engine is missing until getModelStatus proves the
    // server is up. We never bundle Ollama or silently fail — we point the user
    // at the installer (openwhispr-style) and let them re-check.
    try {
      // Detection only needs serverUp — skip the model-liveness generate so this
      // never blocks on "Probing" while a cold model loads.
      const s = (await window.electronAPI.getModelStatus({ probeResponds: false })) || {};
      state.ollamaDetected = !!s.serverUp;
    } catch (_) {
      state.ollamaDetected = false;
    }
    if (state.ollamaDetected) {
      ollamaDetectState.textContent = 'running';
      setOllamaStatus('success', 'Ollama detected');
      ollamaSubtitle.textContent = 'Ollama is running. Next we’ll download the model that powers your answers.';
      ollamaInstallCard.style.display = 'none';
      nextBtn.disabled = false;
    } else {
      ollamaDetectState.textContent = 'not found';
      setOllamaStatus('error', 'Not running');
      ollamaSubtitle.textContent = 'OpenCluely needs the Ollama engine to run its local model. Install it, then re-check.';
      ollamaInstallCard.style.display = 'block';
      nextBtn.disabled = true;
    }
  }

  let ollamaInitialized = false;
  function enterOllamaScreen() {
    if (!ollamaInitialized) {
      ollamaInitialized = true;
      const dl = $('#ollamaDownloadBtn');
      const recheck = $('#ollamaRecheckBtn');
      if (dl) {
        dl.addEventListener('click', () => {
          if (window.electronAPI && window.electronAPI.openExternal) {
            window.electronAPI.openExternal('https://ollama.com/download');
          }
        });
      }
      if (recheck) {
        recheck.addEventListener('click', () => runOllamaDetect());
      }
    }
    runOllamaDetect();
  }

  // ── Wire up: Local model pull screen (qwen3-vl:8b) ────────────────
  const modelPullBar = $('#modelPullBar');
  const modelPullStatus = $('#modelPullStatus');
  const modelPullLog = $('#modelPullLog');
  const modelPreflightWarn = $('#modelPreflightWarn');
  const LOCAL_MODEL_TAG = 'qwen3-vl:8b';

  function appendModelPullLog(line) {
    modelPullLog.textContent += (modelPullLog.textContent ? '\n' : '') + line;
    modelPullLog.scrollTop = modelPullLog.scrollHeight;
  }

  async function renderPreflightWarnings() {
    modelPreflightWarn.innerHTML = '';
    try {
      const pf = (await window.electronAPI.modelPreflight()) || {};
      const warnings = Array.isArray(pf.warnings) ? pf.warnings : [];
      // Warn, do not block — friendly failure per the locked first-run decision.
      warnings.forEach((w) => {
        const banner = document.createElement('div');
        banner.className = 'preflight-warn';
        banner.innerHTML = `<i class="fas fa-triangle-exclamation"></i><span></span>`;
        banner.querySelector('span').textContent = w;
        modelPreflightWarn.appendChild(banner);
      });
    } catch (_) { /* preflight is best-effort */ }
  }

  let modelPullInitialized = false;
  function enterModelPullScreen() {
    if (state.modelPulled || state.modelPulling) return;
    if (!modelPullInitialized) {
      modelPullInitialized = true;
    }
    startModelPull();
  }

  async function startModelPull() {
    state.modelPulling = true;
    nextBtn.disabled = true;
    nextBtn.classList.remove('success');
    nextBtn.classList.add('primary');
    nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';

    await renderPreflightWarnings();

    modelPullBar.style.width = '0%';
    modelPullStatus.textContent = 'Starting download…';
    appendModelPullLog(`Pulling ${LOCAL_MODEL_TAG}…`);

    // Structured progress { status, percent, completed, total } — render the
    // percent into the bar (mirrors the whisper download-progress plumbing).
    let unsubscribe = null;
    if (window.electronAPI && window.electronAPI.onModelPullProgress) {
      unsubscribe = window.electronAPI.onModelPullProgress((p) => {
        if (!p) return;
        if (typeof p.percent === 'number') {
          modelPullBar.style.width = `${p.percent}%`;
        }
        if (p.status) {
          modelPullStatus.textContent = p.percent != null
            ? `${p.status} — ${p.percent}%`
            : p.status;
          appendModelPullLog(p.percent != null ? `${p.status} (${p.percent}%)` : p.status);
        }
      });
    }

    try {
      const r = await window.electronAPI.pullModel(LOCAL_MODEL_TAG);
      state.modelPulling = false;
      if (r && r.ok) {
        state.modelPulled = true;
        modelPullBar.style.width = '100%';
        modelPullStatus.textContent = 'Model ready';
        appendModelPullLog(`✓ ${LOCAL_MODEL_TAG} is ready.`);
        nextBtn.disabled = false;
        nextBtn.classList.remove('primary');
        nextBtn.classList.add('success');
        nextBtn.innerHTML = '<i class="fas fa-check-circle"></i> Continue';
      } else {
        modelPullStatus.textContent = 'Download did not finish';
        appendModelPullLog(`✗ ${(r && r.message) || 'Download failed'} — you can retry; it resumes where it left off.`);
        // Friendly failure: let them continue; the model pulls on first use.
        nextBtn.disabled = false;
        nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
      }
    } catch (e) {
      state.modelPulling = false;
      modelPullStatus.textContent = 'Download error';
      appendModelPullLog(`! ${e.message || e} — you can retry; it resumes where it left off.`);
      nextBtn.disabled = false;
      nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    } finally {
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_) { /* ignore */ }
      } else if (window.electronAPI && window.electronAPI.removeAllListeners) {
        try { window.electronAPI.removeAllListeners('model-pull-progress'); } catch (_) { /* ignore */ }
      }
    }
  }

  // ── Wire up: Finish screen ────────────────────────────────────────
  function populateSummary() {
    const rows = [];
    if (state.speechProvider === 'whisper') {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: state.whisperDetected ? 'Local voice engine (whisper.cpp)' : 'Voice engine unavailable',
        cls: state.whisperDetected ? 'ok' : 'skip',
      });
    } else if (state.speechProvider === 'azure') {
      rows.push({
        label: '<i class="fas fa-cloud"></i> Speech',
        value: 'Azure',
        cls: 'ok',
      });
    } else {
      rows.push({
        label: '<i class="fas fa-microphone"></i> Speech',
        value: 'Skipped (configure later)',
        cls: 'skip',
      });
    }
    rows.push({
      label: '<i class="fas fa-file-lines"></i> Config saved to',
      value: '.env',
      cls: 'ok',
    });
    $('#summaryList').innerHTML = rows
      .map((r) => `
        <div class="summary-row">
          <div class="label">${r.label}</div>
          <div class="value ${r.cls}">${r.value}</div>
        </div>
      `)
      .join('');
  }

  $('#starBtn').addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('https://github.com/TechyCSR/OpenCluely');
    } else {
      window.open('https://github.com/TechyCSR/OpenCluely', '_blank');
    }
  });
  $('#skipStarBtn').addEventListener('click', () => {
    // No-op — just visual closure
  });

  // ── Wire up: Hero CTA (welcome screen) ────────────────────────────
  // The big inline "Get Started" button on the welcome screen reuses
  // the existing nav-button handler so all validation, persistence,
  // and navigation logic stays in one place.
  const heroCtaBtn = $('#heroCtaBtn');
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', () => nextBtn.click());
  }

  // ── Wire up: nav buttons ──────────────────────────────────────────
  nextBtn.addEventListener('click', async () => {
    const name = currentScreenName();
    if (!canAdvance()) {
      return;
    }

    // Persist speech settings on the speech screen (Azure path).
    if (name === 'speech' && window.electronAPI) {
      try {
        const payload = {
          speechProvider:
            state.speechProvider === 'skip' ? 'whisper' : state.speechProvider,
        };
        if (state.speechProvider === 'azure') {
          payload.azureKey = state.azureKey;
          payload.azureRegion = state.azureRegion;
        }
        await window.electronAPI.saveSettings(payload);
      } catch (_) { /* surfaced elsewhere */ }
    }

    // Whisper screen: kick off detection on entry
    if (name === 'speech' && state.speechProvider === 'whisper') {
      // (deferred: will run via enterWhisperScreen)
    }

    // Model download screen: persist choice
    if (name === 'model-download') {
      if (window.electronAPI && state.modelDownloadChoice) {
        try {
          await window.electronAPI.saveSettings({ whisperModelDownload: state.modelDownloadChoice });
        } catch (_) { /* ignore */ }
      }
    }

    // Finish: close onboarding
    if (name === 'finish') {
      try {
        await window.electronAPI.completeFirstRun();
      } catch (_) { /* ignore */ }
      try {
        await window.electronAPI.closeOnboarding();
      } catch (_) { /* ignore */ }
      state.finished = true;
      return;
    }

    // Move forward, with whisper-screen insertion handled by order logic
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const nextName = order[idx + 1];
    if (!nextName) return;

    // Compute new step index
    state.step = orderScreenToStep(nextName);
    showScreen(nextName);
    if (nextName === 'whisper') enterWhisperScreen();
    if (nextName === 'model-download') enterModelDownloadScreen();
    if (nextName === 'ollama') enterOllamaScreen();
    if (nextName === 'model-pull') enterModelPullScreen();
    if (nextName === 'finish') populateSummary();

    // Re-render stepper with new total
    refreshStepper();
  });

  backBtn.addEventListener('click', () => {
    const name = currentScreenName();
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const prevName = order[idx - 1];
    if (!prevName) return;
    state.step = orderScreenToStep(prevName);
    showScreen(prevName);
  });

  // Skip button: only shown on the whisper screen, lets user skip install
  // even if the CLI isn't present (they can configure later).
  function refreshSkipVisibility() {
    skipBtn.style.display = currentScreenName() === 'whisper' && !state.whisperDetected
      ? 'inline-flex'
      : 'none';
  }

  // Hook into showScreen to keep skip visibility in sync
  const _origShowScreen = showScreen;
  showScreen = function (name) {
    _origShowScreen(name);
    refreshSkipVisibility();
    refreshStepper();
  };

  skipBtn.addEventListener('click', () => {
    state.skippingWhisper = true;
    // Jump to finish without installing
    const order = computeScreenOrder();
    const finishName = order[order.length - 1];
    state.step = orderScreenToStep(finishName);
    showScreen(finishName);
    populateSummary();
  });

  // ── Boot ──────────────────────────────────────────────────────────
  showScreen('welcome');
})();