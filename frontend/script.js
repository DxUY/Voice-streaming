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
        isPolling: false,
        currentPage: 1,
        itemsPerPage: 10
    },
    lastSignalTime: Date.now(),
    async init() {
        this.cacheDOM();
        this.initCanvas();
        this.setupWaveSurfers();
        this.bindEvents();
        await this.fetchHistory();
        this.connect();
    },
    cacheDOM() {
        this.dom = {
            canvas: UI.get('liveWaveformCanvas'),
            status: UI.get('connectionStatus'),
            history: UI.get('historyContainer'),
            pagination: UI.get('historyPagination'),
            monitor: UI.get('liveMonitorSection')
        };
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
            if (!this.state.isRecording) {
                this.updateStatusUI("LIVE: SIGNAL STABLE", "bg-success");
            }
        }
    },
    handleJson(data) {
        switch (data.type) {
            case "status":
                if (data.value === "HARDWARE_ONLINE") this.updateStatusUI("HARDWARE READY", "bg-success");
                break;
            case "recording_started":
                this.state.isRecording = true;
                this.updateStatusUI("RECORDING...", "bg-danger animate-pulse");
                break;
            case "task_started":
                this.state.isRecording = false;
                this.state.rollingBuffer.fill(0);
                UI.toast("Processing", "AI analyzing audio...", "info");
                this.pollStatus(data.task_id);
                break;
        }
    },
    updateStatusUI(text, className) {
        if (!this.dom.status) return;
        this.dom.status.textContent = text;
        this.dom.status.className = `badge ${className}`;
    },
    switchView(view, isReview = false) {
        const isDash = view === 'dashboard';
        UI.toggle(['dashboard-view'], isDash);
        UI.toggle(['history-view'], !isDash);
        UI.get('nav-dash')?.classList.toggle('active', isDash);
        UI.get('nav-hist')?.classList.toggle('active', !isDash);
        UI.toggle(['dashboardHeader', 'liveMonitorSection'], isDash && !isReview);
        UI.toggle(['spectrogramSection', 'audioComparisonSection', 'resultsSection'], isDash && isReview);
        if (isDash && !isReview) Object.values(this.state.waves).forEach(w => w?.stop());
    },
    initCanvas() {
        if (!this.dom.canvas) return;
        this.ctx = this.dom.canvas.getContext('2d');
        const resize = () => {
            this.dom.canvas.width = this.dom.canvas.parentElement.clientWidth;
            this.dom.canvas.height = 400;
        };
        window.addEventListener('resize', resize);
        resize();
        this.animate();
    },
    animate() {
        requestAnimationFrame(() => this.animate());
        if (!this.ctx || this.dom.monitor.style.display === 'none') return;
        if (Date.now() - this.lastSignalTime > 400) {
            this.state.rollingBuffer.fill(0);
        }
        const { width, height } = this.dom.canvas;
        this.ctx.fillStyle = '#0f172a';
        this.ctx.fillRect(0, 0, width, height);
        this.ctx.strokeStyle = this.state.isRecording ? '#22c55e' : '#475569';
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
        const create = (id, color, opts = {}) => {
            const container = UI.get(id) || document.querySelector(id);
            if (!container) return null;
            return WaveSurfer.create({ container, waveColor: color, progressColor: '#0d6efd', height: 100, barWidth: 2, ...opts });
        };
        this.state.waves.original = create('#originalWaveform', '#6c757d');
        this.state.waves.processed = create('#processedWaveform', '#198754');
        ['raw', 'clean', 'diff'].forEach(id => {
            this.state.waves[`spec_${id}`] = create(`spectro-${id}`, null, {
                height: 0, interact: false,
                plugins: [WaveSurfer.Spectrogram.create({
                    labels: false, height: 200, fftSize: 2048,
                    colorMap: id === 'diff' ? this.getIceColorMap() : this.getHotColorMap()
                })]
            });
        });
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
    async pollStatus(taskId) {
        if (this.state.isPolling) return;
        this.state.isPolling = true;
        const check = async () => {
            try {
                const res = await fetch(`http://${this.state.serverIp}:8000/status/${taskId}`);
                const data = await res.json();
                if (data.status === 'completed') {
                    this.state.isPolling = false;
                    if (!data.result.files) return UI.toast("Discarded", "No speech detected.", "warning");
                    await this.fetchHistory();
                    UI.toast("Done", "Audio enhanced successfully.", "success");
                } else if (data.status === 'failed') {
                    this.state.isPolling = false;
                    UI.toast("Error", "Processing failed.", "danger");
                } else {
                    setTimeout(check, 1000);
                }
            } catch { this.state.isPolling = false; }
        };
        check();
    },
    renderHistory() {
        if (!this.dom.history) return;
        const { history, currentPage, itemsPerPage } = this.state;
        const start = (currentPage - 1) * itemsPerPage;
        const pagedItems = history.slice(start, start + itemsPerPage);
        const grouped = pagedItems.reduce((acc, item) => {
            const date = item.timestamp 
                ? new Date(item.timestamp).toLocaleDateString(undefined, { 
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
                }) : 'Archive';
            if (!acc[date]) acc[date] = [];
            acc[date].push(item);
            return acc;
        }, {});
        this.dom.history.innerHTML = Object.entries(grouped).map(([date, entries]) => `
            <h6 class="mt-4 mb-3 text-muted fw-bold text-uppercase" style="letter-spacing:1px">${date}</h6>
            ${entries.map(item => `
                <div class="card mb-2 border history-item" style="cursor:pointer" onclick='App.loadEntry(${JSON.stringify(item).replace(/'/g, "&apos;")})'>
                    <div class="card-body d-flex justify-content-between align-items-center py-2">
                        <div>
                            <i class="fas fa-file-audio text-primary me-3"></i>
                            <span class="fw-bold">Recording</span>
                            <span class="mx-3 text-muted">|</span>
                            <span class="text-secondary small">${item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}</span>
                        </div>
                        <i class="fas fa-chevron-right text-muted small"></i>
                    </div>
                </div>
            `).join('')}
        `).join('') || '<p class="text-center py-5 text-muted">No recordings found.</p>';
        this.renderPagination();
    },
    renderPagination() {
        const pages = Math.ceil(this.state.history.length / this.state.itemsPerPage);
        if (!this.dom.pagination || pages <= 1) return (this.dom.pagination.innerHTML = '');
        this.dom.pagination.innerHTML = Array.from({ length: pages }, (_, i) => `
            <li class="page-item ${i + 1 === this.state.currentPage ? 'active' : ''}">
                <a class="page-link shadow-none" href="#" onclick="App.setPage(${i + 1})">${i + 1}</a>
            </li>
        `).join('');
    },
    setPage(p) { 
        this.state.currentPage = p; 
        this.renderHistory(); 
    },
    loadEntry(entry) {
        this.switchView('dashboard', true);
        UI.get('transcriptionText').textContent = entry.transcribe || "No text found";
        UI.get('summarizationText').textContent = entry.summarization || "No summary found";
        const base = `http://${this.state.serverIp}:8000/download`;
        const raw = entry.files?.raw_audio;
        const clean = entry.files?.processed_audio;
        if (raw) {
            this.state.waves.original?.load(`${base}/raw/${raw}`);
            this.state.waves.spec_raw?.load(`${base}/raw/${raw}`);
            this.state.waves.spec_diff?.load(`${base}/raw/${raw}`);
        }
        if (clean) {
            this.state.waves.processed?.load(`${base}/clean/${clean}`);
            this.state.waves.spec_clean?.load(`${base}/clean/${clean}`);
        }
    },
    showSettings() {
        const el = UI.get('settingsModal');
        if (el) new bootstrap.Modal(el).show();
    },
    saveSettings() {
        const el = UI.get('settingsModal');
        if (el) bootstrap.Modal.getInstance(el)?.hide();
        UI.toast("Settings Saved", "System parameters updated.", "success");
    },
    bindEvents() {
        document.addEventListener('click', e => {
            const btn = e.target.closest('[data-action], [data-play]');
            if (!btn) return;
            const { action, play } = btn.dataset;
            if (play) return this.state.waves[play]?.playPause();
            switch(action) {
                case 'show-dash': this.switchView('dashboard'); break;
                case 'show-hist': this.switchView('history'); break;
                case 'show-settings': this.showSettings(); break;
                case 'save-settings': this.saveSettings(); break;
            }
        });
    },
    getHotColorMap: () => Array.from({ length: 256 }, (_, i) => [i / 255, Math.min(i / 128, 1), 1 - i / 255, 1]),
    getIceColorMap: () => Array.from({ length: 256 }, (_, i) => [0, i / 255, Math.min(i / 128, 1), 1])
};
document.addEventListener('DOMContentLoaded', () => App.init());