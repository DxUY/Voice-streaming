const App = {
    DEFAULTS: { threshold: 0.6, min_speech_duration_ms: 250, min_silence_duration_ms: 400 },
    state: {
        socket: null,
        history: [],
        waves: {},
        serverIp: window.location.hostname || "127.0.0.1",
        canvas: null,
        ctx: null,
        rollingBuffer: new Array(256).fill(0), 
        currentPage: 1,
        itemsPerPage: 10,
        isPolling: false,
        isRecording: false,
        vad: { threshold: 0.6, min_speech_duration_ms: 250, min_silence_duration_ms: 400 }
    },

    lastSignalTime: Date.now(),
    signalChecker: null,
    clickTimeout: null,

    async init() {
        this.state.canvas = document.getElementById('liveWaveformCanvas');
        this.state.ctx = this.state.canvas?.getContext('2d');
        
        if (this.state.canvas) {
            this.resizeCanvas();
            window.addEventListener('resize', () => this.resizeCanvas());
            this.startAnimationLoop();
        }

        const waveConfigs = {
            original: { container: '#originalWaveform', color: '#6c757d' },
            processed: { container: '#processedWaveform', color: '#198754' }
        };

        Object.entries(waveConfigs).forEach(([key, cfg]) => {
            const container = document.querySelector(cfg.container);
            if (!container) return;
            
            this.state.waves[key] = WaveSurfer.create({
                container: cfg.container,
                waveColor: cfg.color,
                progressColor: '#0d6efd',
                height: 100,
                barWidth: 2
            });
            
            this.state.waves[key].on('play', () => this.updateBtn(key, true));
            this.state.waves[key].on('pause', () => this.updateBtn(key, false));
            this.state.waves[key].on('finish', () => this.updateBtn(key, false));
        });

        const spectroIds = ['raw', 'clean', 'diff'];
        spectroIds.forEach(id => {
            const container = document.getElementById(`spectro-${id}`);
            if (!container) return;
            
            this.state.waves[`spec_${id}`] = WaveSurfer.create({
                container: container,
                height: 0,
                interact: false,
                plugins: [
                    WaveSurfer.Spectrogram.create({
                        labels: false, height: 200, fftSize: 2048,
                        colorMap: id === 'diff' ? this.getIceColorMap() : this.getHotColorMap()
                    })
                ]
            });
        });
        
        this.bindEvents();
        await this.fetchHistory();
        this.connect();
    },

    bindEvents() {
        document.addEventListener('click', e => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'show-dash') this.switchView('dashboard');
            if (action === 'show-hist') this.switchView('history');
            if (action === 'show-settings') this.showSettings();
            if (action === 'reset-settings') this.resetSettings();
            
            const playKey = e.target.closest('[data-play]')?.dataset.play;
            if (playKey) this.state.waves[playKey].playPause();
        });
        
        document.querySelectorAll('.vad-input').forEach(input => {
            input.oninput = (e) => {
                const labelMap = { 'threshold': 'val-threshold', 'min_speech_duration_ms': 'val-minSpeech', 'min_silence_duration_ms': 'val-minSilence' };
                const labelId = labelMap[e.target.dataset.key];
                if (document.getElementById(labelId)) {
                    document.getElementById(labelId).textContent = e.target.value;
                }
            };
        });
        
        const saveBtn = document.getElementById('saveSettingsBtn');
        if (saveBtn) saveBtn.onclick = () => this.saveSettings();
    },

    showToast(title, message, type = 'success') {
        const toastEl = document.getElementById('processingToast');
        if (!toastEl) return;

        toastEl.querySelector('strong').textContent = title;
        toastEl.querySelector('.toast-body').textContent = message;

        const header = toastEl.querySelector('.toast-header');
        const icon = header.querySelector('i');
        
        header.className = `toast-header text-white bg-${type}`;
        if (type === 'warning') {
            header.classList.remove('text-white');
            header.classList.add('text-dark');
            icon.className = 'fas fa-exclamation-triangle me-2';
        } else if (type === 'info') {
            icon.className = 'fas fa-cog fa-spin me-2';
        } else if (type === 'danger') {
            icon.className = 'fas fa-times-circle me-2';
        } else {
            icon.className = 'fas fa-check-circle me-2';
        }

        let toast = bootstrap.Toast.getOrCreateInstance(toastEl, {
            autohide: type !== 'info',
            delay: 5000
        });

        toast.show();
    },

    showSettings() {
        const modalEl = document.getElementById('settingsModal');
        if (!modalEl) return;
        const modal = new bootstrap.Modal(modalEl);
        
        if (document.getElementById('input-threshold')) document.getElementById('input-threshold').value = this.state.vad.threshold;
        if (document.getElementById('input-minSpeech')) document.getElementById('input-minSpeech').value = this.state.vad.min_speech_duration_ms;
        if (document.getElementById('input-minSilence')) document.getElementById('input-minSilence').value = this.state.vad.min_silence_duration_ms;
        modal.show();
    },

    resetSettings() {
        this.state.vad = { ...this.DEFAULTS };
        const map = { 'input-threshold': this.DEFAULTS.threshold, 'input-minSpeech': this.DEFAULTS.min_speech_duration_ms, 'input-minSilence': this.DEFAULTS.min_silence_duration_ms };
        Object.entries(map).forEach(([id, val]) => {
            const input = document.getElementById(id);
            if (input) {
                input.value = val;
                input.dispatchEvent(new Event('input'));
            }
        });
    },

    async saveSettings() {
        document.querySelectorAll('.vad-input').forEach(i => {
            const val = i.value;
            this.state.vad[i.dataset.key] = i.dataset.key === 'threshold' ? parseFloat(val) : parseInt(val);
        });
        
        const modalEl = document.getElementById('settingsModal');
        if (modalEl) bootstrap.Modal.getInstance(modalEl).hide();
    },

    getHotColorMap() {
        return Array.from({ length: 256 }, (_, i) => [i / 255, i / 128 > 1 ? 1 : i / 128, 1 - i / 255, 1]);
    },

    getIceColorMap() {
        return Array.from({ length: 256 }, (_, i) => [0, i / 255, i / 128 > 1 ? 1 : i / 128, 1]);
    },

    updateBtn(key, isPlaying) {
        const btn = document.getElementById(`btn-play-${key}`);
        if (!btn) return;
        btn.querySelector('i').className = `fas fa-${isPlaying ? 'pause' : 'play'} me-2`;
        btn.querySelector('span').textContent = isPlaying ? 'Pause' : 'Play';
    },

    async fetchHistory() {
        try {
            const res = await fetch(`http://${this.state.serverIp}:8000/logs`);
            const { status, data } = await res.json();
            if (status === "success") {
                this.state.history = data;
                this.renderHistory();
            }
        } catch (e) { console.error(e); }
    },

    connect() {
        this.state.socket = new WebSocket(`ws://${this.state.serverIp}:8000/ws`);
        this.state.socket.onopen = () => this.updateUIStatus("SERVER CONNECTED", "bg-success");

        this.state.socket.onmessage = (e) => {
            const data = JSON.parse(e.data);
            switch(data.type) {
                case "status":
                    if (data.value === "HARDWARE_ONLINE") {
                        this.updateUIStatus("HARDWARE READY", "bg-success");
                        this.lastSignalTime = Date.now();
                    }
                    break;
                case "recording_started":
                    this.updateUIStatus("RECORDING...", "bg-danger animate-pulse");
                    this.state.rollingBuffer.fill(0);
                    
                    if (this.clickTimeout) clearTimeout(this.clickTimeout);
                    this.clickTimeout = setTimeout(() => {
                        this.state.isRecording = true;
                    }, 400);
                    break;
                case "waveform":
                    data.samples.forEach(sample => {
                        this.state.rollingBuffer.push(sample);
                        this.state.rollingBuffer.shift(); 
                    });
                    this.updateSignalStatus("STABLE");
                    break;
                case "task_started":
                    if (this.clickTimeout) clearTimeout(this.clickTimeout);
                    this.state.isRecording = false; 
                    this.state.rollingBuffer.fill(0); 
                    this.showToast("Processing Audio", "AI is analyzing the signal...", "info");
                    this.pollStatus(data.task_id);
                    break;
            }
        };

        this.state.socket.onclose = () => {
            this.updateUIStatus("SERVER DISCONNECTED", "bg-danger");
            this.updateSignalStatus("OFFLINE");
            setTimeout(() => this.connect(), 2000);
        };
    },

    updateUIStatus(text, className) {
        const el = document.getElementById('connectionStatus');
        if (el) {
            el.className = `badge ${className}`;
            el.textContent = text;
        }
    },

    updateSignalStatus(status) {
        if (status === "STABLE") {
            this.lastSignalTime = Date.now();
            const el = document.getElementById('connectionStatus');
            if (el && !el.textContent.includes("STABLE") && !el.textContent.includes("RECORDING")) {
                this.updateUIStatus("LIVE: SIGNAL STABLE", "bg-success");
            }
        }

        if (!this.signalChecker) {
            this.signalChecker = setInterval(() => {
                if (Date.now() - this.lastSignalTime > 1500 && this.state.socket.readyState === 1) {
                    this.updateUIStatus("SIGNAL UNSTABLE (NO DATA)", "bg-warning text-dark");
                }
            }, 2000);
        }
    },

    async pollStatus(taskId) {
        if (this.state.isPolling) return;
        this.state.isPolling = true;

        const check = async () => {
            try {
                const res = await fetch(`http://${this.state.serverIp}:8000/status/${taskId}`);
                const data = await res.json();
                
                if (data.status === 'completed') {
                    this.state.isPolling = false;
                    
                    if (!data.result.files) {
                        this.showToast("Audio Discarded", "No speech detected in the recording.", "warning");
                        return; 
                    }

                    await this.fetchHistory();
                    
                    this.showToast("Processing Complete", "Audio has been enhanced successfully. Check History for details.", "success");

                } else if (data.status === 'failed') {
                    this.state.isPolling = false;
                    this.showToast("Processing Failed", "An error occurred during AI processing.", "danger");
                } else {
                    setTimeout(check, 1000);
                }
            } catch (e) { this.state.isPolling = false; }
        };
        check();
    },

    loadEntry(entry) {
        this.switchView('dashboard', true); 
        const elements = {
            dashboardHeader: 'none',
            liveMonitorSection: 'none',
            spectrogramSection: 'block',
            audioComparisonSection: 'block',
            resultsSection: 'block'
        };
        
        Object.entries(elements).forEach(([id, display]) => {
            const el = document.getElementById(id);
            if(el) el.style.display = display;
        });

        document.getElementById('transcriptionText').textContent = entry.transcribe || "No transcription available";
        document.getElementById('summarizationText').textContent = entry.summarization || "No summary available";

        const baseUrl = `http://${this.state.serverIp}:8000/download`;
        const getFileName = (path) => path?.split(/[\\/]/).pop() || "";
        
        const raw = getFileName(entry.files?.raw_audio);
        const clean = getFileName(entry.files?.processed_audio);

        if (raw) {
            this.state.waves.original.load(`${baseUrl}/raw/${raw}`);
            this.state.waves.spec_raw.load(`${baseUrl}/raw/${raw}`);
            this.state.waves.spec_diff.load(`${baseUrl}/raw/${raw}`); 
        }
        if (clean) {
            this.state.waves.processed.load(`${baseUrl}/clean/${clean}`);
            this.state.waves.spec_clean.load(`${baseUrl}/clean/${clean}`);
        }
    },

    switchView(view, skipReset = false) {
        const isDash = view === 'dashboard';
        const dashView = document.getElementById('dashboard-view');
        const histView = document.getElementById('history-view');
        
        if (dashView) dashView.style.display = isDash ? 'block' : 'none';
        if (histView) histView.style.display = isDash ? 'none' : 'block';
        
        const navDash = document.getElementById('nav-dash');
        const navHist = document.getElementById('nav-hist');
        
        if (navDash) navDash.classList.toggle('active', isDash);
        if (navHist) navHist.classList.toggle('active', !isDash);

        if (isDash && !skipReset) {
            ['dashboardHeader', 'liveMonitorSection'].forEach(id => {
                if (document.getElementById(id)) document.getElementById(id).style.display = 'block';
            });
            ['spectrogramSection', 'audioComparisonSection', 'resultsSection'].forEach(id => {
                if (document.getElementById(id)) document.getElementById(id).style.display = 'none';
            });
            Object.values(this.state.waves).forEach(w => w.stop());
        }
    },

    renderHistory() {
        const container = document.getElementById('historyContainer');
        if (!container) return;
        
        const items = this.state.history.slice((this.state.currentPage - 1) * this.state.itemsPerPage, this.state.currentPage * this.state.itemsPerPage);
        const grouped = items.reduce((acc, item) => {
            const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Archive';
            (acc[date] = acc[date] || []).push(item);
            return acc;
        }, {});

        container.innerHTML = Object.entries(grouped).map(([date, entries]) => `
            <h6 class="mt-4 mb-3 text-muted fw-bold text-uppercase" style="letter-spacing:1px">${date}</h6>
            ${entries.map(item => `
                <div class="card mb-2 border history-item" style="cursor:pointer" onclick='App.loadEntry(${JSON.stringify(item).replace(/'/g, "&apos;")})'>
                    <div class="card-body d-flex justify-content-between align-items-center py-2">
                        <div>
                            <i class="fas fa-file-audio text-primary me-3"></i>
                            <span class="fw-bold">Recording Archive</span>
                            <span class="mx-3 text-muted">|</span>
                            <span class="text-secondary small">${item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}</span>
                        </div>
                    </div>
                </div>`).join('')}
        `).join('') || '<p class="text-center py-5 text-muted">No recordings found.</p>';
        
        this.renderPagination();
    },

    renderPagination() {
        const el = document.getElementById('historyPagination');
        const pages = Math.ceil(this.state.history.length / this.state.itemsPerPage);
        if (!el || pages <= 1) return (el.innerHTML = '');

        el.innerHTML = Array.from({ length: pages }, (_, i) => `
            <li class="page-item ${i + 1 === this.state.currentPage ? 'active' : ''}">
                <a class="page-link shadow-none" href="#" onclick="App.setPage(${i + 1})">${i + 1}</a>
            </li>`).join('');
    },

    setPage(p) {
        this.state.currentPage = p;
        this.renderHistory();
        window.scrollTo(0, 0);
    },

    resizeCanvas() {
        if (!this.state.canvas) return;
        this.state.canvas.width = this.state.canvas.parentElement.clientWidth;
        this.state.canvas.height = 400;
    },

    startAnimationLoop() {
        const draw = () => {
            const monitorSection = document.getElementById('liveMonitorSection');
            if (monitorSection && monitorSection.style.display !== 'none') {
                const { ctx, canvas, rollingBuffer: samples, isRecording } = this.state;
                if (ctx && canvas) {
                    ctx.fillStyle = '#0f172a';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    
                    if (isRecording) {
                        ctx.strokeStyle = '#22c55e';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        
                        const step = canvas.width / (samples.length || 1);
                        samples.forEach((s, i) => {
                            const y = ((s / 32768) * canvas.height / 2) + (canvas.height / 2);
                            i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
                        });
                        ctx.stroke();
                    }
                }
            }
            requestAnimationFrame(draw);
        };
        draw();
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());