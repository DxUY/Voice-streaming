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
from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect
from contextlib import asynccontextmanager

BASE_DIR = Path(__file__).resolve().parent
sys.path.append(str(BASE_DIR / "ClearSpeech"))
sys.path.append(str(BASE_DIR / "Summarization"))

from ClearSpeech.backend.inference_pipeline import EnhancementPipeline
from Summarization.summarization_pipeline import SummarizationPipeline
from db import save_audio_log, get_all_logs

UPLOAD_DIR = BASE_DIR / "recordings"
RAW_DIR, CLEAN_DIR = UPLOAD_DIR / "raw", UPLOAD_DIR / "clean"
for d in [RAW_DIR, CLEAN_DIR]: d.mkdir(parents=True, exist_ok=True)

device = "cuda" if torch.cuda.is_available() else "cpu"
pipeline = EnhancementPipeline(
    cnn_checkpoint_path=str(BASE_DIR/"ClearSpeech/enhancement_model/checkpoints/best_model.pt"),
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

class AppStateManager:
    def __init__(self):
        self.clients = set()
        self.tasks = {}
        self.is_recording = False
        self.current_buffer = []
        self.last_viz_time = 0
        self.viz_interval = 0.03

    async def broadcast(self, data, is_binary=False):
        if not self.clients: return
        payload = data if is_binary else json.dumps(data)
        
        for ws in list(self.clients):
            try:
                if is_binary:
                    await ws.send_bytes(payload)
                else:
                    await ws.send_text(payload)
            except Exception:
                self.clients.discard(ws)

    def save_wav(self, path, data_np):
        with wave.open(str(path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(data_np.tobytes())

manager = AppStateManager()

async def process_audio_ai(task_id, buffer_list):
    tracker = ExecutionTracker(task_id)
    raw_name, clean_name = f"raw_{task_id}.wav", f"clean_{task_id}.wav"
    raw_path, clean_path = RAW_DIR / raw_name, CLEAN_DIR / clean_name
    
    try:
        audio_np = np.array(buffer_list, dtype=np.int16)
        tracker.mark("pre_processing")

        if len(audio_np) == 0:
            manager.tasks[task_id] = {"status": "completed", "result": {"transcribe": "", "summarization": "No Audio"}}
            return

        manager.save_wav(raw_path, audio_np)

        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, pipeline.process, str(raw_path))
        tracker.mark("enhancement_and_transcription")
        
        transcript = res.get("transcript", "").strip()
        summary = ""
        if transcript:
            summary = await loop.run_in_executor(None, summarization_pipeline.run, transcript)
        
        tracker.mark("summarization_complete")

        sf.write(str(clean_path), res["enhanced_audio"], 16000)
        
        result_payload = {
            "transcribe": transcript, 
            "summarization": summary, 
            "files": {"raw_audio": raw_name, "processed_audio": clean_name}, 
            "latency_metrics": tracker.metrics
        }
        
        doc_id = await save_audio_log(raw_name, clean_name, transcript, summary, metrics=tracker.metrics)
        result_payload["_id"] = str(doc_id)
        
        manager.tasks[task_id] = {"status": "completed", "result": result_payload}
        await manager.broadcast({"type": "task_completed", "task_id": task_id, "metrics": tracker.metrics})

    except Exception as e:
        print(f"Error processing task {task_id}: {e}")
        manager.tasks[task_id] = {"status": "failed"}

async def udp_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 9000))
    sock.setblocking(False)
    loop = asyncio.get_event_loop()
    
    print("UDP Listener active (VAD-lite mode) on port 9000")
    
    while True:
        try:
            data, addr = await loop.sock_recvfrom(sock, 4096)
            if not data: continue
            
            header = data[0]
            payload = data[1:]

            if header == 0: 
                if len(payload) % 2 != 0: payload = payload[:-1]
                samples = np.frombuffer(payload, dtype=np.int16)
                
                if manager.is_recording:
                    manager.current_buffer.extend(samples.tolist())
                
                now = time.time()
                if now - manager.last_viz_time > manager.viz_interval:
                    viz_payload = b'\x00' + samples[::16].tobytes()
                    await manager.broadcast(viz_payload, is_binary=True)
                    manager.last_viz_time = now

            elif header == 1: 
                manager.is_recording, manager.current_buffer = True, []
                await manager.broadcast({"type": "recording_started"})

            elif header == 2: 
                manager.is_recording = False
                tid = str(uuid.uuid4())
                manager.tasks[tid] = {"status": "processing"}
                asyncio.create_task(process_audio_ai(tid, list(manager.current_buffer)))
                await manager.broadcast({"type": "task_started", "task_id": tid})

            elif header == 9:  # HEARTBEAT
                await manager.broadcast({"type": "status", "value": "HARDWARE_ONLINE"})

        except BlockingIOError:
            await asyncio.sleep(0.001)
        except Exception as e:
            print(f"UDP Error: {e}")
            await asyncio.sleep(0.01)

@asynccontextmanager
async def lifespan(app: FastAPI):
    udp_task = asyncio.create_task(udp_listener())
    yield
    udp_task.cancel()
    try: await udp_task
    except asyncio.CancelledError: pass

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware, 
    allow_origins=["*"], 
    allow_methods=["*"], 
    allow_headers=["*"]
)

app.mount("/download/raw", StaticFiles(directory=str(RAW_DIR)), name="raw_audio")
app.mount("/download/clean", StaticFiles(directory=str(CLEAN_DIR)), name="clean_audio")

@app.get("/logs")
async def fetch_logs():
    return {"status": "success", "data": await get_all_logs()}

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    return manager.tasks.get(task_id, {"status": "not_found"})

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    manager.clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.clients.discard(ws)
    except Exception:
        manager.clients.discard(ws)