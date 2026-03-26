import os
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime
import glob

EVENTS_LEVEL_NUM = 38
DEFAULT_LOG_BACKUP_COUNT = 10
DEFAULT_MAX_BYTES = 1 * 1024 * 1024  # 1MB


logger = None

def namer(default_name):
    base_dir = os.path.dirname(default_name)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S_%f")
    return os.path.join(base_dir, f"events_{timestamp}.log")

def cleanup_logs(log_dir, max_files=DEFAULT_LOG_BACKUP_COUNT):
    files = sorted(glob.glob(os.path.join(log_dir, "events_*.log")))
    if len(files) > max_files:
        for f in files[:-max_files]:
            os.remove(f)
            print(f"Removed log file: {f}")

def rotator(source, dest):
    print(f"Rotating log file: {source} to {dest}")
    os.rename(source, dest)
    cleanup_logs(os.path.dirname(dest), max_files=DEFAULT_LOG_BACKUP_COUNT)

def get_logger(full_path="logs"):
    global logger
    if logger is not None:
        return logger

    os.makedirs(full_path, exist_ok=True)

    logger = logging.getLogger(__name__)
    logger.setLevel(logging.INFO)

    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    log_file_path = os.path.join(full_path, "events.log")

    file_handler = RotatingFileHandler(
        log_file_path,
        maxBytes=DEFAULT_MAX_BYTES,
        encoding="utf-8",
        backupCount=DEFAULT_LOG_BACKUP_COUNT,
    )

    file_handler.namer = namer
    file_handler.rotator = rotator
    file_handler.setFormatter(formatter)

    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    logger.info(f"Logger initialized at {full_path}")

    return logger