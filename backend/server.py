import asyncio
import socket
import time
import wave
import sys
import io
from collections import deque
from pathlib import Path
from typing import Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import torch
import soundfile as sf
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
CLEAR_SPEECH_ROOT = BASE_DIR / "ClearSpeech"

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))
if str(CLEAR_SPEECH_ROOT) not in sys.path:
    sys.path.insert(0, str(CLEAR_SPEECH_ROOT))

from ClearSpeech.backend.inference_pipeline import EnhancementPipeline

UDP_IP = "0.0.0.0"
UDP_PORT = 9000
API_HOST = "0.0.0.0"
API_PORT = 8000
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2
PACKET_SIZE = 4096
TIMEOUT_SECONDS = 1.5

RAW_DIR = BASE_DIR / "data" / "audio_raw"
CLEAN_DIR = BASE_DIR / "data" / "audio_clean"
CHECKPOINT = CLEAR_SPEECH_ROOT / "enhancement_model" / "checkpoints" / "best_model.pt"

RAW_DIR.mkdir(parents=True, exist_ok=True)
CLEAN_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Voice Streaming Backend",
    version="1.0.0",
    description="Receives UDP audio from hardware, streams waveform data to the frontend, and runs ClearSpeech."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = EnhancementPipeline(
    cnn_checkpoint_path=str(CHECKPOINT),
    whisper_model_name="base",
    device="cuda" if torch.cuda.is_available() else "cpu",
)

state: dict[str, Any] = {
    "recording": False,
    "last_packet_time": 0.0,
    "current_buffer": bytearray(),
    "latest_waveform": [],
    "last_raw_file": None,
    "last_enhanced_file": None,
    "last_transcript": "",
    "last_sample_rate": SAMPLE_RATE,
    "last_error": "",
    "packets_received": 0,
}

waveform_ring = deque(maxlen=SAMPLE_RATE * 2)
clients: set[WebSocket] = set()

def pcm16le_bytes_to_int16_list(data: bytes) -> list[int]:
    if len(data) < 2: return []
    usable = len(data) - (len(data) % 2)
    return [int.from_bytes(data[i:i + 2], byteorder="little", signed=True) for i in range(0, usable, 2)]

def downsample_waveform(samples: list[int], target_points: int = 256) -> list[int]:
    if not samples: return []
    if len(samples) <= target_points: return samples
    step = max(1, len(samples) // target_points)
    return [samples[i] for i in range(0, len(samples), step)][:target_points]

async def broadcast_json(message: dict[str, Any]) -> None:
    dead = []
    for ws in clients:
        try: await ws.send_json(message)
        except: dead.append(ws)
    for ws in dead: clients.discard(ws)

async def process_audio(raw_path: Path) -> None:
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, pipeline.process, str(raw_path))
        enhanced_path = CLEAN_DIR / raw_path.name.replace("raw_", "enhanced_")
        sf.write(str(enhanced_path), result["enhanced_audio"], result["sample_rate"])
        state.update({
            "last_raw_file": raw_path.name,
            "last_enhanced_file": enhanced_path.name,
            "last_transcript": result.get("transcript", ""),
            "last_sample_rate": result.get("sample_rate", SAMPLE_RATE),
            "last_error": ""
        })
        await broadcast_json({
            "type": "processing_complete",
            "raw_file": state["last_raw_file"],
            "enhanced_file": state["last_enhanced_file"],
            "transcript": state["last_transcript"],
            "sample_rate": state["last_sample_rate"],
        })
    except Exception as e:
        state["last_error"] = str(e)
        await broadcast_json({"type": "processing_error", "error": str(e)})

async def finalize_recording() -> None:
    if not state["current_buffer"]: return
    raw_path = RAW_DIR / f"raw_{int(time.time())}.wav"
    with wave.open(str(raw_path), "wb") as wf:
        wf.setnchannels(CHANNELS); wf.setsampwidth(SAMPLE_WIDTH); wf.setframerate(SAMPLE_RATE)
        wf.writeframes(state["current_buffer"])
    state["recording"] = False
    await broadcast_json({"type": "recording_stopped", "raw_file": raw_path.name})
    state["current_buffer"].clear()
    asyncio.create_task(process_audio(raw_path))

async def udp_listener() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT))
    sock.setblocking(False)
    loop = asyncio.get_running_loop()
    while True:
        try:
            data, addr = await asyncio.wait_for(loop.sock_recvfrom(sock, PACKET_SIZE), timeout=0.05)
            if not state["recording"]:
                state["recording"] = True
                await broadcast_json({"type": "recording_started", "from": f"{addr[0]}:{addr[1]}"})
            state["current_buffer"].extend(data)
            state["last_packet_time"] = time.time()
            state["packets_received"] += 1
            waveform_ring.extend(pcm16le_bytes_to_int16_list(data))
            state["latest_waveform"] = downsample_waveform(list(waveform_ring))
            await broadcast_json({"type": "waveform", "samples": state["latest_waveform"]})
        except asyncio.TimeoutError:
            if state["recording"] and (time.time() - state["last_packet_time"] > TIMEOUT_SECONDS):
                await finalize_recording()

@app.on_event("startup")
async def on_startup():
    if not CHECKPOINT.exists(): raise RuntimeError(f"Checkpoint not found: {CHECKPOINT}")
    asyncio.create_task(udp_listener())

@app.get("/download/raw/{filename}")
async def download_raw(filename: str):
    path = RAW_DIR / filename
    if not path.exists(): return JSONResponse(status_code=404, content={"error": "Not found"})
    return FileResponse(path, media_type="audio/wav")

@app.get("/download/enhanced/{filename}")
async def download_enhanced(filename: str):
    path = CLEAN_DIR / filename
    if not path.exists(): return JSONResponse(status_code=404, content={"error": "Not found"})
    return FileResponse(path, media_type="audio/wav")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        while True: await websocket.receive_text()
    except: clients.discard(websocket)

if __name__ == "__main__":
    uvicorn.run(app, host=API_HOST, port=API_PORT)