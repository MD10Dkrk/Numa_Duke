# pip install fastapi uvicorn
import asyncio, json, random, time
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Body
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

app = FastAPI()
clients: set[WebSocket] = set()

# ------------------------
# Config / smoothing params
# ------------------------
EMA_ALPHA_BPM = 0.25      # higher -> more responsive
EMA_ALPHA_GSR = 0.25
BROADCAST_HZ  = 1.0       # messages per second
RANDOM_FALLBACK = True    # if no ingest arrives, synthesize gentle noise

# Normalization anchors (tune to your population)
# Map BPM around 60–110 -> [0..1]
BPM_MIN, BPM_MAX = 60.0, 110.0
# Map GSR (0.1 .. 0.8) -> [0..1] (device dependent!)
GSR_MIN, GSR_MAX = 0.10, 0.80

# State thresholds on the arousal score (0..1)
TH_CALM = 0.35
TH_CONCERNED = 0.60
# anything >= TH_CONCERNED -> "anxious"

# Confidence floors per state (so "calm" won’t be 0 anymore)
FLOOR_CALM = 0.58
FLOOR_CONC = 0.68
FLOOR_ANX  = 0.82
# how much to add based on distance from the nearest boundary
MARGIN_BOOST = 0.18

def _clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else (hi if v > hi else v)

# ------------------------
# Ingest / state
# ------------------------
class WearableIn(BaseModel):
    bpm: Optional[float] = None
    gsr: Optional[float] = None

latest_raw = {"bpm": None, "gsr": None, "ts": 0.0}
ema = {"bpm": None, "gsr": None}

@app.post("/ingest")
async def ingest(data: WearableIn):
    """Accept real wearable updates (POST JSON: {bpm, gsr})."""
    now = time.time()
    if data.bpm is not None:
        if ema["bpm"] is None:
            ema["bpm"] = float(data.bpm)
        else:
            ema["bpm"] = (1 - EMA_ALPHA_BPM) * ema["bpm"] + EMA_ALPHA_BPM * float(data.bpm)
        latest_raw["bpm"] = float(data.bpm)
    if data.gsr is not None:
        if ema["gsr"] is None:
            ema["gsr"] = float(data.gsr)
        else:
            ema["gsr"] = (1 - EMA_ALPHA_GSR) * ema["gsr"] + EMA_ALPHA_GSR * float(data.gsr)
        latest_raw["gsr"] = float(data.gsr)
    latest_raw["ts"] = now
    return {"ok": True, "ema": ema, "raw": latest_raw}

@app.get("/", response_class=PlainTextResponse)
async def health():
    return "mood_fusion ok"

# ------------------------
# Mood computation
# ------------------------
def _normalize(x, lo, hi):
    if x is None:
        return None
    if hi == lo:
        return 0.0
    return _clamp((x - lo) / (hi - lo))

def _maybe_randomize():
    """If nothing ingested recently, keep values alive with gentle noise."""
    if not RANDOM_FALLBACK:
        return
    now = time.time()
    stale = now - (latest_raw["ts"] or 0) > 3.0
    if stale:
        # simulate a slow drift
        rbpm = (ema["bpm"] if ema["bpm"] is not None else 78.0) + random.uniform(-1.0, 1.0)
        rgsr = (ema["gsr"] if ema["gsr"] is not None else 0.30) + random.uniform(-0.02, 0.02)
        # update EMA with the synthetic value (looks like idle breathing)
        ema["bpm"] = rbpm if ema["bpm"] is None else (0.98 * ema["bpm"] + 0.02 * rbpm)
        ema["gsr"] = rgsr if ema["gsr"] is None else (0.98 * ema["gsr"] + 0.02 * rgsr)

def _confidence_from_distance(score: float, state: str) -> float:
    """
    Confidence increases the farther we are from the nearest decision boundary.
    Always >= a floor per state.
    """
    if state == "calm":
        # distance to TH_CALM (below) and to TH_CONCERNED (above)
        dist = min(abs(score - TH_CALM), abs(TH_CONCERNED - score))
        return _clamp(FLOOR_CALM + MARGIN_BOOST * (dist / max(TH_CONCERNED - TH_CALM, 1e-6)))
    if state == "concerned":
        # distance to either boundary (TH_CALM or TH_CONCERNED)
        dist = min(abs(score - TH_CALM), abs(score - TH_CONCERNED))
        return _clamp(FLOOR_CONC + MARGIN_BOOST * (dist / max(TH_CONCERNED - TH_CALM, 1e-6)))
    # anxious: distance above TH_CONCERNED
    dist = abs(score - TH_CONCERNED)
    return _clamp(FLOOR_ANX + MARGIN_BOOST * dist)

def compute_mood():
    _maybe_randomize()

    nbpm = _normalize(ema["bpm"], BPM_MIN, BPM_MAX)
    ngsr = _normalize(ema["gsr"], GSR_MIN, GSR_MAX)

    # If still nothing, default to calm with mid confidence
    if nbpm is None and ngsr is None:
        return {
            "state": "calm",
            "confidence": 0.62,
            "bpm": None, "gsr": None,
            "ema_bpm": None, "ema_gsr": None,
            "score": 0.0, "ts": time.time()
        }

    # Weighted arousal: tweak weights for your use case
    w_bpm, w_gsr = 0.6, 0.4
    b = 0.0 if nbpm is None else nbpm
    g = 0.0 if ngsr is None else ngsr
    score = _clamp(w_bpm * b + w_gsr * g)

    if score < TH_CALM:
        state = "calm"
    elif score < TH_CONCERNED:
        state = "concerned"
    else:
        state = "anxious"

    conf = _confidence_from_distance(score, state)

    return {
        "state": state,
        "confidence": round(float(conf), 2),
        "bpm": latest_raw["bpm"],
        "gsr": latest_raw["gsr"],
        "ema_bpm": None if ema["bpm"] is None else round(float(ema["bpm"]), 2),
        "ema_gsr": None if ema["gsr"] is None else round(float(ema["gsr"]), 3),
        "score": round(float(score), 3),
        "ts": time.time()
    }

# ------------------------
# WS broadcaster
# ------------------------
@app.websocket("/mood")
async def mood(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await asyncio.sleep(30)  # keep alive; broadcaster sends updates
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)

async def broadcaster():
    period = 1.0 / BROADCAST_HZ
    while True:
        if clients:
            payload = json.dumps(compute_mood())
            dead = []
            for c in list(clients):
                try:
                    await c.send_text(payload)
                except Exception:
                    dead.append(c)
            for c in dead:
                clients.discard(c)
        await asyncio.sleep(period)

@app.on_event("startup")
async def _start():
    asyncio.create_task(broadcaster())

# run:
# uvicorn fusion_service:app --host 0.0.0.0 --port 8003
