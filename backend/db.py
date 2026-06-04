import datetime
from motor.motor_asyncio import AsyncIOMotorClient
import logging

# Cấu hình logging
logger = logging.getLogger(__name__)

MONGO_DETAILS = "mongodb://localhost:27017/"
DATABASE_NAME = "AudioLog"
COLLECTION_NAME = "log"

client = AsyncIOMotorClient(MONGO_DETAILS)
db = client[DATABASE_NAME]
collection = db[COLLECTION_NAME]

async def save_audio_log(raw_path, clean_path, transcript, summary="", metrics=None, plots=None, **kwargs):
    """
    Lưu log âm thanh vào MongoDB.
    
    Args:
        raw_path (str): Tên file gốc
        clean_path (str): Tên file đã xử lý
        transcript (str): Văn bản sau khi transcribe
        summary (str): Nội dung tóm tắt
        metrics (dict): Dữ liệu về độ trễ
        plots (dict): Đường dẫn tới các file ảnh spectrogram
        **kwargs: Các metadata bổ sung khác
    """
    log_entry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc),
        "files": {
            "raw_audio": str(raw_path),
            "processed_audio": str(clean_path)
        },
        "transcribe": transcript,
        "summarization": summary,
        "metrics": metrics or {},
        "plots": plots or {},  # Lưu đường dẫn ảnh tại đây
        "version": 1.1
    }

    # Nếu có thêm các metadata bất kỳ khác, gộp vào log_entry
    if kwargs:
        log_entry.update(kwargs)

    try:
        result = await collection.insert_one(log_entry)
        logger.info(f"Successfully saved to MongoDB. ID: {result.inserted_id}")
        return result.inserted_id
    except Exception as e:
        logger.error(f"Error saving to MongoDB: {e}")
        return None
    
async def get_all_logs():
    """
    Lấy danh sách tất cả các log, sắp xếp theo thời gian mới nhất.
    """
    try:
        cursor = collection.find().sort("timestamp", -1)
        logs = await cursor.to_list(length=100)
        
        for log in logs:
            log["_id"] = str(log["_id"])
            
        return logs
    except Exception as e:
        logger.error(f"Error fetching logs: {e}")
        return []