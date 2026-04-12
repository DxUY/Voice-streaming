import asyncio, socket, json, uuid, wave, os, sys, torch
import numpy as np
import soundfile as sf
from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect
from contextlib import asynccontextmanager
from db import save_audio_log, get_all_logs

BASE_DIR = Path(__file__).resolve().parent
sys.path.append(str(BASE_DIR / "ClearSpeech"))
sys.path.append(str(BASE_DIR / "Summarization"))

from ClearSpeech.backend.inference_pipeline import EnhancementPipeline
from Summarization.summarization_pipeline import SummarizationPipeline

UPLOAD_DIR = BASE_DIR / "recordings"
RAW_DIR, CLEAN_DIR = UPLOAD_DIR / "raw", UPLOAD_DIR / "clean"
for d in [RAW_DIR, CLEAN_DIR]: d.mkdir(parents=True, exist_ok=True)

vad_model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad', model='silero_vad', trust_repo=True)
(get_speech_timestamps, _, _, _, _) = utils

pipeline = EnhancementPipeline(
    cnn_checkpoint_path=str(BASE_DIR/"ClearSpeech/enhancement_model/checkpoints/best_model.pt"),
    whisper_model_name="base",
    device="cuda" if torch.cuda.is_available() else "cpu"
)

summarization_pipeline = SummarizationPipeline()

class State:
    def __init__(self):
        self.clients = set()
        self.tasks = {}
        self.is_recording = False
        self.current_buffer = []
        self.server_ip = "0.0.0.0"

state = State()
app = FastAPI()

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/download/raw", StaticFiles(directory=str(RAW_DIR)), name="raw_audio")
app.mount("/download/clean", StaticFiles(directory=str(CLEAN_DIR)), name="clean_audio")

async def broadcast(data):
    for ws in list(state.clients):
        try: await ws.send_json(data)
        except: state.clients.discard(ws)

async def process_audio_ai(task_id, buffer_ints):
    raw_name, clean_name = f"raw_{task_id}.wav", f"clean_{task_id}.wav"
    raw_path, clean_path = RAW_DIR / raw_name, CLEAN_DIR / clean_name

    try:
        audio_np = np.array(buffer_ints, dtype=np.int16)
        audio_float = audio_np.astype(np.float32) / 32768.0
        audio_tensor = torch.from_numpy(audio_float)
        
        speech_timestamps = get_speech_timestamps(
            audio_tensor, 
            vad_model, 
            threshold=0.6, 
            sampling_rate=16000,
            min_speech_duration_ms=250,
            min_silence_duration_ms=400
        )
        
        if not speech_timestamps:
            state.tasks[task_id] = {"status": "completed", "result": {"transcribe": "", "summarization": "Filtered as silence"}}
            return

        start_sample = speech_timestamps[0]['start']
        end_sample = speech_timestamps[-1]['end']
        trimmed_audio = audio_np[start_sample:end_sample]

        with wave.open(str(raw_path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(trimmed_audio.tobytes())

        loop = asyncio.get_running_loop()
        
        res = await loop.run_in_executor(None, pipeline.process, str(raw_path))
        transcript = res.get("transcript", "")
        
        summary = ""
        if transcript.strip():
            summary = await loop.run_in_executor(None, summarization_pipeline.run, transcript)

        sf.write(str(clean_path), res["enhanced_audio"], res["sample_rate"])

        doc_id = await save_audio_log(raw_name, clean_name, transcript, summary)

        state.tasks[task_id] = {
            "status": "completed",
            "result": {
                "transcribe": transcript,
                "summarization": summary, 
                "files": {"raw_audio": raw_name, "processed_audio": clean_name},
                "_id": str(doc_id)
            }
        }
    except Exception as e:
        print(f"Error: {e}")
        state.tasks[task_id] = {"status": "failed"}

async def udp_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((state.server_ip, 9000))
    sock.setblocking(False)
    loop = asyncio.get_event_loop()
    
    while True:
        try:
            data, addr = await loop.sock_recvfrom(sock, 4096) 
            header, payload = data[0], data[1:]

            if header == 9:
                await broadcast({"type": "status", "value": "HARDWARE_ONLINE"})
            elif header == 1:
                state.is_recording, state.current_buffer = True, []
                await broadcast({"type": "recording_started"})
            elif header == 2 and state.is_recording:
                state.is_recording = False
                tid = str(uuid.uuid4())
                state.tasks[tid] = {"status": "processing"}
                asyncio.create_task(process_audio_ai(tid, list(state.current_buffer)))
                await broadcast({"type": "task_started", "task_id": tid})
            elif header == 0:
                samples = np.frombuffer(payload, dtype=np.int16).tolist()
                # Lightweight [::8] downsampling to keep UI from lagging
                await broadcast({"type": "waveform", "samples": samples[::8]})
                if state.is_recording: state.current_buffer.extend(samples)
        except BlockingIOError:
            await asyncio.sleep(0.001)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    state.clients.add(websocket)
    try:
        while True: await websocket.receive_text()
    except WebSocketDisconnect:
        state.clients.discard(websocket)

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    return state.tasks.get(task_id, {"status": "not_found"})

@app.get("/logs")
async def fetch_logs():
    return {"status": "success", "data": await get_all_logs()}

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(udp_listener())
    yield
    task.cancel()

app.router.lifespan_context = lifespan