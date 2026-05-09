import datetime
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_DETAILS = "mongodb://localhost:27017/"
DATABASE_NAME = "AudioLog"
COLLECTION_NAME = "log"

client = AsyncIOMotorClient(MONGO_DETAILS)
db = client[DATABASE_NAME]
collection = db[COLLECTION_NAME]

# Updated save_audio_log in db.py
async def save_audio_log(raw_path, clean_path, transcript, summary="", metrics=None, **kwargs):
    log_entry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc),
        "files": {
            "raw_audio": str(raw_path),
            "processed_audio": str(clean_path)
        },
        "transcribe": transcript,
        "summarization": summary,
        "metrics": metrics or {},  # Store the latency data here
        "version": 1.1            # Bumped version for new schema
    }

    # If you ever pass other random arguments, they'll be caught in kwargs
    if kwargs:
        log_entry["metadata"] = kwargs

    try:
        result = await collection.insert_one(log_entry)
        print(f"Successfully saved to MongoDB. ID: {result.inserted_id}")
        return result.inserted_id
    except Exception as e:
        print(f"Error saving to MongoDB: {e}")
        return None
    
async def get_all_logs():
    try:
        cursor = collection.find().sort("timestamp", -1)
        logs = await cursor.to_list(length=100)
        
        for log in logs:
            log["_id"] = str(log["_id"])
            
        return logs
    except Exception as e:
        print(f"Error fetching logs: {e}")
        return []