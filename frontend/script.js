const App = {
    state: {
        socket: null,
        history: JSON.parse(localStorage.getItem('audio_logs') || '[]'),
        waves: {},
        serverIp: window.location.hostname || "127.0.0.1",
        canvas: null,
        ctx: null,
        currentSamples: [],
        currentPage: 1,
        itemsPerPage: 10
    },

    init() {
        this.state.canvas = document.getElementById('liveWaveformCanvas');
        this.state.ctx = this.state.canvas?.getContext('2d');
        if (this.state.canvas) {
            this.resizeCanvas();
            window.addEventListener('resize', () => this.resizeCanvas());
            this.startAnimationLoop();
        }

        ['original', 'processed'].forEach(key => {
            this.state.waves[key] = WaveSurfer.create({
                container: `#${key}Waveform`,
                waveColor: key === 'original' ? '#6c757d' : '#198754',
                progressColor: '#0d6efd',
                height: 100,
                barWidth: 2
            });
            this.state.waves[key].on('play', () => this.updateBtn(key, true));
            this.state.waves[key].on('pause', () => this.updateBtn(key, false));
            this.state.waves[key].on('finish', () => this.updateBtn(key, false));
        });

        this.connect();
    },

    updateBtn(key, isPlaying) {
        const btn = document.getElementById(`btn-play-${key}`);
        if (!btn) return;
        btn.querySelector('i').className = isPlaying ? 'fas fa-pause me-2' : 'fas fa-play me-2';
        btn.querySelector('span').textContent = isPlaying ? 'Pause' : 'Play';
    },

    connect() {
        this.state.socket = new WebSocket(`ws://${this.state.serverIp}:8000/ws`);
        this.state.socket.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === "waveform") this.state.currentSamples = data.samples;
            if (data.type === "processing_complete") this.handleNewData(data);
        };
    },

    handleNewData(data) {
        const entry = {
            id: Date.now(),
            date: new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            transcript: data.transcript,
            summary: data.summary || "Summary generated based on signal analysis.",
            raw_file: data.raw_file,
            enhanced_file: data.enhanced_file
        };
        this.state.history.unshift(entry);
        localStorage.setItem('audio_logs', JSON.stringify(this.state.history));
        this.loadEntry(entry);
    },

    loadEntry(entry) {
        // Switch view immediately to avoid the "flash"
        this.switchView('dashboard', true); 
        
        document.getElementById('dashboardHeader').style.display = 'none';
        document.getElementById('liveMonitorSection').style.display = 'none';
        document.getElementById('audioComparisonSection').style.display = 'block';
        document.getElementById('resultsSection').style.display = 'block';

        document.getElementById('transcriptionText').textContent = entry.transcript;
        document.getElementById('summarizationText').textContent = entry.summary;

        bootstrap.Tab.getOrCreateInstance(document.getElementById('trans-tab')).show();

        const baseUrl = `http://${this.state.serverIp}:8000/download`;
        this.state.waves.original.load(`${baseUrl}/raw/${entry.raw_file}`);
        this.state.waves.processed.load(`${baseUrl}/clean/${entry.enhanced_file}`);
    },

    switchView(view, skipReset = false) {
        const isDash = view === 'dashboard';
        document.getElementById('dashboard-view').style.display = isDash ? 'block' : 'none';
        document.getElementById('history-view').style.display = isDash ? 'none' : 'block';
        
        document.getElementById('nav-dash').classList.toggle('active', isDash);
        document.getElementById('nav-hist').classList.toggle('active', !isDash);

        if (isDash && !skipReset) {
            document.getElementById('dashboardHeader').style.display = 'block';
            document.getElementById('liveMonitorSection').style.display = 'block';
            document.getElementById('audioComparisonSection').style.display = 'none';
            document.getElementById('resultsSection').style.display = 'none';
            this.state.waves.original.stop();
            this.state.waves.processed.stop();
        } else if (!isDash) {
            this.renderHistory();
        }
    },

    renderHistory() {
        const container = document.getElementById('historyContainer');
        const pagination = document.getElementById('historyPagination');
        
        const start = (this.state.currentPage - 1) * this.state.itemsPerPage;
        const pagedItems = this.state.history.slice(start, start + this.state.itemsPerPage);

        const grouped = pagedItems.reduce((acc, item) => {
            if (!acc[item.date]) acc[item.date] = [];
            acc[item.date].push(item);
            return acc;
        }, {});

        let html = '';
        for (const [date, items] of Object.entries(grouped)) {
            html += `<h6 class="mt-4 mb-3 text-muted fw-bold text-uppercase" style="letter-spacing:1px">${date}</h6>`;
            items.forEach(item => {
                html += `
                    <div class="card mb-2 border history-item" onclick='App.loadEntry(${JSON.stringify(item)})'>
                        <div class="card-body d-flex justify-content-between align-items-center py-2">
                            <div>
                                <i class="fas fa-file-audio text-primary me-3"></i>
                                <span class="fw-bold">Recording Archive</span>
                                <span class="mx-3 text-muted">|</span>
                                <span class="text-secondary small">${item.time}</span>
                            </div>
                            <button class="btn btn-sm text-danger" onclick="event.stopPropagation(); App.deleteItem(${item.id})">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>`;
            });
        }

        container.innerHTML = html || '<p class="text-center py-5 text-muted">No recordings found.</p>';
        this.renderPagination();
    },

    renderPagination() {
        const pagination = document.getElementById('historyPagination');
        const totalPages = Math.ceil(this.state.history.length / this.state.itemsPerPage);
        if (totalPages <= 1) { pagination.innerHTML = ''; return; }

        let html = '';
        for (let i = 1; i <= totalPages; i++) {
            html += `<li class="page-item ${i === this.state.currentPage ? 'active' : ''}">
                <a class="page-link shadow-none" href="#" onclick="App.setPage(${i})">${i}</a>
            </li>`;
        }
        pagination.innerHTML = html;
    },

    setPage(p) {
        this.state.currentPage = p;
        this.renderHistory();
        window.scrollTo(0, 0);
    },

    deleteItem(id) {
        this.state.history = this.state.history.filter(h => h.id !== id);
        localStorage.setItem('audio_logs', JSON.stringify(this.state.history));
        this.renderHistory();
    },

    resizeCanvas() {
        if (!this.state.canvas) return;
        this.state.canvas.width = this.state.canvas.parentElement.clientWidth;
        this.state.canvas.height = 400;
    },

    startAnimationLoop() {
        const draw = () => {
            if (document.getElementById('liveMonitorSection').style.display !== 'none') {
                const { ctx, canvas, currentSamples: samples } = this.state;
                if (ctx && canvas) {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.strokeStyle = '#00ff00';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    let x = 0;
                    const step = canvas.width / (samples.length || 1);
                    samples.forEach((s, i) => {
                        const y = ((s / 32768) * canvas.height / 2) + (canvas.height / 2);
                        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                        x += step;
                    });
                    ctx.stroke();
                }
            }
            requestAnimationFrame(draw);
        };
        draw();
    }
};

const showDashboard = (e) => { e.preventDefault(); App.switchView('dashboard'); };
const showHistory = (e) => { e.preventDefault(); App.switchView('history'); };
const showSettings = (e) => { e.preventDefault(); alert('Settings page is under construction.'); };
const toggleOriginalPlay = () => App.state.waves.original.playPause();
const toggleProcessedPlay = () => App.state.waves.processed.playPause();

document.addEventListener('DOMContentLoaded', () => App.init());