import asyncio
import socket
import json
import uuid
import wave
import sys
import torch
import time
import numpy as np
import soundfile as sf
import logging
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import librosa
import librosa.display
from pathlib import Path
from fastapi import FastAPI, WebSocket, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

# Setup Logs
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Paths ---
BASE_DIR = Path(__file__).resolve().parent
sys.path.append(str(BASE_DIR / "ClearSpeech"))
sys.path.append(str(BASE_DIR / "Summarization"))

from ClearSpeech.backend.inference_pipeline import EnhancementPipeline
from Summarization.summarization_pipeline import SummarizationPipeline
from db import save_audio_log, get_all_logs

UPLOAD_DIR = BASE_DIR / "recordings"
RAW_DIR, CLEAN_DIR, SPECS_DIR = UPLOAD_DIR / "raw", UPLOAD_DIR / "clean", BASE_DIR / "specs"
for d in [RAW_DIR, CLEAN_DIR, SPECS_DIR]: d.mkdir(parents=True, exist_ok=True)

# --- AI Models ---
device = "cuda" if torch.cuda.is_available() else "cpu"
pipeline = EnhancementPipeline(
    cnn_checkpoint_path=str(BASE_DIR/"ClearSpeech/enhancement_model/checkpoints/best_model.pt"),
    whisper_model_name="base",
    device=device
)
summarization_pipeline = SummarizationPipeline()

# --- Helpers ---
class ExecutionTracker:
    def __init__(self, task_id):
        self.task_id = task_id
        self.start_time = time.time()
        self.metrics = {}
    def mark(self, stage: str):
        self.metrics[stage] = round(time.time() - self.start_time, 3)
        logger.info(f"Task {self.task_id} - Stage: {stage} at {self.metrics[stage]}s")

def save_spectrogram(audio_path, output_path, title):
    logger.info(f"Đang vẽ spectrogram: {title}")
    try:
        y, sr = librosa.load(audio_path, sr=16000)
        S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128)
        S_dB = librosa.power_to_db(S, ref=np.max)
        
        fig = plt.figure(figsize=(10, 3)) 
        img = librosa.display.specshow(S_dB, sr=sr, x_axis='time', y_axis='mel')
        
        cbar = plt.colorbar(img)
        ticks = cbar.get_ticks()
        cbar.ax.set_yticklabels([f'{int(t):+d} dB' if i == len(ticks)-1 else f'{int(t):+d}' for i, t in enumerate(ticks)])
        
        plt.subplots_adjust(left=0, right=1, top=1, bottom=0)
        plt.savefig(output_path, dpi=100, bbox_inches='tight', pad_inches=0)
        plt.close(fig)
    except Exception as e:
        logger.error(f"LỖI vẽ spectrogram {title}: {e}")

def save_spectrogram_from_array(y, sr, output_path, title):
    try:
        S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128)
        S_dB = librosa.power_to_db(S, ref=np.max)
        fig = plt.figure(figsize=(10, 3))
        img = librosa.display.specshow(S_dB, sr=sr, x_axis='time', y_axis='mel')
        
        cbar = plt.colorbar(img)
        ticks = cbar.get_ticks()
        cbar.ax.set_yticklabels([f'{int(t)} dB' if i == len(ticks)-1 else f'{int(t)}' for i, t in enumerate(ticks)])
        
        plt.subplots_adjust(left=0, right=1, top=1, bottom=0)
        plt.savefig(output_path, dpi=100, bbox_inches='tight', pad_inches=0)
        plt.close(fig)
    except Exception as e:
        logger.error(f"LỖI vẽ spectrogram từ array {title}: {e}")

def generate_visuals(task_id, raw_path, clean_path):
    save_spectrogram(str(raw_path), str(SPECS_DIR / f"raw_{task_id}.png"), "Raw Spectrum")
    save_spectrogram(str(clean_path), str(SPECS_DIR / f"clean_{task_id}.png"), "Clean Spectrum")
    y_raw, _ = librosa.load(raw_path, sr=16000)
    y_clean, _ = librosa.load(clean_path, sr=16000)    
    min_len = min(len(y_raw), len(y_clean))
    diff = y_raw[:min_len] - y_clean[:min_len]
    save_spectrogram_from_array(diff, 16000, str(SPECS_DIR / f"diff_{task_id}.png"), "Noise Removed")

class AppStateManager:
    def __init__(self):
        self.clients = set()
        self.tasks = {}
        self.is_recording = False
        self.current_buffer = []
        self.settings = {"speech_threshold": 0.6, "min_speech_duration_ms": 250, "min_silence_duration_ms": 400}
    async def broadcast(self, data):
        for ws in list(self.clients):
            try: await ws.send_text(json.dumps(data))
            except: self.clients.discard(ws)

manager = AppStateManager()

async def process_audio_ai(task_id, buffer_list):
    tracker = ExecutionTracker(task_id)
    raw_path, clean_path = RAW_DIR / f"raw_{task_id}.wav", CLEAN_DIR / f"clean_{task_id}.wav"
    try:
        audio_np = np.array(buffer_list, dtype=np.int16)
        tracker.mark("pre_processing")
        with wave.open(str(raw_path), 'wb') as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(audio_np.tobytes())
        
        res = await asyncio.to_thread(pipeline.process, str(raw_path))
        tracker.mark("enhancement_and_transcription")
        sf.write(str(clean_path), res["enhanced_audio"], 16000)
        
        generate_visuals(task_id, raw_path, clean_path)
        
        summary = await asyncio.to_thread(summarization_pipeline.run, res["transcript"]) if res["transcript"] else ""
        tracker.mark("summarization_complete")
        
        plots = {
            "raw": f"/download/specs/raw_{task_id}.png",
            "clean": f"/download/specs/clean_{task_id}.png",
            "diff": f"/download/specs/diff_{task_id}.png"
        }
        
        doc_id = await save_audio_log(raw_path.name, clean_path.name, res["transcript"], summary, metrics=tracker.metrics, plots=plots)
        
        result = {
            "transcribe": res["transcript"], "summarization": summary,
            "plots": plots,
            "latency_metrics": tracker.metrics, "_id": str(doc_id)
        }
        manager.tasks[task_id] = {"status": "completed", "result": result}
        await manager.broadcast({"type": "task_completed", "task_id": task_id, "result": result})
    except Exception as e:
        logger.error(f"Task {task_id} failed: {e}", exc_info=True)
        manager.tasks[task_id] = {"status": "failed", "error": str(e)}

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    task_id = str(uuid.uuid4()); path = RAW_DIR / f"raw_{task_id}.wav"
    with open(path, "wb") as b: b.write(await file.read())
    data, _ = sf.read(str(path), dtype='int16')
    manager.tasks[task_id] = {"status": "processing"}
    asyncio.create_task(process_audio_ai(task_id, data.tolist()))
    return {"status": "success", "task_id": task_id}

@app.get("/logs")
async def fetch_logs(): return {"status": "success", "data": await get_all_logs()}

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept(); manager.clients.add(ws)
    try:
        while True: await ws.receive_text()
    finally: manager.clients.discard(ws)

app.mount("/download/raw", StaticFiles(directory=str(RAW_DIR)), name="raw_audio")
app.mount("/download/clean", StaticFiles(directory=str(CLEAN_DIR)), name="clean_audio")
app.mount("/download/specs", StaticFiles(directory=str(SPECS_DIR)), name="specs")

async def udp_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 9000)); sock.setblocking(False)
    while True:
        try:
            data, addr = await asyncio.get_event_loop().sock_recvfrom(sock, 4096)
            if data[0] == 2:
                manager.is_recording = False
                tid = str(uuid.uuid4())
                asyncio.create_task(process_audio_ai(tid, list(manager.current_buffer)))
        except: await asyncio.sleep(0.01)

@asynccontextmanager
async def lifespan(app: FastAPI):
    udp_task = asyncio.create_task(udp_listener())
    yield
    udp_task.cancel()
    try:
        await udp_task
    except asyncio.CancelledError:
        pass

app.router.lifespan_context = lifespan