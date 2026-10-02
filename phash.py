#!/usr/bin/env python3
"""VidiGagne v1.58 : hash perceptuel (aHash 64 bits) pour la recherche par image.
Usage: phash.py <fichier_image_ou_video>  -> affiche le hash hexadécimal (16 car.)
Pour une vidéo, extrait d'abord une frame à 1s avec ffmpeg.
"""
import subprocess
import sys
import os
import tempfile

def ahash(pil_img):
    img = pil_img.convert('L').resize((8, 8))
    px = list(img.getdata())
    avg = sum(px) / len(px)
    bits = ''.join('1' if p >= avg else '0' for p in px)
    return '%016x' % int(bits, 2)

def main():
    src = sys.argv[1]
    tmp = None
    try:
        # si c'est une vidéo, extrait une frame
        ext = os.path.splitext(src)[1].lower()
        if ext in ('.mp4', '.webm', '.mov', '.avi', '.mkv'):
            tmp = tempfile.mktemp(suffix='.jpg')
            r = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '1',
                                '-i', src, '-frames:v', '1', tmp],
                               timeout=60, capture_output=True)
            if r.returncode != 0 or not os.path.exists(tmp):
                print('')
                return
            src = tmp
        from PIL import Image
        print(ahash(Image.open(src)))
    except Exception:
        print('')
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)

if __name__ == '__main__':
    main()
