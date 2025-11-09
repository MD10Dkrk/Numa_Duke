import asyncio, json, time
from typing import Dict
import numpy as np, librosa
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()

SR = 16000
WIN = 0.048
HOP = 0.024
WINDOW_SEC = 6.0
MIN_COMPUTE_SEC = 1.5
IDLE_PING_SEC = 25
RX_TIMEOUT_SEC = 60
EMIT_EVERY_SEC = 1.5

FRAME_SAMPLES = int(WIN * SR)
HOP_SAMPLES   = int(HOP * SR)
RING_SAMPLES  = int(WINDOW_SEC * SR)

def prosody_features(y: np.ndarray) -> Dict[str, float]:
  if y.size < max(256, FRAME_SAMPLES * 3):
    return {"f0_mean": 0.0, "f0_std": 0.0, "rms": float(np.mean(np.abs(y))) if y.size else 0.0, "zcr": 0.0}
  try:
    f0 = librosa.yin(y, fmin=70, fmax=350, sr=SR, frame_length=FRAME_SAMPLES, hop_length=HOP_SAMPLES)
  except Exception:
    f0 = np.zeros(1, dtype=np.float32)
  try:
    rms = librosa.feature.rms(y=y, frame_length=FRAME_SAMPLES, hop_length=HOP_SAMPLES)[0]
  except Exception:
    rms = np.array([np.mean(np.abs(y))], dtype=np.float32)
  try:
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=FRAME_SAMPLES, hop_length=HOP_SAMPLES)[0]
  except Exception:
    zcr = np.array([0.0], dtype=np.float32)
  voiced = f0[f0 > 0]
  f0_mean = float(np.nanmean(voiced)) if voiced.size else 0.0
  f0_std  = float(np.nanstd(voiced))  if voiced.size else 0.0
  return {
    "f0_mean": f0_mean,
    "f0_std":  f0_std,
    "rms":     float(np.mean(rms)) if rms.size else 0.0,
    "zcr":     float(np.mean(zcr)) if zcr.size else 0.0,
  }

@app.get("/")
def health():
  return {"ok": True, "service": "prosody", "sr": SR}

@app.websocket("/stream-prosody")
async def stream(ws: WebSocket):
  await ws.accept()
  pcm_ring = bytearray()
  last_emit = time.time()
  last_rx   = time.time()

  while True:
    try:
      try:
        msg = await asyncio.wait_for(ws.receive(), timeout=RX_TIMEOUT_SEC)
      except asyncio.TimeoutError:
        await ws.send_text('{"type":"keepalive"}')
        continue

      if msg["type"] == "websocket.disconnect":
        break

      txt = msg.get("text")
      if txt is not None:
        try: await ws.send_text('{"type":"pong"}')
        except Exception: pass
        continue

      data = msg.get("bytes")
      if data is None:
        continue
      last_rx = time.time()

      if not data:
        continue
      if (len(data) & 1) == 1:
        data = data[:-1]  # enforce int16 alignment

      pcm_ring.extend(data)
      max_bytes = RING_SAMPLES * 2
      if len(pcm_ring) > max_bytes:
        del pcm_ring[:-max_bytes]

      have_samples = len(pcm_ring) // 2
      now = time.time()
      if have_samples >= int(SR * MIN_COMPUTE_SEC) and (now - last_emit) >= EMIT_EVERY_SEC:
        try:
          y16 = np.frombuffer(pcm_ring, dtype=np.int16)
          y = (y16.astype(np.float32) / 32768.0)
          feats = prosody_features(y)
        except Exception:
          feats = {"f0_mean": 0.0, "f0_std": 0.0, "rms": 0.0, "zcr": 0.0}
        feats["ts"]   = now
        feats["type"] = "prosody"
        try: await ws.send_text(json.dumps(feats))
        except Exception: pass
        last_emit = now

      if (time.time() - last_rx) > IDLE_PING_SEC:
        try: await ws.send_text('{"type":"keepalive"}')
        except Exception: pass
        last_rx = time.time()

    except WebSocketDisconnect:
      break
    except Exception:
      try: await ws.send_text('{"type":"warn","why":"internal"}')
      except Exception: pass
      await asyncio.sleep(0.05)
