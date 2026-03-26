import datetime
from motor.motor_asyncio import AsyncIOMotorClient

async def save_audio_log(raw_path, clean_path, transcript, summary=""):
    client = AsyncIOMotorClient("mongodb://localhost:27017/")
    db = client["AudioLog"]
    collection = db["log"]

    log_entry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc),
        "files": {
            "raw_audio": str(raw_path),
            "processed_audio": str(clean_path)
        },
        "transcribe": transcript,
        "summarization": summary,
        "version": 1.0
    }

    result = await collection.insert_one(log_entry)
    return result.inserted_id

async def get_all_logs():
    client = AsyncIOMotorClient("mongodb://localhost:27017/")
    db = client["AudioLog"]
    collection = db["log"]
    
    cursor = collection.find().sort("timestamp", -1)
    logs = await cursor.to_list(length=100)
    
    for log in logs:
        log["_id"] = str(log["_id"])
        
    return logs