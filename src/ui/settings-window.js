document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');

    // AI model engine (PROV-06)
    const llmProvider = document.getElementById('llmProvider');
    const localModel = document.getElementById('localModel');
    const localModelAdvanced = document.getElementById('localModelAdvanced');
    const localModelFields = document.getElementById('localModelFields');
    const testProviderBtn = document.getElementById('testProviderBtn');
    const providerStatus = document.getElementById('providerStatus');
    const modelStatus = document.getElementById('modelStatus');
    const repairModelBtn = document.getElementById('repairModelBtn');
    const modelStatusLog = document.getElementById('modelStatusLog');

    // Curated list arrives from getSettings(); this fallback lets us classify a
    // saved model as curated-vs-advanced even before settings load.
    const DEFAULT_CURATED = ['qwen3-vl:8b', 'qwen3-vl:30b', 'gemma3:4b', 'gemma3:12b'];
    let curatedModels = DEFAULT_CURATED.slice();

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        // Provider + local model (PROV-06)
        if (Array.isArray(settings.curatedModels) && settings.curatedModels.length) {
            curatedModels = settings.curatedModels;
        }
        if (llmProvider) llmProvider.value = settings.provider || 'local';
        if (localModel) {
            const model = settings.model || '';
            const isCurated = !!model && curatedModels.includes(model);
            if (model && !isCurated) {
                localModel.value = '__advanced__';
                if (localModelAdvanced) {
                    populateAdvancedModels(model);
                    localModelAdvanced.style.display = '';
                }
            } else {
                if (model) localModel.value = model;
                if (localModelAdvanced) localModelAdvanced.style.display = 'none';
            }
        }
        updateLocalModelFieldStates();
        refreshModelStatus();

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;

        // Provider + local model (PROV-06)
        if (llmProvider) settings.provider = llmProvider.value;
        if (localModel) {
            settings.model = (localModel.value === '__advanced__')
                ? (localModelAdvanced ? localModelAdvanced.value : '')
                : localModel.value;
        }

        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
    };

    // ── AI model engine (PROV-06) UI helpers ──
    // The provider is resolved at app startup, so a switch is restart-to-apply
    // (mirrors the app's other .env-backed settings). No live hot-swap here.
    const updateLocalModelFieldStates = () => {
        const provider = llmProvider ? llmProvider.value : 'local';
        if (localModelFields) {
            localModelFields.style.display = provider === 'local' ? '' : 'none';
        }
    };

    // Populate the advanced picker from the running Ollama (03-04 bridge).
    const populateAdvancedModels = async (selected) => {
        if (!localModelAdvanced || !window.electronAPI || !window.electronAPI.listInstalledModels) return;
        try {
            const models = await window.electronAPI.listInstalledModels();
            localModelAdvanced.innerHTML = '';
            (models || []).forEach(name => {
                if (!name) return;
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                localModelAdvanced.appendChild(opt);
            });
            if (selected) localModelAdvanced.value = selected;
        } catch (e) {
            console.error('Failed to list installed models:', e);
        }
    };

    // Human line keyed off adopted/owned + the three health levels.
    const renderStatusLine = (s) => {
        if (!s || s.error) return `Status unavailable${s && s.error ? ': ' + s.error : ''}`;
        const ownership = s.adopted
            ? 'Using your running Ollama'
            : (s.owned ? 'Managed by OpenCluely' : 'Local engine');
        const server = s.serverUp ? 'server up' : 'server down';
        const present = s.modelPresent ? 'model present' : 'model missing';
        const responds = s.modelResponds ? 'responding' : 'not responding';
        return `${ownership} · ${server} · ${present} · ${responds}${s.model ? ' (' + s.model + ')' : ''}`;
    };

    const refreshModelStatus = async () => {
        if (!modelStatus || !window.electronAPI || !window.electronAPI.getModelStatus) return;
        try {
            const s = await window.electronAPI.getModelStatus();
            modelStatus.textContent = renderStatusLine(s);
        } catch (e) {
            modelStatus.textContent = 'Status unavailable: ' + (e.message || e);
        }
    };

    const appendModelLog = (line) => {
        if (!modelStatusLog) return;
        modelStatusLog.textContent += (modelStatusLog.textContent ? '\n' : '') + line;
        modelStatusLog.scrollTop = modelStatusLog.scrollHeight;
    };

    // Pull progress arrives structured as { status, percent, completed, total }.
    const formatPullProgress = (p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        const pct = (typeof p.percent === 'number') ? ` ${p.percent}%` : '';
        return `${p.status || 'downloading'}${pct}`;
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperSegmentMsInput,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    // Provider change → toggle local fields, persist, note restart-to-apply.
    if (llmProvider) {
        llmProvider.addEventListener('change', () => {
            updateLocalModelFieldStates();
            saveSettings();
            if (providerStatus) {
                providerStatus.textContent = `Provider set to "${llmProvider.value}". Applies on next launch.`;
            }
            refreshModelStatus();
        });
    }

    // Curated ↔ advanced model selection.
    if (localModel) {
        localModel.addEventListener('change', async () => {
            if (localModel.value === '__advanced__') {
                await populateAdvancedModels();
                if (localModelAdvanced) localModelAdvanced.style.display = '';
            } else if (localModelAdvanced) {
                localModelAdvanced.style.display = 'none';
            }
            saveSettings();
        });
    }
    if (localModelAdvanced) {
        localModelAdvanced.addEventListener('change', saveSettings);
    }

    // Test connection against the selected provider (03-04 bridge).
    if (testProviderBtn) {
        testProviderBtn.addEventListener('click', async () => {
            if (!providerStatus || !window.electronAPI || !window.electronAPI.testProviderConnection) return;
            providerStatus.textContent = 'Testing connection…';
            try {
                const r = await window.electronAPI.testProviderConnection();
                providerStatus.textContent = (r && r.success)
                    ? '✓ Connected'
                    : `✗ ${r && r.error ? r.error : 'Connection failed'}`;
            } catch (e) {
                providerStatus.textContent = `✗ ${e.message || e}`;
            }
        });
    }

    // Re-download / repair the local model, streaming pull progress to the log.
    if (repairModelBtn) {
        repairModelBtn.addEventListener('click', async () => {
            if (!window.electronAPI || !window.electronAPI.pullModel) return;
            repairModelBtn.disabled = true;
            appendModelLog('Starting model download / repair…');
            let unsubscribe = null;
            if (window.electronAPI.onModelPullProgress) {
                unsubscribe = window.electronAPI.onModelPullProgress((p) => {
                    appendModelLog(formatPullProgress(p));
                });
            }
            try {
                const r = await window.electronAPI.pullModel();
                appendModelLog(r && r.ok
                    ? '\n✓ Model ready'
                    : `\n✗ ${r && r.message ? r.message : 'Download failed'}`);
            } catch (e) {
                appendModelLog(`\n! Error: ${e.message || e}`);
            } finally {
                if (typeof unsubscribe === 'function') {
                    try { unsubscribe(); } catch (_) { /* ignore */ }
                }
                repairModelBtn.disabled = false;
                refreshModelStatus();
            }
        });
    }

    updateSpeechFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Light periodic refresh of local model health while settings is open.
    setInterval(refreshModelStatus, 8000);

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
