// Simple logger for renderer process
const logger = {
    info: (...args) => console.log('[MainWindowUI]', ...args),
    debug: (...args) => console.log('[MainWindowUI DEBUG]', ...args),
    error: (...args) => console.error('[MainWindowUI ERROR]', ...args),
    warn: (...args) => console.warn('[MainWindowUI WARN]', ...args)
};

class MainWindowUI {
    constructor() {
        this.isInteractive = false;
        this.isHidden = false;
        this.currentSkill = 'general'; // Default, will be updated from settings
        this.statusDot = null;
        this.skillIndicator = null;
        this.micButton = null;
        this.isRecording = false;
        this.speechAvailable = false; // track availability
        this._popoverHideTimeout = null;
        // Renderer-side audio capture state (used for Whisper on Windows)
        this._audioContext = null;
        this._mediaStream = null;
        this._scriptNode = null;
        this._captureInterval = null;
        // Debounce for mic-device-change (AirPods in/out) re-acquire.
        this._deviceChangeTimer = null;
        
        // Define available skills for navigation
        this.availableSkills = [
            'general',
            'programming'
        ];
        
        this.init();
    }

    async init() {
        try {
            this.setupElements();
            this.setupEventListeners();
            
            // Load current skill from settings
            await this.loadCurrentSkill();
            
            // Load current interaction state
            await this.loadCurrentInteractionState();
            
            // Fetch speech availability
            await this.loadSpeechAvailability();
            
            this.updateSkillIndicator();
            this.updateAllElementStates(); // Update all elements with current state
            this.resizeWindowToContent();
            
            logger.info('Main window UI initialized', {
                component: 'MainWindowUI',
                skill: this.currentSkill,
                interactive: this.isInteractive
            });

            // Notify the main process that the overlay renderer is ready
            // so it can push the latest speech availability state.
            if (window.electronAPI && window.electronAPI.notifyMainWindowReady) {
                window.electronAPI.notifyMainWindowReady();
            }
            
        } catch (error) {
            logger.error('Failed to initialize main window UI', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentSkill() {
        try {
            if (window.electronAPI && window.electronAPI.getSettings) {
                const settings = await window.electronAPI.getSettings();
                if (settings && settings.activeSkill) {
                    this.currentSkill = settings.activeSkill;
                    logger.debug('Loaded current skill from settings', {
                        component: 'MainWindowUI',
                        skill: this.currentSkill
                    });
                }
            }
        } catch (error) {
            logger.warn('Failed to load current skill from settings', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentInteractionState() {
        try {
            // Request current interaction state from main process
            if (window.electronAPI && window.electronAPI.getWindowStats) {
                const stats = await window.electronAPI.getWindowStats();
                if (stats && typeof stats.isInteractive === 'boolean') {
                    this.isInteractive = stats.isInteractive;
                    logger.debug('Loaded current interaction state', {
                        component: 'MainWindowUI',
                        interactive: this.isInteractive
                    });
                }
            }
        } catch (error) {
            // If we can't get the state, assume non-interactive (safer default)
            this.isInteractive = false;
            logger.warn('Failed to load current interaction state, defaulting to non-interactive', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadSpeechAvailability() {
        try {
            if (window.electronAPI && window.electronAPI.getSpeechAvailability) {
                this.speechAvailable = await window.electronAPI.getSpeechAvailability();
                this.applyMicVisibility();
            }
        } catch (e) {
            this.speechAvailable = false;
            this.applyMicVisibility();
        }
    }

    applyMicVisibility() {
        if (this.micButton) {
            if (this.speechAvailable) {
                this.micButton.style.display = '';
            } else {
                this.micButton.style.display = 'none';
            }
            // Resize to reflect layout change
            setTimeout(() => this.resizeWindowToContent(), 50);
        }
    }

    updateAllElementStates() {
        // Update all interactive elements with current state
        this.updateStatusDot();
        this.updateSkillIndicatorState();
        this.updateMicButtonState();
        this.updateSettingsIndicatorState();
    }

    updateStatusDot() {
        if (this.statusDot) {
            logger.debug('Updating status dot', {
                component: 'MainWindowUI',
                isInteractive: this.isInteractive,
                currentClasses: this.statusDot.className
            });
            
            // Remove both classes first
            this.statusDot.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.statusDot.classList.add('interactive');
            } else {
                this.statusDot.classList.add('non-interactive');
            }
            
            logger.debug('Status dot updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                newClasses: this.statusDot.className
            });
        } else {
            logger.error('Status dot element not found');
        }
    }

    updateSkillIndicatorState() {
        if (this.skillIndicator) {
            // Remove both classes first
            this.skillIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.skillIndicator.classList.add('interactive');
            } else {
                this.skillIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Skill indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                classes: this.skillIndicator.className
            });
        }
    }

    updateMicButtonState() {
        if (this.micButton) {
            // Also hide when unavailable
            this.applyMicVisibility();
            // Remove both classes first
            this.micButton.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.micButton.classList.add('interactive');
            } else {
                this.micButton.classList.add('non-interactive');
            }
            
            // Update button state
            this.micButton.disabled = !this.isInteractive;
            
            logger.debug('Mic button state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                disabled: !this.isInteractive
            });
        }
    }

    updateSettingsIndicatorState() {
        if (this.settingsIndicator) {
            // Remove both classes first
            this.settingsIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.settingsIndicator.classList.add('interactive');
            } else {
                this.settingsIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Settings indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive
            });
        } else {
            logger.debug('Settings indicator not found, skipping state update');
        }
    }

    resizeWindowToContent() {
        // Wait for DOM to fully render
        setTimeout(() => {
            const commandTab = document.querySelector('.command-tab');
            if (commandTab && window.electronAPI && window.electronAPI.resizeWindow) {
                const rect = commandTab.getBoundingClientRect();
                const width = Math.ceil(rect.width);
                let height = Math.ceil(rect.height);

                // If shortcuts popover is visible, extend height to fit it
                if (this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    const popRect = this.shortcutsPopover.getBoundingClientRect();
                    // popover is positioned below the bar (top:36px), add that plus its height and a small margin
                    height = Math.max(height, Math.ceil(36 + popRect.height + 8));
                }
                
                logger.debug('Resizing window to content', {
                    width,
                    height,
                    component: 'MainWindowUI'
                });
                
                window.electronAPI.resizeWindow(width, height);
            }
        }, 100);
    }

    setupElements() {
        this.statusDot = document.getElementById('statusDot');
        this.skillIndicator = document.getElementById('skillIndicator');
        this.settingsIndicator = document.getElementById('settingsIndicator'); // Optional
        this.micButton = document.getElementById('micButton');
    this.infoButton = document.getElementById('infoButton');
    this.shortcutsPopover = document.getElementById('shortcutsPopover');

        // NEW: Screenshot button is the first .command-item without id
        const commandItems = document.querySelectorAll('.command-item');
        this.screenshotButton = commandItems && commandItems[0];

    if (!this.statusDot || !this.skillIndicator || !this.micButton || !this.screenshotButton) {
            throw new Error('Required UI elements not found');
        }

        // Screenshot click handler
        this.screenshotButton.addEventListener('click', () => {
            if (this.isInteractive && window.electronAPI && window.electronAPI.takeScreenshot) {
                window.electronAPI.takeScreenshot();
            }
        });

        // Skill indicator click handler cycles through the available skills
        this.skillIndicator.addEventListener('click', () => {
            if (!this.isInteractive) return;
            const currentIndex = this.availableSkills.indexOf(this.currentSkill);
            const newSkill = this.availableSkills[(currentIndex + 1) % this.availableSkills.length];
            if (window.electronAPI && window.electronAPI.updateActiveSkill) {
                window.electronAPI.updateActiveSkill(newSkill).then(() => {
                    this.handleSkillActivated(newSkill);
                });
            } else {
                this.handleSkillActivated(newSkill);
            }
        });

        // Check for required elements (settingsIndicator is optional)
        if (this.settingsIndicator) {
            this.settingsIndicator.addEventListener('click', () => {
                if (this.isInteractive) {
                    this.showSettingsMenu();
                }
            });
        }

        // Add click handler for microphone
        this.micButton.addEventListener('click', async () => {
            if (this.isInteractive && this.speechAvailable) {
                try {
                    if (this.isRecording) {
                        await window.electronAPI.stopSpeechRecognition();
                    } else {
                        await window.electronAPI.startSpeechRecognition();
                    }
                } catch (error) {
                    logger.error('Speech recognition toggle failed', {
                        component: 'MainWindowUI',
                        error: error.message
                    });
                    this.isRecording = false;
                    this.updateMicButtonState();
                }
            } else if (this.isInteractive && !this.speechAvailable) {
                logger.warn('Mic clicked but speech recognition is not available', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            }
        });

        // Language dropdown
        this.languageSelect = document.getElementById('codingLanguage');
        if (this.languageSelect) {
            // Set default to Python if no value is set
            this.languageSelect.value = 'python';

            // Initialize with current setting
            if (window.electronAPI && window.electronAPI.getSettings) {
                window.electronAPI.getSettings().then(settings => {
                    if (settings && settings.codingLanguage) {
                        this.languageSelect.value = settings.codingLanguage;
                    } else {
                        // Save Python as default if no language is set
                        this.languageSelect.value = 'python';
                        window.electronAPI.saveSettings({ codingLanguage: 'python' });
                    }
                }).catch(() => {
                    // Fallback to Python on error
                    this.languageSelect.value = 'python';
                });
            }

            this.languageSelect.addEventListener('change', (e) => {
                const lang = e.target.value;
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    window.electronAPI.saveSettings({ codingLanguage: lang });
                }
                // Resize for any width change
                setTimeout(() => {
                    const commandTab = document.querySelector('.command-tab');
                    if (commandTab && window.electronAPI && window.electronAPI.resizeWindow) {
                        const rect = commandTab.getBoundingClientRect();
                        window.electronAPI.resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height));
                    }
                }, 50);
            });
        }

        // Info button / shortcuts popover
        if (this.infoButton && this.shortcutsPopover) {
            this.infoButton.addEventListener('click', (e) => {
                if (!this.isInteractive) return;
                e.stopPropagation();
                this.toggleShortcutsPopover();
            });

            // Hover to show
            this.infoButton.addEventListener('mouseenter', () => {
                if (!this.isInteractive) return;
                this.showShortcutsPopover();
            });
            // Queue hide when leaving the button
            this.infoButton.addEventListener('mouseleave', () => this.queueHideShortcutsPopover());

            // Keep open when hovering popover
            this.shortcutsPopover.addEventListener('mouseenter', () => {
                if (this._popoverHideTimeout) {
                    clearTimeout(this._popoverHideTimeout);
                    this._popoverHideTimeout = null;
                }
            });
            // Hide after a small delay when leaving popover
            this.shortcutsPopover.addEventListener('mouseleave', () => this.queueHideShortcutsPopover());

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (!this.shortcutsPopover) return;
                const isClickInside = this.shortcutsPopover.contains(e.target) || this.infoButton.contains(e.target);
                if (!isClickInside && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });

            // Close on Escape
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });
        }
    }

    setupEventListeners() {
        if (window.electronAPI) {
            // Fix interaction mode change listener
            window.electronAPI.onInteractionModeChanged((event, interactive) => {
                logger.debug('Interaction mode changed received:', interactive);
                this.handleInteractionModeChanged(interactive);
            });

            window.electronAPI.onRecordingStarted(() => {
                this.handleRecordingStarted();
            });

            window.electronAPI.onRecordingStopped(() => {
                this.handleRecordingStopped();
            });

            // Mic-device-change resilience (AirPods in/out, USB headset swap):
            // while ambient/recording is active, tear down + re-acquire the
            // getUserMedia stream so listening survives the swap. Debounced
            // (devicechange often fires several times per swap) and wrapped so a
            // transient device error never crashes the renderer.
            if (typeof navigator !== 'undefined' && navigator.mediaDevices &&
                typeof navigator.mediaDevices.addEventListener === 'function') {
                navigator.mediaDevices.addEventListener('devicechange', () => {
                    this._handleAudioDeviceChange();
                });
            }

            window.electronAPI.onSkillChanged((event, data) => {
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                }
            });

            window.electronAPI.onSpeechAvailability((event, data) => {
                this.speechAvailable = !!(data && data.available);
                this.applyMicVisibility();
            });

            // Listen for coding language changes from other windows
            window.electronAPI.onCodingLanguageChanged((event, data) => {
                if (data && data.language && this.languageSelect) {
                    // avoid clobbering if same value
                    if (this.languageSelect.value !== data.language) {
                        this.languageSelect.value = data.language;
                    }
                    logger.debug('Language updated from other window', {
                        component: 'MainWindowUI',
                        language: data.language
                    });
                }
            });

            // Listen for main window shown event to refresh speech availability
            window.electronAPI.onMainWindowShown(() => {
                logger.debug('Main window shown - refreshing speech availability', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            });

            // Local-engine safety net (03-06): the overlay listens for LLM
            // responses/errors so that when Local can't answer (Ollama down /
            // model missing / OOM) it can surface a one-click recovery panel.
            // main.js broadcasts these to ALL windows, so the overlay sees them.
            if (window.electronAPI.onLlmResponse) {
                window.electronAPI.onLlmResponse((event, data) => this.handleLLMResponse(data || {}));
            }
            if (window.electronAPI.onTranscriptionLlmResponse) {
                window.electronAPI.onTranscriptionLlmResponse((event, data) => this.handleLLMResponse(data || {}));
            }
            if (window.electronAPI.onLlmError) {
                window.electronAPI.onLlmError((event, data) => this.handleLLMError(data || {}));
            }

            // Global keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                if (e.altKey && e.key === 'r' && this.isInteractive) {
                    e.preventDefault();
                    if (!this.speechAvailable) return; // guard when unavailable
                    if (this.isRecording) {
                        window.electronAPI.stopSpeechRecognition();
                    } else {
                        window.electronAPI.startSpeechRecognition();
                    }
                }
            });
        }
        
        // Also listen via the api interface for backup
        if (window.api) {
            
            window.api.receive('interaction-mode-changed', (interactive) => {
                logger.debug('Interaction mode changed via api:', interactive);
                this.handleInteractionModeChanged(interactive);
            });
            
            window.api.receive('skill-updated', (data) => {
                logger.info('Skill updated event received from main process:', data);
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                } else if (typeof data === 'string') {
                    // Handle case where skill is passed directly as string
                    this.handleSkillChanged({ skill: data });
                } else {
                    logger.warn('Skill updated event received but no skill data found:', data);
                }
            });
            
            // Listen for skill updates from settings window  
            window.api.receive('update-skill', (skill) => {
                logger.info('Direct skill update received from settings:', skill);
                this.handleSkillChanged({ skill: skill });
            });
        } else {
            logger.error('window.api not available - event listeners not set up!');
        }
        
        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Settings shortcut
        this.setupSettingsShortcut();
    }

    handleLLMResponse(data) {
        const skill = data.skill || data.metadata?.skill || 'General';
        const skillNames = {
            'general': 'General',
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displaySkill = skillNames[skill] || skill.toUpperCase();

        logger.info('LLM response received', {
            component: 'MainWindowUI',
            skill: skill,
            displaySkill: displaySkill
        });

        // Local-down detection: the transcription/text/image handlers in main.js
        // degrade to LocalProvider.generateIntelligentFallbackResponse when the
        // sole engine can't answer. Its canned body always says "Local model
        // unavailable" and carries metadata.usedFallback. When we see it, offer a
        // one-click recovery instead of leaving the user with a dead answer.
        const meta = data.metadata || {};
        const text = data.response || data.content || '';
        const isLocalUnavailable = meta.usedFallback === true
            || /local model unavailable/i.test(text);
        if (isLocalUnavailable) {
            this.checkAndShowLocalUnavailable();
        } else {
            // A real answer arrived — the engine recovered; clear any panel.
            this.dismissLocalUnavailable();
        }
    }

    handleLLMError(data) {
        logger.error('LLM error received', {
            component: 'MainWindowUI',
            error: data && data.error
        });
        // Any hard LLM error now means the local engine failed (Local is the
        // sole engine post-PROV-07) — surface the recovery panel.
        this.checkAndShowLocalUnavailable();
    }

    // Fetch owned-vs-adopted + three-level health, then render the recovery panel.
    async checkAndShowLocalUnavailable() {
        // Don't clobber an in-flight re-download with a fresh fetch/rebuild.
        if (this._recoveryPulling) return;
        let status = {};
        try {
            if (window.electronAPI && window.electronAPI.getModelStatus) {
                status = (await window.electronAPI.getModelStatus()) || {};
            }
        } catch (error) {
            logger.warn('getModelStatus failed while building recovery panel', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
        this.showLocalUnavailable(status);
    }

    // Inline, dismissible "Local model unavailable" panel. Actions are keyed off
    // owned-vs-adopted so we NEVER offer to restart a daemon the app doesn't own.
    showLocalUnavailable(status = {}) {
        if (this._recoveryPulling) return; // keep the live progress panel intact

        const owned = !!status.owned;
        const adopted = !!status.adopted;
        const serverUp = !!status.serverUp;
        const modelPresent = !!status.modelPresent;
        const modelResponds = !!status.modelResponds;

        // Decide the message + the single primary action for this state.
        let message;
        let action = null; // { label, kind: 'restart' | 'repull' | 'settings' }
        if (owned && !serverUp) {
            message = 'Your local model engine (Ollama) stopped. Restart it to keep answering.';
            action = { label: 'Restart Ollama', kind: 'restart' };
        } else if (adopted && !serverUp) {
            // Adopted daemon: it isn't ours to restart — guide the user instead.
            message = "Your Ollama isn't running. Start it, or open Settings to reconfigure.";
            action = { label: 'Open Settings', kind: 'settings' };
        } else if (serverUp && !modelPresent) {
            message = `The local model (${status.model || 'qwen3-vl:8b'}) isn't installed. Re-download it to continue.`;
            action = { label: 'Re-download model', kind: 'repull' };
        } else if (serverUp && !modelResponds) {
            message = 'The local model failed to respond (it may be out of memory). Open Settings to pick a smaller model.';
            action = { label: 'Open Settings', kind: 'settings' };
        } else if (!serverUp) {
            // Server down but ownership unknown — safe default is guidance, never a restart.
            message = "Your local model engine (Ollama) isn't reachable. Start it, or open Settings.";
            action = { label: 'Open Settings', kind: 'settings' };
        } else {
            message = "The local model couldn't answer that. Open Settings to check the model.";
            action = { label: 'Open Settings', kind: 'settings' };
        }

        this._renderLocalUnavailablePanel(message, action);
    }

    // Inject the panel's spinner keyframes once. index.html doesn't ship Font
    // Awesome or a .spinner class, so the recovery UI stays self-contained.
    _ensureRecoveryStyles() {
        if (document.getElementById('lu-styles')) return;
        const style = document.createElement('style');
        style.id = 'lu-styles';
        style.textContent = `
            @keyframes lu-spin { to { transform: rotate(360deg); } }
            .lu-spinner {
                display: inline-block;
                width: 11px; height: 11px;
                border: 2px solid rgba(0, 0, 0, 0.25);
                border-top-color: #0a0a0a;
                border-radius: 50%;
                animation: lu-spin 0.8s linear infinite;
                vertical-align: -1px;
                margin-right: 6px;
            }
        `;
        document.head.appendChild(style);
    }

    _renderLocalUnavailablePanel(message, action) {
        this.dismissLocalUnavailable();
        this._ensureRecoveryStyles();

        const panel = document.createElement('div');
        panel.className = 'local-unavailable-panel';
        panel.style.cssText = `
            position: fixed;
            top: 42px;
            left: 50%;
            transform: translateX(-50%);
            width: 400px;
            max-width: calc(100vw - 24px);
            background: linear-gradient(135deg, rgba(20, 20, 20, 0.92) 0%, rgba(10, 10, 10, 0.88) 100%);
            backdrop-filter: blur(18px);
            border: 1px solid rgba(248, 113, 113, 0.35);
            border-radius: 10px;
            color: rgba(255, 255, 255, 0.95);
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
            padding: 14px 16px;
            z-index: 1001;
            -webkit-app-region: no-drag;
            font-size: 12.5px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        panel.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="color:#f87171; font-size:14px; line-height:1;">&#9888;</span>
                <strong style="font-size:13px;">Local model unavailable</strong>
                <button class="lu-dismiss" title="Dismiss" style="margin-left:auto; background:transparent; border:0; color:rgba(255,255,255,0.6); cursor:pointer; font-size:16px; line-height:1;">&times;</button>
            </div>
            <div class="lu-message" style="color:rgba(255,255,255,0.85); line-height:1.5; margin-bottom:12px;"></div>
            <div class="lu-progress" style="display:none; margin-bottom:12px;">
                <div style="height:8px; background:rgba(255,255,255,0.08); border-radius:6px; overflow:hidden;">
                    <div class="lu-progress-fill" style="height:100%; width:0%; background:#4ade80; border-radius:6px; transition:width 0.3s ease;"></div>
                </div>
                <div class="lu-progress-status" style="margin-top:6px; font-size:11px; color:rgba(255,255,255,0.6);"></div>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button class="lu-primary" style="background:#f87171; border:0; border-radius:8px; color:#0a0a0a; font-weight:600; font-size:12px; padding:8px 14px; cursor:pointer;"></button>
                <button class="lu-close" style="background:transparent; border:1px solid rgba(255,255,255,0.18); border-radius:8px; color:rgba(255,255,255,0.85); font-size:12px; padding:8px 14px; cursor:pointer;">Dismiss</button>
            </div>
        `;

        panel.querySelector('.lu-message').textContent = message;
        panel.querySelector('.lu-primary').textContent = action.label;
        panel.querySelector('.lu-dismiss').addEventListener('click', () => this.dismissLocalUnavailable());
        panel.querySelector('.lu-close').addEventListener('click', () => this.dismissLocalUnavailable());
        panel.querySelector('.lu-primary').addEventListener('click', () => this._runRecoveryAction(action.kind, panel));

        document.body.appendChild(panel);
        this._localUnavailablePanel = panel;
        this._resizeForPanel(panel);

        logger.info('Local-unavailable recovery panel shown', {
            component: 'MainWindowUI',
            action: action.kind
        });
    }

    async _runRecoveryAction(kind, panel) {
        if (kind === 'settings') {
            this.openSettings();
            this.dismissLocalUnavailable();
            return;
        }

        const primaryBtn = panel.querySelector('.lu-primary');
        if (kind === 'restart') {
            if (primaryBtn) {
                primaryBtn.disabled = true;
                primaryBtn.innerHTML = '<span class="lu-spinner"></span>Restarting…';
            }
            try {
                const result = await window.electronAPI.recoverModel('restart');
                if (result && result.serverUp) {
                    this.dismissLocalUnavailable();
                    this.showNotification('Ollama restarted — try again', 'success');
                } else {
                    // Couldn't restart (e.g. adopted daemon) — guide to Settings.
                    this.showLocalUnavailable(result || {});
                }
            } catch (error) {
                logger.error('Ollama restart failed', { component: 'MainWindowUI', error: error.message });
                if (primaryBtn) {
                    primaryBtn.disabled = false;
                    primaryBtn.textContent = 'Restart Ollama';
                }
            }
            return;
        }

        if (kind === 'repull') {
            this._recoveryPulling = true;
            const progress = panel.querySelector('.lu-progress');
            const fill = panel.querySelector('.lu-progress-fill');
            const pstatus = panel.querySelector('.lu-progress-status');
            if (progress) progress.style.display = 'block';
            if (primaryBtn) {
                primaryBtn.disabled = true;
                primaryBtn.innerHTML = '<span class="lu-spinner"></span>Downloading…';
            }
            this._resizeForPanel(panel);

            let unsubscribe = null;
            if (window.electronAPI.onModelPullProgress) {
                unsubscribe = window.electronAPI.onModelPullProgress((p) => {
                    if (!p) return;
                    if (fill && typeof p.percent === 'number') fill.style.width = `${p.percent}%`;
                    if (pstatus && p.status) {
                        pstatus.textContent = p.percent != null ? `${p.status} — ${p.percent}%` : p.status;
                    }
                });
            }
            try {
                const result = await window.electronAPI.recoverModel('repull');
                this._recoveryPulling = false;
                if (result && result.ok) {
                    this.dismissLocalUnavailable();
                    this.showNotification('Model re-downloaded — try again', 'success');
                } else if (pstatus) {
                    pstatus.textContent = (result && result.error) || 'Download failed — try again';
                    if (primaryBtn) { primaryBtn.disabled = false; primaryBtn.textContent = 'Re-download model'; }
                }
            } catch (error) {
                this._recoveryPulling = false;
                logger.error('Model re-download failed', { component: 'MainWindowUI', error: error.message });
                if (pstatus) pstatus.textContent = error.message || 'Download error';
                if (primaryBtn) { primaryBtn.disabled = false; primaryBtn.textContent = 'Re-download model'; }
            } finally {
                if (typeof unsubscribe === 'function') {
                    try { unsubscribe(); } catch (_) { /* ignore */ }
                } else if (window.electronAPI.removeAllListeners) {
                    try { window.electronAPI.removeAllListeners('model-pull-progress'); } catch (_) { /* ignore */ }
                }
            }
        }
    }

    _resizeForPanel(panel) {
        // Grow the compact command bar just enough to reveal the floating panel.
        setTimeout(() => {
            if (!panel || !panel.isConnected) return;
            if (window.electronAPI && window.electronAPI.resizeWindow) {
                const rect = panel.getBoundingClientRect();
                const width = Math.max(520, Math.ceil(rect.width) + 24);
                const height = Math.ceil(rect.bottom + 16);
                window.electronAPI.resizeWindow(width, height);
            }
        }, 50);
    }

    dismissLocalUnavailable() {
        if (!this._localUnavailablePanel) return; // no panel → cheap no-op on normal responses
        this._recoveryPulling = false;
        if (this._localUnavailablePanel.parentNode) {
            this._localUnavailablePanel.parentNode.removeChild(this._localUnavailablePanel);
        }
        this._localUnavailablePanel = null;
        // Shrink the window back to the compact command bar.
        this.resizeWindowToContent();
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.metaKey && e.key === '\\') {
                this.isHidden = !this.isHidden;
                if (this.isHidden) {
                    this.showHiddenIndicator();
                }
            }
            
            // Handle Cmd + Arrow keys based on interaction mode
            if (e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();

                if (this.isInteractive) {
                    // Interactive mode: Cmd + Up/Down for skill navigation
                    if (e.key === 'ArrowUp') {
                        this.navigateSkill(-1); // Previous skill
                    } else if (e.key === 'ArrowDown') {
                        this.navigateSkill(1); // Next skill
                    } else {
                    }
                    // Left/Right arrows do nothing in interactive mode
                } else {
                    // Non-interactive mode: Cmd + Arrow keys for window movement
                    this.moveWindow(e.key);
                }
            }
            
            // Alt+A is handled globally by the main process
            // No need to handle it here since it needs to work even when windows are non-interactive
        });
    }

    handleInteractionModeChanged(interactive) {
        logger.info('Handling interaction mode change', {
            component: 'MainWindowUI',
            newState: interactive,
            previousState: this.isInteractive
        });
        
        // Update the internal state
        this.isInteractive = interactive;
        
        // Update all UI elements to reflect the new state
        this.updateAllElementStates();

        // Auto-hide popover when leaving interactive mode
        if (!this.isInteractive && this.shortcutsPopover && this.shortcutsPopover.style.display !== 'none') {
            this.hideShortcutsPopover();
        }
        
        // Update skill indicator tooltip
        this.updateSkillIndicator();
        
        logger.info('Interaction mode change completed', {
            component: 'MainWindowUI',
            interactive: this.isInteractive,
            statusDotClass: this.statusDot ? this.statusDot.className : 'not found',
            skillIndicatorClass: this.skillIndicator ? this.skillIndicator.className : 'not found'
        });
    }

    handleSkillChanged(data) {
        const oldSkill = this.currentSkill;
        this.currentSkill = data.skill;
        
        logger.info('Handling skill change', {
            component: 'MainWindowUI',
            oldSkill: oldSkill,
            newSkill: data.skill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        this.updateSkillIndicator();
        
        logger.info('Skill changed successfully', {
            component: 'MainWindowUI',
            skill: data.skill
        });
    }

    handleSkillActivated(skillName) {
        this.currentSkill = skillName;
        this.updateSkillIndicator();
        
        logger.info('Skill activated', {
            component: 'MainWindowUI',
            skill: skillName
        });
    }

    handleScreenshotRequest() {
        logger.debug('Screenshot request received', { component: 'MainWindowUI' });
    }

    handleRecordingStarted() {
        this.isRecording = true;
        if (this.micButton) {
            this.micButton.classList.add('recording');
        }
        // On Windows and macOS, Whisper audio is captured here in the renderer
        // (Web Audio API) rather than the main process: Windows lacks sox/rec/
        // arecord, and macOS avoids an unbundled Homebrew `sox`. Must match the
        // main process's useRendererCapture gate (speech.service.js). Linux uses
        // the native recorder. navigator.userAgentData is preferred when present
        // since navigator.platform is deprecated.
        const platform = (typeof navigator !== 'undefined' &&
          ((navigator.userAgentData && navigator.userAgentData.platform) ||
            navigator.platform || '')).toLowerCase();
        const useRendererCapture = platform.includes('win') || platform.includes('mac');
        if (useRendererCapture) {
            this._startRendererAudioCapture();
        }
        logger.debug('Recording started', { component: 'MainWindowUI' });
    }

    handleRecordingStopped() {
        this.isRecording = false;
        if (this.micButton) {
            this.micButton.classList.remove('recording');
        }
        this._stopRendererAudioCapture();
        logger.debug('Recording stopped', { component: 'MainWindowUI' });
    }

    /**
     * Capture microphone audio in the renderer using the Web Audio API.
     * This is used for Whisper on Windows where node-record-lpcm16's sox/rec
     * dependencies are unavailable.
     */
    async _startRendererAudioCapture() {
        try {
            this._stopRendererAudioCapture();

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: { ideal: 16000 }
                }
            });
            this._mediaStream = stream;

            const audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
            this._audioContext = audioContext;

            const source = audioContext.createMediaStreamSource(stream);
            const bufferSize = 4096;
            const scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
            this._scriptNode = scriptNode;

            scriptNode.onaudioprocess = (event) => {
                if (!this.isRecording || !window.electronAPI || !window.electronAPI.sendAudioChunk) {
                    return;
                }
                const inputData = event.inputBuffer.getChannelData(0);
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                window.electronAPI.sendAudioChunk(pcm16.buffer);
            };

            source.connect(scriptNode);
            scriptNode.connect(audioContext.destination);

            logger.info('Renderer audio capture started', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to start renderer audio capture', {
                component: 'MainWindowUI',
                error: error.message
            });
            // Notify main process so it can stop the recording state
            try {
                await window.electronAPI.stopSpeechRecognition();
            } catch (_) { /* ignore */ }
        }
    }

    _stopRendererAudioCapture() {
        try {
            if (this._scriptNode) {
                this._scriptNode.disconnect();
                this._scriptNode.onaudioprocess = null;
                this._scriptNode = null;
            }
            if (this._mediaStream) {
                this._mediaStream.getTracks().forEach((track) => track.stop());
                this._mediaStream = null;
            }
            if (this._audioContext) {
                this._audioContext.close().catch(() => {});
                this._audioContext = null;
            }
            if (this._captureInterval) {
                clearInterval(this._captureInterval);
                this._captureInterval = null;
            }
            // Cancel any pending device-change re-acquire — we're no longer
            // capturing, so a queued re-acquire would be stale.
            if (this._deviceChangeTimer) {
                clearTimeout(this._deviceChangeTimer);
                this._deviceChangeTimer = null;
            }
        } catch (error) {
            logger.error('Error stopping renderer audio capture', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    /**
     * Debounced entry point for a mic-device change. devicechange fires several
     * times per physical swap (remove + add), so collapse a burst into a single
     * re-acquire. Only matters while we're actively capturing in the renderer.
     */
    _handleAudioDeviceChange() {
        if (!this.isRecording) {
            return;
        }
        if (this._deviceChangeTimer) {
            clearTimeout(this._deviceChangeTimer);
        }
        this._deviceChangeTimer = setTimeout(() => {
            this._deviceChangeTimer = null;
            this._reacquireMicAfterDeviceChange();
        }, 500);
    }

    /**
     * Re-acquire the microphone after a device change without crashing. Resets
     * the main-process mic VAD channel first (drops the truncated partial from
     * the old device), then re-runs renderer capture (which tears down + opens a
     * fresh getUserMedia on the new default device). If capture truly can't
     * resume, notify main via the existing stop path so recording state stays
     * consistent.
     */
    async _reacquireMicAfterDeviceChange() {
        if (!this.isRecording) {
            return;
        }
        try {
            logger.info('Audio device changed — re-acquiring microphone', {
                component: 'MainWindowUI'
            });
            if (window.electronAPI && typeof window.electronAPI.reattachSpeechChannel === 'function') {
                try { await window.electronAPI.reattachSpeechChannel('mic'); } catch (_) { /* best effort */ }
            }
            // _startRendererAudioCapture() calls _stopRendererAudioCapture()
            // first, so this is a clean teardown + re-acquire.
            await this._startRendererAudioCapture();
        } catch (error) {
            logger.error('Failed to re-acquire microphone after device change', {
                component: 'MainWindowUI',
                error: error.message
            });
            try { await window.electronAPI.stopSpeechRecognition(); } catch (_) { /* ignore */ }
        }
    }

    updateSkillIndicator() {
        const skillNames = {
            'general': 'General',
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        logger.info('Updating skill indicator', {
            component: 'MainWindowUI',
            currentSkill: this.currentSkill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        if (!this.skillIndicator) {
            logger.error('Skill indicator element not found!');
            return;
        }
        
        const skillName = skillNames[this.currentSkill] || this.currentSkill.toUpperCase();
        const skillSpan = this.skillIndicator.querySelector('span');
        
        logger.info('Looking for skill span element', {
            component: 'MainWindowUI',
            spanExists: !!skillSpan,
            skillName: skillName
        });
        
        if (skillSpan) {
            const oldText = skillSpan.textContent;
            skillSpan.textContent = skillName;
                        
            const tooltip = this.isInteractive ? 
                `${skillName} - Use ⌘↑/↓ to navigate skills` : 
                `${skillName} - Enable interactive mode (Alt+A) to navigate`;
            this.skillIndicator.title = tooltip;
            
            // Add visual feedback for skill change
            this.animateSkillChange();
            
            logger.info('Skill indicator updated successfully', {
                component: 'MainWindowUI',
                oldText: oldText,
                newText: skillName,
                interactive: this.isInteractive
            });
        } else {
            logger.error('Skill span element not found within skill indicator!');
        }
    }

    animateSkillChange() {
        if (this.skillIndicator) {
            this.skillIndicator.style.transform = 'scale(1.1)';
            this.skillIndicator.style.transition = 'transform 0.2s ease';
            
            setTimeout(() => {
                this.skillIndicator.style.transform = 'scale(1)';
            }, 200);
        }
    }

    navigateSkill(direction) {
        
        if (!this.isInteractive) {
            return;
        }
        
        const currentIndex = this.availableSkills.indexOf(this.currentSkill);
        if (currentIndex === -1) {
            logger.error('Current skill not found in available skills array');
            return;
        }
        
        // Calculate new index with wrapping
        let newIndex = currentIndex + direction;
        if (newIndex >= this.availableSkills.length) {
            newIndex = 0; // Wrap to beginning
        } else if (newIndex < 0) {
            newIndex = this.availableSkills.length - 1; // Wrap to end
        }
        
        const newSkill = this.availableSkills[newIndex];
        
        // Update skill locally and notify main process
        this.currentSkill = newSkill;
        this.updateSkillIndicator();
        
        // Save the skill change via IPC
        if (window.electronAPI && window.electronAPI.updateActiveSkill) {
            window.electronAPI.updateActiveSkill(newSkill).then(() => {
                logger.info('Skill navigation completed', {
                    component: 'MainWindowUI',
                    newSkill,
                    direction: direction > 0 ? 'down' : 'up'
                });
            }).catch(error => {
                logger.error('Failed to update skill via navigation', {
                    component: 'MainWindowUI',
                    error: error.message
                });
            });
        }
        
        // Show visual feedback
        this.showSkillChangeNotification(newSkill, direction);
    }

    showSkillChangeNotification(skill, direction) {
        const skillNames = {
            'general': 'General',
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displayName = skillNames[skill] || skill.toUpperCase();
        const arrow = direction > 0 ? '↓' : '↑';
        
        // Create temporary notification
        const notification = document.createElement('div');
        notification.className = 'skill-change-notification';
        notification.innerHTML = `${arrow} ${displayName}`;
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.2s ease;
        `;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);
        
        // Remove after 1 second
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 200);
        }, 1000);
    }

    showHiddenIndicator() {
        const indicator = document.querySelector('.hidden-indicator');
        if (indicator) {
            indicator.classList.add('show');
            setTimeout(() => {
                indicator.classList.remove('show');
            }, 3000);
        }
    }

    toggleInteractiveMode() {
        this.isInteractive = !this.isInteractive;
        this.updateAllElementStates();
        
        logger.debug('Interactive mode toggled', {
            component: 'MainWindowUI',
            interactive: this.isInteractive
        });
    }

    moveWindow(direction) {
        const moveDistance = 20; // pixels
        
        if (window.electronAPI && window.electronAPI.moveWindow) {
            let deltaX = 0, deltaY = 0;
            
            switch(direction) {
                case 'ArrowUp':
                    deltaY = -moveDistance;
                    break;
                case 'ArrowDown':
                    deltaY = moveDistance;
                    break;
                case 'ArrowLeft':
                    deltaX = -moveDistance;
                    break;
                case 'ArrowRight':
                    deltaX = moveDistance;
                    break;
            }
            
            window.electronAPI.moveWindow(deltaX, deltaY);
            logger.debug('Moving window', {
                component: 'MainWindowUI',
                direction: direction,
                deltaX: deltaX,
                deltaY: deltaY,
                interactive: this.isInteractive
            });
        } else {
            logger.warn('moveWindow API not available', { component: 'MainWindowUI' });
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 p-4 rounded-lg text-white z-50 ${
            type === 'error' ? 'bg-red-600' : 
            type === 'success' ? 'bg-green-600' :
            'bg-blue-600'
        }`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
        
        logger.debug('Notification shown', {
            component: 'MainWindowUI',
            message,
            type
        });
    }

    setupSettingsShortcut() {
        document.addEventListener('keydown', (e) => {
            // Cmd+, or Ctrl+, for settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                logger.debug('Settings keyboard shortcut pressed');
                e.preventDefault();
                this.openSettings();
            }
        });
    }

    openSettings() {
        try {
            if (window.electronAPI && window.electronAPI.showSettings) {
                window.electronAPI.showSettings();
            } else {
                logger.error('electronAPI or showSettings not available');
                return;
            }
            
            // Add visual feedback
            if (this.settingsIndicator) {
                this.settingsIndicator.style.transform = 'scale(1.1)';
                this.settingsIndicator.style.transition = 'transform 0.2s ease';
                
                setTimeout(() => {
                    this.settingsIndicator.style.transform = 'scale(1)';
                }, 200);
            }
            
            logger.info('Settings window opened', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to open settings', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to open settings', 'error');
        }
    }

    showSettingsMenu() {
        const menu = document.createElement('div');
        menu.className = 'settings-menu';
        menu.style.cssText = `
            position: absolute;
            right: 10px;
            top: 35px;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 8px 0;
            min-width: 150px;
            z-index: 1000;
        `;

        const settingsOption = this.createMenuItem('Settings', 'fa-cog', () => {
            this.openSettings();
            document.body.removeChild(menu);
        });

        const quitOption = this.createMenuItem('Quit OpenCluely', 'fa-power-off', () => {
            if (window.electronAPI && window.electronAPI.quit) {
                window.electronAPI.quit();
            }
        });

        menu.appendChild(settingsOption);
        menu.appendChild(this.createMenuSeparator());
        menu.appendChild(quitOption);

        // Add click outside listener to close menu
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !this.settingsIndicator.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);

        document.body.appendChild(menu);
    }

    createMenuItem(text, iconClass, onClick) {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 8px 16px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
        `;
        item.innerHTML = `<i class="fas ${iconClass}"></i>${text}`;
        item.addEventListener('mouseover', () => {
            item.style.background = 'rgba(255, 255, 255, 0.1)';
        });
        item.addEventListener('mouseout', () => {
            item.style.background = 'transparent';
        });
        item.addEventListener('click', onClick);
        return item;
    }

    createMenuSeparator() {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
            margin: 8px 0;
        `;
        return separator;
    }

    toggleShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    const isOpen = this.shortcutsPopover.classList.contains('is-open');
    if (!isOpen) {
            this.showShortcutsPopover();
        } else {
            this.hideShortcutsPopover();
        }
    }

    showShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) {
            clearTimeout(this._popoverHideTimeout);
            this._popoverHideTimeout = null;
        }
    this.shortcutsPopover.classList.add('is-open');
        // Resize main window to fit popover
        setTimeout(() => this.resizeWindowToContent(), 50);
    }

    hideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    this.shortcutsPopover.classList.remove('is-open');
    // resize back to compact after transition
    setTimeout(() => this.resizeWindowToContent(), 130);
    }

    queueHideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) clearTimeout(this._popoverHideTimeout);
        this._popoverHideTimeout = setTimeout(() => this.hideShortcutsPopover(), 180);
    }
}

// Initialize when DOM is ready
let mainWindowUI;
if (typeof document !== 'undefined') {
    // Add immediate visual indicator that script is loading
    const style = document.createElement('style');
    document.head.appendChild(style);
    
    document.addEventListener('DOMContentLoaded', () => {
                
        mainWindowUI = new MainWindowUI();
        // Make it globally accessible for debugging
        window.mainWindowUI = mainWindowUI;
        logger.info('MainWindowUI initialized and available as window.mainWindowUI');
    });
}

// module.exports = MainWindowUI; // Not needed in browser context