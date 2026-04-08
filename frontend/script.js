const App = {
    DEFAULTS: { threshold: 0.6, min_speech_duration_ms: 250, min_silence_duration_ms: 400 },
    state: {
        serverIp: window.location.hostname || "127.0.0.1",
        history: [],
        waves: {},
        currentSamples: new Int16Array(0),
        currentPage: 1,
        itemsPerPage: 10,
        isPolling: false,
        lastSignalTime: Date.now(),
        vad: { threshold: 0.6, min_speech_duration_ms: 250, min_silence_duration_ms: 400 }
    },

    async init() {
        this.cacheDOM();
        this.initWavesurfer();
        this.bindEvents();
        this.startAnimationLoop();
        await this.fetchHistory();
        this.connect();
    },

    cacheDOM() {
        this.dom = {
            canvas: document.getElementById('liveWaveformCanvas'),
            ctx: document.getElementById('liveWaveformCanvas')?.getContext('2d'),
            connStatus: document.getElementById('connectionStatus'),
            historyCont: document.getElementById('historyContainer'),
            pagination: document.getElementById('historyPagination'),
            dashView: document.getElementById('dashboard-view'),
            histView: document.getElementById('history-view'),
            navDash: document.getElementById('nav-dash'),
            navHist: document.getElementById('nav-hist'),
            liveSection: document.getElementById('liveMonitorSection')
        };
        this.resizeCanvas();
    },

    initWavesurfer() {
        const createWS = (container, color, extra = {}) => WaveSurfer.create({
            container, waveColor: color, progressColor: '#0d6efd', height: 100, barWidth: 2, ...extra
        });
        
        this.state.waves.original = createWS('#originalWaveform', '#6c757d');
        this.state.waves.processed = createWS('#processedWaveform', '#198754');
        
        ['original', 'processed'].forEach(k => {
            this.state.waves[k].on('play', () => this.updatePlayBtn(k, true));
            this.state.waves[k].on('pause', () => this.updatePlayBtn(k, false));
            this.state.waves[k].on('finish', () => this.updatePlayBtn(k, false));
        });
        
        ['raw', 'clean', 'diff'].forEach(id => {
            this.state.waves[`spec_${id}`] = WaveSurfer.create({
                container: `#spectro-${id}`, height: 0, interact: false,
                plugins: [WaveSurfer.Spectrogram.create({
                    labels: false, height: 200, fftSize: 2048,
                    colorMap: id === 'diff' ? this.getColMap('ice') : this.getColMap('hot')
                })]
            });
        });
    },

    bindEvents() {
        window.addEventListener('resize', () => this.resizeCanvas());
        
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
                document.getElementById(labelMap[e.target.dataset.key]).textContent = e.target.value;
            };
        });
        
        document.getElementById('saveSettingsBtn').onclick = () => this.saveSettings();
    },

    connect() {
        const socket = new WebSocket(`ws://${this.state.serverIp}:8000/ws`);
        socket.binaryType = "arraybuffer";
        
        socket.onopen = () => this.updateStatus("SERVER CONNECTED", "bg-success");
        
        socket.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                // Handle binary audio waveform
                this.state.currentSamples = new Int16Array(e.data);
                this.state.lastSignalTime = Date.now();
                if (!this.dom.connStatus.textContent.match(/RECORDING|READY/)) {
                    this.updateStatus("LIVE: STABLE", "bg-success");
                }
                return;
            }
            const data = JSON.parse(e.data);
            if (data.type === "status" && data.value === "HARDWARE_ONLINE") {
                 this.updateStatus("HARDWARE READY", "bg-success");
                 this.state.lastSignalTime = Date.now();
            }
            if (data.type === "recording_started") this.updateStatus("RECORDING...", "bg-danger animate-pulse");
            if (data.type === "task_started") this.pollStatus(data.task_id);
        };

        setInterval(() => {
            if (Date.now() - this.state.lastSignalTime > 3000 && socket.readyState === 1) {
                this.updateStatus("SIGNAL UNSTABLE", "bg-warning text-dark");
            }
        }, 2000);
    },

    async fetchHistory() {
        try {
            const res = await fetch(`http://${this.state.serverIp}:8000/logs`);
            const json = await res.json();
            if (json.status === "success") { 
                this.state.history = json.data; 
                this.renderHistory(); 
            }
        } catch (e) { console.error(e); }
    },

    renderHistory() {
        const start = (this.state.currentPage - 1) * this.state.itemsPerPage;
        const items = this.state.history.slice(start, start + this.state.itemsPerPage);
        const fragment = document.createDocumentFragment();
        let lastDate = "";

        if (items.length === 0) {
            this.dom.historyCont.innerHTML = '<p class="text-center py-5 text-muted">No recordings found.</p>';
            this.dom.pagination.innerHTML = "";
            return;
        }

        items.forEach(item => {
            const d = new Date(item.timestamp);
            const dateStr = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            
            if (dateStr !== lastDate) {
                const h6 = document.createElement('h6');
                h6.className = "mt-4 mb-3 text-muted fw-bold text-uppercase";
                h6.style.letterSpacing = "1px";
                h6.textContent = dateStr;
                fragment.appendChild(h6);
                lastDate = dateStr;
            }
            
            const div = document.createElement('div');
            div.className = "card mb-2 border history-item";
            div.style.cursor = "pointer";
            
            div.innerHTML = `
                <div class="card-body d-flex justify-content-start align-items-center py-2 text-start">
                    <i class="fas fa-file-audio text-primary me-3"></i>
                    <span class="fw-bold">Recording Archive</span>
                    <span class="mx-3 text-muted">|</span>
                    <span class="text-secondary small">${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                </div>`;
                
            div.onclick = () => this.loadEntry(item);
            fragment.appendChild(div);
        });
        
        this.dom.historyCont.innerHTML = "";
        this.dom.historyCont.appendChild(fragment);
        this.renderPagination();
    },

    resetSettings() {
        this.state.vad = { ...this.DEFAULTS };
        const map = { 'input-threshold': this.DEFAULTS.threshold, 'input-minSpeech': this.DEFAULTS.min_speech_duration_ms, 'input-minSilence': this.DEFAULTS.min_silence_duration_ms };
        Object.entries(map).forEach(([id, val]) => {
            const input = document.getElementById(id);
            input.value = val;
            input.dispatchEvent(new Event('input'));
        });
    },

    renderPagination() {
        const pages = Math.ceil(this.state.history.length / this.state.itemsPerPage);
        
        if (pages <= 1) {
            this.dom.pagination.innerHTML = "";
            return;
        }

        this.dom.pagination.innerHTML = Array.from({ length: pages }, (_, i) => {
            const pageNum = i + 1;
            const isActive = pageNum === this.state.currentPage;
            
            return `
                <li class="page-item ${isActive ? 'active' : ''}">
                    <a class="page-link shadow-none" 
                    href="#" 
                    ${isActive ? 'aria-current="page"' : ''} 
                    onclick="App.setPage(event, ${pageNum})">
                    ${pageNum}
                    </a>
                </li>`;
        }).join('');
    },

    loadEntry(entry) {
        this.switchView('dashboard', true);
        const ids = { 'dashboardHeader':'none', 'liveMonitorSection':'none', 'spectrogramSection':'block', 'audioComparisonSection':'block', 'resultsSection':'block' };
        Object.entries(ids).forEach(([id, disp]) => document.getElementById(id).style.display = disp);
        
        document.getElementById('transcriptionText').textContent = entry.transcribe || "---";
        document.getElementById('summarizationText').textContent = entry.summary || "---";
        
        const dl = `http://${this.state.serverIp}:8000/download`;
        const raw = entry.files?.raw_audio?.split(/[\\/]/).pop();
        const clean = entry.files?.processed_audio?.split(/[\\/]/).pop();
        
        if (raw) { 
            this.state.waves.original.load(`${dl}/raw/${raw}`); 
            this.state.waves.spec_raw.load(`${dl}/raw/${raw}`); 
            this.state.waves.spec_diff.load(`${dl}/raw/${raw}`); 
        }
        if (clean) { 
            this.state.waves.processed.load(`${dl}/clean/${clean}`); 
            this.state.waves.spec_clean.load(`${dl}/clean/${clean}`); 
        }
    },

    switchView(view, skipReset = false) {
        const isDash = view === 'dashboard';
        this.dom.dashView.style.display = isDash ? 'block' : 'none';
        this.dom.histView.style.display = isDash ? 'none' : 'block';
        this.dom.navDash.classList.toggle('active', isDash);
        this.dom.navHist.classList.toggle('active', !isDash);
        
        if (isDash && !skipReset) {
            ['dashboardHeader', 'liveMonitorSection'].forEach(id => document.getElementById(id).style.display = 'block');
            ['spectrogramSection', 'audioComparisonSection', 'resultsSection'].forEach(id => document.getElementById(id).style.display = 'none');
            Object.values(this.state.waves).forEach(w => w.stop());
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
                    await this.fetchHistory(); 
                    this.loadEntry(data.result); 
                    this.showToast("Processing Complete", "Audio has been successfully analyzed and transcribed.");
                } 
                else setTimeout(check, 1000);
            } catch (e) { this.state.isPolling = false; }
        };
        check();
    },

    startAnimationLoop() {
        const draw = () => {
            if (this.dom.liveSection.style.display !== 'none' && this.state.currentSamples.length) {
                const { ctx, canvas } = this.dom;
                ctx.fillStyle = '#0f172a';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.strokeStyle = '#22c55e';
                ctx.lineWidth = 2;
                ctx.beginPath();
                
                const step = canvas.width / this.state.currentSamples.length;
                for (let i = 0; i < this.state.currentSamples.length; i++) {
                    const s = this.state.currentSamples[i];
                    const y = ((s / 32768) * (canvas.height / 2)) + (canvas.height / 2);
                    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * step, y);
                }
                ctx.stroke();
            }
            requestAnimationFrame(draw);
        };
        draw();
    },

    showSettings() {
        const modal = new bootstrap.Modal('#settingsModal');
        document.getElementById('input-threshold').value = this.state.vad.threshold;
        document.getElementById('input-minSpeech').value = this.state.vad.min_speech_duration_ms;
        document.getElementById('input-minSilence').value = this.state.vad.min_silence_duration_ms;
        modal.show();
    },

    async saveSettings() {
        document.querySelectorAll('.vad-input').forEach(i => {
            const val = i.value;
            this.state.vad[i.dataset.key] = i.dataset.key === 'threshold' ? parseFloat(val) : parseInt(val);
        });
        
        await fetch(`http://${this.state.serverIp}:8000/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.state.vad)
        });
        
        bootstrap.Modal.getInstance(document.getElementById('settingsModal')).hide();
    },

    updateStatus(t, c) { this.dom.connStatus.textContent = t; this.dom.connStatus.className = `badge ${c}`; },
    
    updatePlayBtn(k, p) {
        const btn = document.getElementById(`btn-play-${k}`);
        btn.querySelector('i').className = `fas fa-${p ? 'pause' : 'play'} me-2`;
        btn.querySelector('span').textContent = p ? 'Pause' : (k==='original'?'Play Raw':'Play Enhanced');
    },

    showToast(title, message, type = 'success') {
        const toastEl = document.getElementById('processingToast');
        if (!toastEl) return;

        toastEl.querySelector('strong').textContent = title;
        toastEl.querySelector('.toast-body').textContent = message;
      
        const header = toastEl.querySelector('.toast-header');
        header.className = `toast-header text-white ${type === 'success' ? 'bg-success' : 'bg-danger'}`;

        const toast = new bootstrap.Toast(toastEl, { delay: 5000 });
        toast.show();
    },
    
    setPage(e, p) { e.preventDefault(); this.state.currentPage = p; this.renderHistory(); window.scrollTo(0,0); },
    resizeCanvas() { if (this.dom.canvas) { this.dom.canvas.width = this.dom.canvas.parentElement.clientWidth; this.dom.canvas.height = 400; } },
    
    getColMap(type) {
        return Array.from({ length: 256 }, (_, i) => type === 'hot' ? [i / 255, i / 128 > 1 ? 1 : i / 128, 1 - i / 255, 1] : [0, i / 255, i / 128 > 1 ? 1 : i / 128, 1]);
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());