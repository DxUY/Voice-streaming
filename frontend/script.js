const UI = {
    get: (id) => document.getElementById(id),
    toggle: (ids, show) => {
        ids.forEach(id => {
            const el = UI.get(id);
            if (el) el.style.display = show ? 'block' : 'none';
        });
    },
    toast: (title, message, type = 'success') => {
        const toastEl = UI.get('processingToast');
        if (!toastEl) return;
        toastEl.querySelector('strong').textContent = title;
        toastEl.querySelector('.toast-body').textContent = message;
        const header = toastEl.querySelector('.toast-header');
        header.className = `toast-header bg-${type} ${type === 'warning' ? 'text-dark' : 'text-white'}`;
        const icon = header.querySelector('i');
        const icons = { success: 'check-circle', warning: 'exclamation-triangle', info: 'cog fa-spin', danger: 'times-circle' };
        icon.className = `fas fa-${icons[type] || 'info-circle'} me-2`;
        bootstrap.Toast.getOrCreateInstance(toastEl, { autohide: type !== 'info', delay: 5000 }).show();
    }
};

const App = {
    state: {
        socket: null,
        history: [],
        waves: {},
        serverIp: window.location.hostname || "127.0.0.1",
        rollingBuffer: new Int16Array(1024).fill(0),
        isRecording: false,
        currentPage: 1,
        itemsPerPage: 10
    },
    lastSignalTime: Date.now(),

    async init() {
        this.cacheDOM();
        this.initCanvas();
        this.setupWaveSurfers();
        this.bindEvents();
        this.setupUploadListener();

        window.addEventListener('popstate', (event) => {
            const el = UI.get('settingsModal');
            const modal = bootstrap.Modal.getInstance(el);
            if (modal && el.classList.contains('show')) { modal.hide(); return; }
            const state = event.state || { view: 'dashboard', isReview: false };
            this.switchView(state.view, state.isReview, false);
        });

        await this.fetchHistory();
        this.connect();
    },

    cacheDOM() {
        this.dom = {
            canvas: UI.get('liveWaveformCanvas'),
            status: UI.get('connectionStatus'),
            history: UI.get('historyContainer'),
            monitor: UI.get('liveMonitorSection')
        };
    },

    showSettings() {
        const el = UI.get('settingsModal');
        if (el) {
            new bootstrap.Modal(el).show();
            window.history.pushState({ modal: 'settings' }, "");
        }
    },

    // Lưu setting mới lên server
    async saveSettings() {
        const settings = {
            speech_threshold: parseFloat(UI.get('speechThreshold').value),
            min_speech_duration_ms: parseInt(UI.get('minSpeechDuration').value),
            min_silence_duration_ms: parseInt(UI.get('minSilenceDuration').value)
        };
        await fetch(`http://${this.state.serverIp}:8000/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        UI.toast("Settings", "Configuration saved to server", "success");
    },

    setupUploadListener() {
        const input = document.getElementById('audioUploadInput');
        if (!input) return;
        input.addEventListener('change', (e) => {
            if (e.target.files.length > 0) this.uploadAudioFile(e.target.files[0]);
        });
    },

    async uploadAudioFile(file) {
        const formData = new FormData();
        formData.append('file', file);
        try {
            UI.toast("Uploading", "Sending file to server...", "info");
            const res = await fetch(`http://${this.state.serverIp}:8000/upload`, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.task_id) UI.toast("Processing", "File uploaded. AI analysis started...", "info");
        } catch (e) {
            UI.toast("Upload Failed", "Could not reach the server.", "danger");
        }
    },

    connect() {
        this.state.socket = new WebSocket(`ws://${this.state.serverIp}:8000/ws`);
        this.state.socket.binaryType = "arraybuffer";
        this.state.socket.onopen = () => this.updateStatusUI("SERVER CONNECTED", "bg-success");
        this.state.socket.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) return this.handleBinary(e.data);
            this.handleJson(JSON.parse(e.data));
        };
        this.state.socket.onclose = () => {
            this.updateStatusUI("SERVER DISCONNECTED", "bg-danger");
            setTimeout(() => this.connect(), 2000);
        };
    },

    handleBinary(data) {
        const header = new Uint8Array(data, 0, 1)[0];
        if (header === 0) {
            const samples = new Int16Array(data.slice(1));
            const buf = this.state.rollingBuffer;
            buf.set(buf.subarray(samples.length));
            buf.set(samples, buf.length - samples.length);
            this.lastSignalTime = Date.now();
        }
    },

    handleJson(data) {
        if (data.type === "task_completed") {
            UI.toast("Done", "Audio enhanced successfully.", "success");
            this.fetchHistory();
        }
    },

    updateStatusUI(text, className) {
        if (!this.dom.status) return;
        this.dom.status.textContent = text;
        this.dom.status.className = `badge ${className}`;
    },

    switchView(view, isReview = false, pushState = true) {
        if (pushState) window.history.pushState({ view, isReview }, "", `#${view}`);
        const isDash = view === 'dashboard';
        UI.toggle(['dashboard-view'], isDash);
        UI.toggle(['history-view'], !isDash);
        UI.toggle(['dashboardHeader', 'liveMonitorSection'], isDash && !isReview);
        UI.toggle(['spectrogramSection', 'audioComparisonSection', 'resultsSection'], isDash && isReview);
        UI.toggle(['uploadButtonContainer'], isDash && !isReview);
    },

    initCanvas() {
        if (!this.dom.canvas) return;
        this.ctx = this.dom.canvas.getContext('2d');
        const resize = () => {
            this.dom.canvas.width = this.dom.canvas.parentElement.clientWidth;
            this.dom.canvas.height = 400;
        };
        window.addEventListener('resize', resize); resize(); this.animate();
    },

    animate() {
        requestAnimationFrame(() => this.animate());
        if (!this.ctx || this.dom.monitor.style.display === 'none') return;
        const { width, height } = this.dom.canvas;
        this.ctx.fillStyle = '#0f172a';
        this.ctx.fillRect(0, 0, width, height);
        this.ctx.strokeStyle = '#475569';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        const step = width / this.state.rollingBuffer.length;
        for (let i = 0; i < this.state.rollingBuffer.length; i++) {
            const y = ((this.state.rollingBuffer[i] / 32768) * height / 2) + (height / 2);
            i === 0 ? this.ctx.moveTo(0, y) : this.ctx.lineTo(i * step, y);
        }
        this.ctx.stroke();
    },

    setupWaveSurfers() {
        this.state.waves = { original: null, processed: null };
    },

    refreshWaveSurfer(key, selector, color) {
        if (this.state.waves[key]) this.state.waves[key].destroy();
        this.state.waves[key] = WaveSurfer.create({ 
            container: selector, waveColor: color, progressColor: '#0d6efd', height: 100 
        });
    },

    // Hàm load entry cập nhật để dùng ảnh PNG thay vì plugin
    // --- Sửa hàm loadEntry trong script.js ---
    loadEntry(entry) {
        this.switchView('dashboard', true);
        
        // 1. Cập nhật Text
        UI.get('transcriptionText').textContent = entry.transcribe || "No text available";
        UI.get('summarizationText').textContent = entry.summarization || "No summary available";
        
        const base = `http://${this.state.serverIp}:8000`;
        
        // 2. Load Audio waveforms - Dùng đúng key từ DB: raw_audio và processed_audio
        this.refreshWaveSurfer('original', '#originalWaveform', '#6c757d');
        this.refreshWaveSurfer('processed', '#processedWaveform', '#198754');
        
        if (entry.files?.raw_audio) {
            this.state.waves.original.load(`${base}/download/raw/${entry.files.raw_audio}`);
        }
        if (entry.files?.processed_audio) {
            this.state.waves.processed.load(`${base}/download/clean/${entry.files.processed_audio}`);
        }
        
        // 3. Load Spectrogram Images
        // Dữ liệu từ DB có trường 'plots', dữ liệu từ socket có 'result.plots'
        const plots = entry.plots || entry.result?.plots;
        
        if (plots) {
            // Cập nhật đúng ID thẻ img trong index.html
            const rawImg = UI.get('spec-raw-img');
            const cleanImg = UI.get('spec-clean-img');
            const diffImg = UI.get('spec-diff-img');
            
            if (rawImg) rawImg.src = base + plots.raw;
            if (cleanImg) cleanImg.src = base + plots.clean;
            if (diffImg) diffImg.src = base + plots.diff;
        } else {
            console.warn("Không tìm thấy dữ liệu plots trong entry này");
        }
    },

    async fetchHistory() {
        try {
            const res = await fetch(`http://${this.state.serverIp}:8000/logs`);
            const { status, data } = await res.json();
            if (status === "success") { this.state.history = data; this.renderHistory(); }
        } catch (e) { console.error(e); }
    },

    renderHistory() {
        if (!this.dom.history) return;
        this.dom.history.innerHTML = this.state.history.map(item => `
            <div class="card mb-2 border history-item" style="cursor:pointer" onclick='App.loadEntry(${JSON.stringify(item).replace(/'/g, "&apos;")})'>
                <div class="card-body">Recording: ${new Date(item.timestamp).toLocaleString()}</div>
            </div>
        `).join('');
    },

    bindEvents() {
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const { action } = btn.dataset;
            if (action === 'save-settings') this.saveSettings();
            if (action === 'show-dash') this.switchView('dashboard', false);
            if (action === 'show-hist') this.switchView('history', false);
            if (action === 'show-settings') this.showSettings();
        });
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());