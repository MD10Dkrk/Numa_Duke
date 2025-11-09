from fastapi import FastAPI
import time, random

app = FastAPI()

@app.get("/")
def health():
    return {"ok": True, "service": "wearable_mock"}

@app.get("/wearable")
def wearable(patient_id: str = "p01"):
    """
    Simple mock:
    - Baseline HR ~ 70–80 bpm
    - Every ~90s, create a 'spike' (HR up, HRV down) to mimic anxiety.
    """
    now = int(time.time())
    # spike every ~90 seconds (roughly)
    spike = ((now // 30) % 3) == 0

    base_hr  = 74 + random.randint(-4, 4)
    base_hrv = 52 + random.randint(-6, 6)

    hr  = base_hr  + (random.randint(18, 32) if spike else 0)
    hrv = base_hrv - (random.randint(12, 20) if spike else 0)

    return {
        "patient_id": patient_id,
        "hr_bpm": hr,
        "hrv_rmssd": hrv,
        "spike": spike,
        "ts": now
    }
