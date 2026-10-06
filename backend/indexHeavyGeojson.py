#!/usr/bin/env python3
"""Indexa GeoJSON grande em ndjson + bbox/offsets.

Gera também uma cópia *map* (coordenadas arredondadas + anel simplificado)
só para exibição. O ndjson original permanece para cruzamento/PDF.
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys

MAP_PRECISION = 5
MAP_TOLERANCE = 0.00003  # ~3 m — irrelevante na escala do mapa satélite


def geom_bbox(geom):
    if not geom:
        return (0.0, 0.0, 0.0, 0.0)
    minx = miny = float("inf")
    maxx = maxy = float("-inf")

    def walk(c):
        nonlocal minx, miny, maxx, maxy
        if not c:
            return
        if isinstance(c[0], (int, float)) and len(c) >= 2:
            x = float(c[0])
            y = float(c[1])
            if x < minx:
                minx = x
            if x > maxx:
                maxx = x
            if y < miny:
                miny = y
            if y > maxy:
                maxy = y
            return
        for item in c:
            walk(item)

    try:
        walk(geom.get("coordinates"))
    except Exception:
        return (0.0, 0.0, 0.0, 0.0)
    if minx == float("inf"):
        return (0.0, 0.0, 0.0, 0.0)
    return (minx, miny, maxx, maxy)


def _q(n):
    return round(float(n), MAP_PRECISION)


def _perp_dist(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _dp(points, tol):
    n = len(points)
    if n <= 2:
        return list(points)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        max_d = -1.0
        max_k = -1
        a, b = points[i], points[j]
        for k in range(i + 1, j):
            d = _perp_dist(points[k], a, b)
            if d > max_d:
                max_d = d
                max_k = k
        if max_d > tol and max_k >= 0:
            keep[max_k] = True
            stack.append((i, max_k))
            stack.append((max_k, j))
    return [points[i] for i in range(n) if keep[i]]


def _simplify_ring(ring):
    pts = []
    for p in ring or []:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            pts.append((_q(p[0]), _q(p[1])))
    if len(pts) < 4:
        return pts
    closed = pts[0] == pts[-1]
    work = pts[:-1] if closed else pts
    simple = _dp(work, MAP_TOLERANCE)
    if closed:
        if not simple or simple[0] != simple[-1]:
            simple.append(simple[0])
        if len(simple) < 4:
            return pts
    return simple


def lighten_coords(coords, depth=0):
    if not coords:
        return coords
    if isinstance(coords[0], (int, float)):
        return [_q(coords[0]), _q(coords[1])]
    if coords and isinstance(coords[0], (list, tuple)) and coords[0] and isinstance(coords[0][0], (int, float)):
        return _simplify_ring(coords)
    return [lighten_coords(c, depth + 1) for c in coords]


def lighten_feature(feat):
    if not isinstance(feat, dict):
        return feat
    geom = feat.get("geometry")
    out = {
        "type": "Feature",
        "properties": feat.get("properties") or {},
        "geometry": None,
    }
    if isinstance(geom, dict) and geom.get("coordinates") is not None:
        out["geometry"] = {
            "type": geom.get("type"),
            "coordinates": lighten_coords(geom.get("coordinates")),
        }
    return out


def write_ndjson(path, features, transform=None):
    offsets = []
    off = 0
    with open(path, "w", encoding="utf-8") as out:
        for feat in features:
            item = transform(feat) if transform else feat
            line = json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
            offsets.append(off)
            encoded = line.encode("utf-8")
            out.write(line)
            off += len(encoded)
    return offsets


def main():
    if len(sys.argv) < 3:
        print("uso: indexHeavyGeojson.py <arquivo.geojson> <pasta-saida>", file=sys.stderr)
        sys.exit(2)
    src = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    print(f"indexando {src} …", flush=True)
    with open(src, "r", encoding="utf-8") as f:
        fc = json.load(f)
    features = fc.get("features") or []
    ndjson_path = os.path.join(out_dir, "features.ndjson")
    map_path = os.path.join(out_dir, "features.map.ndjson")
    bbox_path = os.path.join(out_dir, "bboxes.f64")
    off_path = os.path.join(out_dir, "offsets.u64")
    map_off_path = os.path.join(out_dir, "offsets.map.u64")
    meta_path = os.path.join(out_dir, "meta.json")

    st = os.stat(src)
    bboxes = []
    for feat in features:
        geom = feat.get("geometry") if isinstance(feat, dict) else None
        bboxes.extend(geom_bbox(geom))

    offsets = write_ndjson(ndjson_path, features)
    map_offsets = write_ndjson(map_path, features, lighten_feature)

    with open(bbox_path, "wb") as bf:
        bf.write(struct.pack(f"<{len(bboxes)}d", *bboxes) if bboxes else b"")
    with open(off_path, "wb") as of:
        of.write(struct.pack(f"<{len(offsets)}Q", *offsets) if offsets else b"")
    with open(map_off_path, "wb") as of:
        of.write(struct.pack(f"<{len(map_offsets)}Q", *map_offsets) if map_offsets else b"")
    with open(meta_path, "w", encoding="utf-8") as mf:
        json.dump(
            {
                "version": 2,
                "count": len(features),
                "size": st.st_size,
                "mtimeMs": int(st.st_mtime * 1000),
                "source": os.path.basename(src),
                "map": True,
                "mapPrecision": MAP_PRECISION,
            },
            mf,
        )
    src_mb = st.st_size / (1024 * 1024)
    map_mb = os.path.getsize(map_path) / (1024 * 1024)
    print(f"ok {len(features)} feições → {out_dir} (mapa {map_mb:.1f} MB vs origem {src_mb:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()
