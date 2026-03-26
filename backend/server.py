import asyncio, socket, time, wave, sys, torch, uvicorn
import numpy as np
from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import soundfile as sf
from db import save_audio_log, get_all_logs

BASE_DIR = Path(__file__).resolve().parent
sys.path.append(str(BASE_DIR / "ClearSpeech"))
from ClearSpeech.backend.inference_pipeline import EnhancementPipeline

UDP_IP, UDP_PORT = "0.0.0.0", 9000
RAW_DIR = BASE_DIR / "data" / "audio_raw"
CLEAN_DIR = BASE_DIR / "data" / "audio_clean"
for d in [RAW_DIR, CLEAN_DIR]: d.mkdir(parents=True, exist_ok=True)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"])

pipeline = EnhancementPipeline(
    cnn_checkpoint_path=str(BASE_DIR/"ClearSpeech/enhancement_model/checkpoints/best_model.pt"),
    whisper_model_name="base",
    device="cuda" if torch.cuda.is_available() else "cpu"
)

state = {"recording": False, "buffer": bytearray(), "last_time": 0, "clients": set()}

async def broadcast(data):
    for ws in list(state["clients"]):
        try: await ws.send_json(data)
        except: state["clients"].discard(ws)

async def run_ai_processing(raw_path):
    loop = asyncio.get_running_loop()
    
    audio, sr = sf.read(str(raw_path))
    audio = audio.astype(np.float32)
    audio -= np.mean(audio)
    if np.max(np.abs(audio)) > 0:
        audio /= np.max(np.abs(audio))
    sf.write(str(raw_path), audio, sr)

    res = await loop.run_in_executor(None, pipeline.process, str(raw_path))
    clean_name = raw_path.name.replace("raw_", "clean_")
    clean_path = CLEAN_DIR / clean_name
    sf.write(str(clean_path), res["enhanced_audio"], res["sample_rate"])
    
    await save_audio_log(
            raw_path=raw_path, 
            clean_path=clean_path, 
            transcript=res["transcript"], 
            summary="Audio enhancement complete"
        )

    await broadcast({
        "type": "processing_complete", 
        "raw_file": raw_path.name, 
        "enhanced_file": clean_name, 
        "transcript": res["transcript"]
    })

async def udp_worker():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT))
    sock.setblocking(False)
    loop = asyncio.get_running_loop()
    while True:
        try:
            data, _ = await asyncio.wait_for(loop.sock_recvfrom(sock, 2048), 0.1)
            if not state["recording"]:
                state["recording"] = True
                state["buffer"] = bytearray()
                await broadcast({"type": "recording_started"})
            
            state["buffer"].extend(data)
            state["last_time"] = time.time()
            
            samples = np.frombuffer(data, dtype=np.int16).tolist()
            await broadcast({"type": "waveform", "samples": samples[::8]})
            
        except asyncio.TimeoutError:
            if state["recording"] and (time.time() - state["last_time"] > 1.5):
                path = RAW_DIR / f"raw_{int(time.time())}.wav"
                with wave.open(str(path), "wb") as f:
                    f.setnchannels(1)
                    f.setsampwidth(2)
                    f.setframerate(16000)
                    f.writeframes(state["buffer"])
                
                state["recording"] = False
                buf_to_process = state["buffer"]
                state["buffer"] = bytearray()
                asyncio.create_task(run_ai_processing(path))

@app.on_event("startup")
async def start():
    asyncio.create_task(udp_worker())

@app.get("/download/{folder}/{file}")
async def get_file(folder: str, file: str):
    return FileResponse((RAW_DIR if folder == "raw" else CLEAN_DIR) / file)

@app.get("/logs")
async def fetch_logs():
    logs = await get_all_logs()
    return {"status": "success", "data": logs}

@app.websocket("/ws")
async def ws_end(ws: WebSocket):
    await ws.accept()
    state["clients"].add(ws)
    try: 
        while True: await ws.receive_text()
    except: state["clients"].discard(ws)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)