const App = {
    state: {
        socket: null,
        isStreaming: false,
        hasUnsaved: false,
        currentData: null,
        history: JSON.parse(localStorage.getItem('recordingHistory') || '[]'),
        wavesurfers: { original: null, processed: null },
        serverIp: window.location.hostname || "127.0.0.1",
        canvas: null,
        ctx: null
    },

    init() {
        this.state.canvas = document.getElementById('liveWaveformCanvas');
        if (this.state.canvas) {
            this.state.ctx = this.state.canvas.getContext('2d');
            this.resizeCanvas();
            window.addEventListener('resize', () => this.resizeCanvas());
        }

        this.initWavesurfer('original', '#originalWaveform', '#6c757d');
        this.initWavesurfer('processed', '#processedWaveform', '#28a745');

        this.connect(this.state.serverIp);
    },

    initWavesurfer(key, container, color) {
        if (!document.querySelector(container)) return;
        this.state.wavesurfers[key] = WaveSurfer.create({
            container,
            waveColor: color,
            progressColor: '#0d6efd',
            height: 80,
            barWidth: 2,
            cursorWidth: 1,
            hideScrollbar: true
        });
    },

    resizeCanvas() {
        const container = this.state.canvas.parentElement;
        this.state.canvas.width = container.clientWidth;
        this.state.canvas.height = 200;
        this.drawLiveWaveform([]);
    },

    connect(ip) {
        this.state.socket = new WebSocket(`ws://${ip}:8000/ws`);

        this.state.socket.onopen = () => {
            const status = document.getElementById('connectionStatus');
            status.className = "badge bg-success";
            status.textContent = "Live: Connected";
            this.notify("Connected to Backend", "success");
        };

        this.state.socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleServerMessage(data);
        };

        this.state.socket.onclose = () => {
            const status = document.getElementById('connectionStatus');
            status.className = "badge bg-danger";
            status.textContent = "Disconnected";
            setTimeout(() => this.connect(ip), 3000);
        };
    },

    handleServerMessage(data) {
        switch (data.type) {
            case "recording_started":
                this.state.isStreaming = true;
                this.resetUIForNewRecording();
                break;

            case "waveform":
                if (this.state.isStreaming) {
                    this.drawLiveWaveform(data.samples);
                }
                break;

            case "recording_stopped":
                this.state.isStreaming = false;
                this.notify("Processing Audio...", "info");
                break;

            case "processing_complete":
                this.handleProcessingComplete(data);
                break;

            case "processing_error":
                this.notify(data.error, "danger");
                break;
        }
    },

    drawLiveWaveform(samples) {
        const { ctx, canvas } = this.state;
        if (!ctx) return;

        ctx.fillStyle = 'rgb(0, 0, 0)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (!samples || samples.length === 0) return;

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0d6efd';
        ctx.beginPath();

        const sliceWidth = canvas.width / samples.length;
        let x = 0;

        for (let i = 0; i < samples.length; i++) {
            const v = samples[i] / 32768.0;
            const y = (v * canvas.height / 2) + (canvas.height / 2);

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);

            x += sliceWidth;
        }

        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
    },

    handleProcessingComplete(data) {
        this.state.currentData = {
            id: Date.now(),
            name: `Recording_${new Date().toLocaleTimeString().replace(/:/g, '-')}`,
            transcription: data.transcript,
            summary: "AI analysis of processed audio.",
            rawFile: data.raw_file,
            enhancedFile: data.enhanced_file
        };

        this.displayResults(this.state.currentData);
        this.state.hasUnsaved = true;
        this.notify("Analysis Complete", "success");

        const baseUrl = `http://${this.state.serverIp}:8000`;
        this.state.wavesurfers.original.load(`${baseUrl}/download/raw/${data.raw_file}`);
        this.state.wavesurfers.processed.load(`${baseUrl}/download/enhanced/${data.enhanced_file}`);
    },

    displayResults(data) {
        document.getElementById('fileNameSection').style.display = 'block';
        document.getElementById('audioComparisonSection').style.display = 'block';
        document.getElementById('resultsSection').style.display = 'block';
        
        document.getElementById('fileNameText').textContent = data.name;
        document.getElementById('transcriptionText').innerHTML = `<p>${data.transcription}</p>`;
        document.getElementById('summaryText').innerHTML = `<p>${data.summary}</p>`;
        document.getElementById('saveRecordingBtnInline').style.display = 'inline-block';
    },

    resetUIForNewRecording() {
        document.getElementById('audioComparisonSection').style.display = 'none';
        document.getElementById('resultsSection').style.display = 'none';
        document.getElementById('fileNameSection').style.display = 'none';
    },

    saveCurrent() {
        const name = prompt("Enter recording name:", this.state.currentData.name);
        if (!name) return;
        this.state.currentData.name = name;
        this.state.history.unshift({ ...this.state.currentData });
        localStorage.setItem('recordingHistory', JSON.stringify(this.state.history));
        this.state.hasUnsaved = false;
        this.notify("Saved to History", "success");
        document.getElementById('saveRecordingBtnInline').style.display = 'none';
    },

    renderHistory() {
        const container = document.getElementById('historyContainer');
        container.innerHTML = this.state.history.map(item => `
            <div class="card mb-2 shadow-sm" style="cursor:pointer" onclick="App.loadFromHistory(${item.id})">
                <div class="card-body d-flex justify-content-between align-items-center">
                    <div><strong>${item.name}</strong><br><small class="text-muted">${new Date(item.id).toLocaleString()}</small></div>
                    <button class="btn btn-sm btn-outline-danger" onclick="event.stopPropagation(); App.deleteItem(${item.id})"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `).join('') || '<div class="text-center text-muted py-5"><p>No recordings found.</p></div>';
    },

    loadFromHistory(id) {
        const item = this.state.history.find(h => h.id === id);
        if (item) {
            this.state.currentData = item;
            this.switchView('dashboard');
            this.displayResults(item);
            const baseUrl = `http://${this.state.serverIp}:8000`;
            this.state.wavesurfers.original.load(`${baseUrl}/download/raw/${item.rawFile}`);
            this.state.wavesurfers.processed.load(`${baseUrl}/download/enhanced/${item.enhancedFile}`);
            document.getElementById('saveRecordingBtnInline').style.display = 'none';
        }
    },

    deleteItem(id) {
        if (!confirm("Delete this recording?")) return;
        this.state.history = this.state.history.filter(h => h.id !== id);
        localStorage.setItem('recordingHistory', JSON.stringify(this.state.history));
        this.renderHistory();
    },

    switchView(view, event) {
        if (event) event.preventDefault();
        const isDash = view === 'dashboard';
        document.getElementById('dashboard-view').style.display = isDash ? 'block' : 'none';
        document.getElementById('history-view').style.display = isDash ? 'none' : 'block';
        document.getElementById('pageTitle').textContent = isDash ? 'Audio Dashboard' : 'Recording History';
        if (!isDash) this.renderHistory();
    },

    notify(msg, type) {
        const toast = document.createElement('div');
        toast.className = `toast show position-fixed bottom-0 end-0 m-3 align-items-center text-white bg-${type} border-0`;
        toast.style.zIndex = "1060";
        toast.innerHTML = `<div class="d-flex"><div class="toast-body">${msg}</div></div>`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
};

function showDashboard(e) { App.switchView('dashboard', e); }
function showHistory(e) { App.switchView('history', e); }
function toggleOriginalPlay() { App.state.wavesurfers.original.playPause(); }
function stopOriginalAudio() { App.state.wavesurfers.original.stop(); }
function toggleProcessedPlay() { App.state.wavesurfers.processed.playPause(); }
function stopProcessedAudio() { App.state.wavesurfers.processed.stop(); }
function showSaveRecordingDialog() { App.saveCurrent(); }

document.addEventListener('DOMContentLoaded', () => App.init());