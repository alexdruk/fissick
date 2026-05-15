#!/usr/bin/env python3
# scripts/make-ico.py
# Generates assets/icon.ico from assets/icon.iconset PNGs.
# Run with: python3 scripts/make-ico.py
# No dependencies — uses only stdlib.

import struct
import zlib
import os

def make_png(size, r, g, b):
    """Minimal valid PNG at given size with flat colour."""
    def chunk(name, data):
        crc = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', crc)
    raw = b''
    for _ in range(size):
        raw += b'\x00' + bytes([r, g, b] * size)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))

def read_png(path):
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    return None

# ICO sizes Windows cares about
SIZES = [16, 24, 32, 48, 64, 128, 256]

images = []
for s in SIZES:
    png_path = os.path.join('assets', 'icon.iconset', f'icon_{s}x{s}.png')
    data = read_png(png_path)
    if data is None:
        # Generate on the fly if the PNG doesn't exist at this exact size
        data = make_png(s, 184, 92, 44)
    images.append((s, data))

# ICO format:
#   6-byte header
#   16-byte directory entry per image
#   image data concatenated
header = struct.pack('<HHH', 0, 1, len(images))  # reserved, type=1 (ICO), count

offset = 6 + len(images) * 16
entries = b''
for size, data in images:
    w = size if size < 256 else 0   # 256 is stored as 0 in ICO format
    h = w
    entries += struct.pack('<BBBBHHII',
        w, h,    # width, height (0 = 256)
        0,       # colour count (0 = no palette)
        0,       # reserved
        1,       # colour planes
        32,      # bits per pixel
        len(data),
        offset,
    )
    offset += len(data)

ico = header + entries + b''.join(d for _, d in images)

out_path = os.path.join('assets', 'icon.ico')
with open(out_path, 'wb') as f:
    f.write(ico)

print(f'Written {out_path} ({len(ico):,} bytes, {len(images)} sizes)')
