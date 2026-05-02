import struct
import zlib
import os

def make_chunk(ctype, data):
    chunk = ctype + data
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)

def make_png(width, height, pixels):
    signature = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr = make_chunk(b'IHDR', ihdr_data)

    raw = b''
    for row in pixels:
        raw += b'\x00'  # filter: none
        for r, g, b, a in row:
            raw += struct.pack('BBBB', max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)), max(0, min(255, a)))

    compressed = zlib.compress(raw)
    idat = make_chunk(b'IDAT', compressed)
    iend = make_chunk(b'IEND', b'')
    return signature + ihdr + idat + iend

def rounded_rect_icon(size):
    """Blue rounded-rect icon with a white bookmark symbol."""
    r = max(2, size // 5)  # corner radius

    def inside_round_rect(x, y):
        # Check if point is inside the rounded rectangle
        if r <= x < size - r or r <= y < size - r:
            return True
        # Check four corners
        for cx, cy in [(r, r), (size - 1 - r, r), (r, size - 1 - r), (size - 1 - r, size - 1 - r)]:
            if (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2:
                return True
        # Check edge strips
        if r <= x < size - r:
            return 0 <= y < r or size - r <= y < size
        if r <= y < size - r:
            return 0 <= x < r or size - r <= x < size
        return False

    # Bookmark notch (bottom center)
    notch_cx = size // 2
    notch_top = int(size * 0.55)

    def inside_notch(x, y):
        if y < notch_top or y >= size - r:
            return False
        half_width = (y - notch_top) * 0.7 + 1
        return abs(x - notch_cx) < half_width

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            if inside_round_rect(x, y) and not inside_notch(x, y):
                alpha = 255
                # Subtle gradient: lighter at top-left
                t = (x + y) / (2 * size)
                red = int(74 - 15 * t)
                green = int(108 - 22 * t)
                blue = int(247 - 40 * t)
            else:
                red = green = blue = alpha = 0
            row.append((red, green, blue, alpha))
        pixels.append(row)
    return pixels

os.makedirs('icons', exist_ok=True)

for size in [16, 48, 128]:
    pixels = rounded_rect_icon(size)
    data = make_png(size, size, pixels)
    path = f'icons/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path} ({size}x{size})')

print('Done.')
