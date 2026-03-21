import os
import hashlib
import time
import asyncio
from typing import Optional
from alignet.utils.logging import get_logger
logger = get_logger()

import_telegram = False
try:
    from telegram import Bot
    import_telegram = True
except Exception as e:
    logger.error(f"Error importing telegram: {e}")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHANNEL_ID = os.getenv("TELEGRAM_CHANNEL_ID")

# Track sent errors to avoid duplicates (error_hash -> timestamp)
_sent_errors: dict[str, float] = {}
# Time window to consider errors as duplicates (in seconds, default 5 minutes)
_ERROR_DEDUP_WINDOW = 300


def _get_error_hash(error_message: str, context: str = "") -> str:
    """Generate a hash for an error message to track duplicates."""
    combined = f"{context}:{error_message}"
    return hashlib.md5(combined.encode()).hexdigest()


def _should_send_error(error_message: str, context: str = "") -> bool:
    """Check if an error should be sent (not a duplicate within time window)."""
    try:
        if "Temporary failure in name resolution" in error_message:
            return False
        error_hash = _get_error_hash(error_message, context)
        current_time = time.time()
        
        # Check if we've sent this error recently
        if error_hash in _sent_errors:
            time_since_sent = current_time - _sent_errors[error_hash]
            if time_since_sent < _ERROR_DEDUP_WINDOW:
                logger.debug(f"Skipping duplicate error notification (sent {time_since_sent:.0f}s ago)")
                return False
        
        # Mark as sent
        _sent_errors[error_hash] = current_time
        
        # Clean up old entries (older than 2x the dedup window) if dict is getting large
        if len(_sent_errors) > 1000:
            cutoff_time = current_time - (_ERROR_DEDUP_WINDOW * 2)
            # Remove old entries
            old_hashes = [
                h for h, t in _sent_errors.items()
                if t < cutoff_time
            ]
            for h in old_hashes:
                del _sent_errors[h]
    
    except Exception as e:
        logger.error(f"Error checking if error should be sent: {e}")
        return True
    return True


async def send_to_telegram_channel(message: str, hotkey: str = ""):
    """Send a message to Telegram channel."""
    if not import_telegram:
        logger.error("Telegram bot not imported, skipping message send")
        return
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHANNEL_ID:
        logger.error("Telegram bot token or channel id not set, skipping message send")
        return
    try:
        bot = Bot(token=TELEGRAM_BOT_TOKEN)
        await bot.send_message(chat_id=TELEGRAM_CHANNEL_ID, text=message, parse_mode="HTML")
        logger.info(f"Message sent to telegram channel successfully")
    except Exception as e:
        logger.error(f"Error sending message to telegram channel: {e}")


async def send_error_to_telegram(
    error_message: str,
    hotkey: str = "",
    context: str = "",
    additional_info: Optional[str] = None
):
    """
    Send error notification to Telegram channel, avoiding duplicates.
    
    Args:
        error_message: The error message to send
        hotkey: Validator hotkey (optional)
        context: Context/component where error occurred (e.g., "Validator", "Sandbox", "API")
        additional_info: Additional information to include in the message
    """
    # Check if we should send (avoid duplicates)
    if not _should_send_error(error_message, context):
        return
    
    # Build the message
    parts = []
    if context:
        parts.append(f"<b>Context:</b> {context}")
    if hotkey:
        parts.append(f"<b>Hotkey:</b> {hotkey}")
    parts.append(f"<b>Error:</b> {error_message}")
    if additional_info:
        parts.append(f"<b>Details:</b> {additional_info}")
    
    message = "\n".join(parts)
    
    try:
        await send_to_telegram_channel(message, hotkey=hotkey)
        logger.debug(f"Error notification sent to Telegram: {context} for hotkey: {hotkey}")
    except Exception as e:
        logger.error(f"Failed to send error notification to Telegram: {e}")


def send_error_safe(
    error_message: str,
    hotkey: str = "",
    context: str = "",
    additional_info: Optional[str] = None
):
    """
    Send error notification to Telegram channel safely from both sync and async contexts.
    This function handles the complexity of calling async send_error_to_telegram from
    either a sync or async context.
    
    Args:
        error_message: The error message to send
        hotkey: Validator hotkey (optional)
        context: Context/component where error occurred (e.g., "Validator", "Sandbox", "API")
        additional_info: Additional information to include in the message
    """
    try:
        # Try to get running event loop (async context)
        loop = asyncio.get_running_loop()
        # If we're in async context, create a task
        asyncio.create_task(send_error_to_telegram(
            error_message=error_message,
            hotkey=hotkey,
            context=context,
            additional_info=additional_info
        ))
    except RuntimeError:
        # No running loop (sync context), create new event loop
        try:
            asyncio.run(send_error_to_telegram(
                error_message=error_message,
                hotkey=hotkey,
                context=context,
                additional_info=additional_info
            ))
        except Exception as e:
            # Silently fail if telegram sending fails
            logger.error(f"Error sending error to Telegram: {e} in sync context")
            pass
    except Exception as e:
        # Silently fail if telegram sending fails
        logger.error(f"Error sending error to Telegram: {e} in async context")
        pass
