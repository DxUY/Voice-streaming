import asyncio
import json
import uuid
import wave
import time
import logging
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import librosa

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent

# CRITICAL FIX: Retain system routing lookups so sub-modules can bind sibling components
sys.path.append(str(BASE_DIR / "ClearSpeech"))
sys.path.append(str(BASE_DIR / "Summarization"))

from ClearSpeech.backend.inference_pipeline import EnhancementPipeline
from Summarization.summarization_pipeline import SummarizationPipeline
from db import save_audio_log, get_all_logs

UPLOAD_DIR = BASE_DIR / "recordings"
RAW_DIR, CLEAN_DIR, SPECS_DIR = UPLOAD_DIR / "raw", UPLOAD_DIR / "clean", BASE_DIR / "specs"
for d in [RAW_DIR, CLEAN_DIR, SPECS_DIR]: d.mkdir(parents=True, exist_ok=True)

# Load Silero VAD Model
vad_model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad', model='silero_vad', trust_repo=True)
(get_speech_timestamps, _, _, _, _) = utils

device = "cuda" if torch.cuda.is_available() else "cpu"
pipeline = EnhancementPipeline(
    cnn_checkpoint_path=str(BASE_DIR / "ClearSpeech/enhancement_model/checkpoints/best_model.pt"),
    whisper_model_name="base",
    device=device
)
summarization_pipeline = SummarizationPipeline()

class ExecutionTracker:
    def __init__(self, task_id):
        self.task_id = task_id
        self.start_time = time.time()
        self.metrics = {}
    def mark(self, stage: str):
        self.metrics[stage] = round(time.time() - self.start_time, 3)
        logger.info(f"Task {self.task_id} - Stage: {stage} at {self.metrics[stage]}s")

def save_spectrogram(audio_path, output_path, title):
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

# 💡 HIGH-PERFORMANCE WORKER: Reads directly from disk path to prevent 2-channel mutations
async def process_audio_ai(task_id, target_file_path):
    tracker = ExecutionTracker(task_id)
    clean_path = CLEAN_DIR / f"clean_{task_id}.wav"
    raw_path = Path(target_file_path)
    
    try:
        audio_np, sr = sf.read(str(raw_path), dtype='int16')
        audio_tensor = torch.from_numpy(audio_np.astype(np.float32) / 32768.0)
        
        speech_timestamps = get_speech_timestamps(
            audio_tensor, vad_model, threshold=0.6, sampling_rate=16000
        )
        
        if not speech_timestamps:
            manager.tasks[task_id] = {"status": "completed", "result": {"transcribe": "", "summarization": "Filtered as silence"}}
            return

        start_sample = speech_timestamps[0]['start']
        end_sample = speech_timestamps[-1]['end']
        trimmed_audio = audio_np[start_sample:end_sample]

        tracker.mark("pre_processing")
        
        with wave.open(str(raw_path), 'wb') as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
            wf.writeframes(trimmed_audio.tobytes())
        
        res = await asyncio.to_thread(pipeline.process, str(raw_path))
        tracker.mark("enhancement_and_transcription")
        
        sf.write(str(clean_path), res["enhanced_audio"], 16000)
        
        await asyncio.to_thread(generate_visuals, task_id, raw_path, clean_path)
        
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
    task_id = str(uuid.uuid4())
    path = RAW_DIR / f"raw_{task_id}.wav"
    
    file_bytes = await file.read()
    
    # 💡 ACCURATE STEREOMIXING: Runs entirely in a thread-pool worker to protect the loop
    def save_and_clean_audio_file():
        with open(path, "wb") as b: 
            b.write(file_bytes)
        
        data, sr = sf.read(str(path), dtype='int16')
        
        # High-Fidelity Energy Peak Dominance Downmixing (Prevents digital noise mutations & muddy cancellations)
        if len(data.shape) > 1:
            logger.info(f"Processing 2-channel audio safely ({data.shape[1]} channels). Normalizing matrix...")
            data = np.where(np.abs(data[:, 0]) > np.abs(data[:, 1]), data[:, 0], data[:, 1])
            sf.write(str(path), data, sr)
            
    await asyncio.to_thread(save_and_clean_audio_file)
    
    manager.tasks[task_id] = {"status": "processing"}
    # Pass path string instead of lists to stop socket-blocking serialization lag
    asyncio.create_task(process_audio_ai(task_id, str(path)))
    return {"status": "success", "task_id": task_id}

@app.get("/logs")
async def fetch_logs(): return {"status": "success", "data": await get_all_logs()}

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    manager.clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        logger.info("WebSocket connection closed normally by the client.")
    except Exception as e:
        logger.error(f"WebSocket error encountered: {e}")
    finally:
        manager.clients.discard(ws)

app.mount("/download/raw", StaticFiles(directory=str(RAW_DIR)), name="raw_audio")
app.mount("/download/clean", StaticFiles(directory=str(CLEAN_DIR)), name="clean_audio")
app.mount("/download/specs", StaticFiles(directory=str(SPECS_DIR)), name="specs")

async def udp_listener():
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 9000))
    sock.setblocking(False)
    
    while True:
        try:
            data, addr = await asyncio.get_event_loop().sock_recvfrom(sock, 4096)
            header = data[0]
            
            if header == 9: 
                logger.info("ESP32 Handshake Received: Hardware Online")
                await manager.broadcast({"type": "status", "value": "HARDWARE_ONLINE"})
            elif header == 1: # START
                manager.is_recording = True
                manager.current_buffer = [] 
            elif header == 0: # AUDIO DATA
                if manager.is_recording:
                    manager.current_buffer.extend(np.frombuffer(data[1:], dtype=np.int16))
            elif header == 2: # STOP
                manager.is_recording = False
                tid = str(uuid.uuid4())
                
                # Instantly unburden streaming arrays straight to disk before launching heavy inference jobs
                stream_path = RAW_DIR / f"raw_{tid}.wav"
                with wave.open(str(stream_path), 'wb') as wf:
                    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
                    wf.writeframes(np.array(manager.current_buffer, dtype=np.int16).tobytes())
                    
                asyncio.create_task(process_audio_ai(tid, str(stream_path)))
                await manager.broadcast({"type": "task_started", "task_id": tid})
        except (BlockingIOError, InterruptedError):
            await asyncio.sleep(0.05)
        except Exception as e:
            logger.error(f"Unexpected error in UDP stream listener: {e}")
            await asyncio.sleep(0.1)
            
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