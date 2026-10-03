#!/usr/bin/env python3
"""Transcription vocale français -> mots horodatés (Vosk, 100% hors ligne).
Usage: python3 transcribe.py <fichier_audio_ou_video>
Sortie JSON: {"words": [{"word": "...", "start": 0.0, "end": 0.5}, ...]}
"""
import json, os, subprocess, sys, tempfile

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vosk-model-fr')

def extract_wav(src):
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', src,
                    '-ac', '1', '-ar', '16000', '-f', 'wav', tmp.name],
                   timeout=300, check=True)
    return tmp.name

def main():
    src = sys.argv[1]
    try:
        from vosk import Model, KaldiRecognizer
    except ImportError:
        print(json.dumps({"error": "vosk non installé"}))
        return
    if not os.path.isdir(MODEL_DIR):
        print(json.dumps({"error": "modèle FR absent"}))
        return
    wav = extract_wav(src)
    try:
        import wave
        wf = wave.open(wav, 'rb')
        model = Model(MODEL_DIR)
        rec = KaldiRecognizer(model, wf.getframerate())
        rec.SetWords(True)
        words = []
        while True:
            data = wf.readframes(4000)
            if not data:
                break
            if rec.AcceptWaveform(data):
                r = json.loads(rec.Result())
                words.extend(r.get('result', []))
        r = json.loads(rec.FinalResult())
        words.extend(r.get('result', []))
        wf.close()
        out = [{"word": w["word"], "start": round(w["start"], 2), "end": round(w["end"], 2)}
               for w in words]
        print(json.dumps({"words": out}))
    finally:
        try: os.unlink(wav)
        except: pass

if __name__ == '__main__':
    main()
