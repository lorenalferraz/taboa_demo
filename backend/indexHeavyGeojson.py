#!/usr/bin/env python3
"""Indexa shape(s) pesado(s) (GeoJSON ou GeoPackage) em ndjson + bbox/offsets.

Aceita um ou vários arquivos de origem (partes por região / CEFIR).
Reprojeta para EPSG:4326 quando a origem não for geográfica.
Normaliza atributos do CEFIR (minúsculos → maiúsculos do SICAR).

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
MAP_TOLERANCE = 0.00003  # ~3 m

# Campos CEFIR (assentamento) → padrão usado no sistema
PROP_ALIASES = {
    "ide_imovel": "IDE_IMOVEL",
    "tpo_cadast": "TPO_CADAST",
    "tipo": "TIPO",
    "area_decla": "AREA_DECLA",
    "est_conser": "EST_CONSER",
    "status": "STATUS",
    "numero_car": "NUMERO_CAR",
    "denominaca": "DENOMINACA",
    "municipio": "MUNICIPIO",
    "area_regis": "AREA_REGIS",
    "qtd_modfis": "QTD_MODFIS",
}


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


def fix_mojibake(s):
    if not isinstance(s, str) or "Ã" not in s:
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except Exception:
        return s


def _field_value(feat, i):
    try:
        val = feat.GetField(i)
    except Exception:
        return None
    if val is None:
        return None
    if isinstance(val, bytes):
        try:
            return fix_mojibake(val.decode("utf-8"))
        except Exception:
            try:
                return fix_mojibake(val.decode("latin-1"))
            except Exception:
                return None
    if isinstance(val, str):
        return fix_mojibake(val)
    if hasattr(val, "isoformat"):
        try:
            return val.isoformat()
        except Exception:
            return str(val)
    return val


def normalize_props(props):
    out = {}
    for k, v in (props or {}).items():
        if k is None:
            continue
        key = str(k)
        if key.lower() in ("fid", "ogc_fid", "gid"):
            continue
        mapped = PROP_ALIASES.get(key) or PROP_ALIASES.get(key.lower()) or key
        # Preferir já-maiúsculo se ambos existirem
        if mapped in out and key != mapped:
            continue
        out[mapped] = v
    return out


def iter_features_from_gpkg(src):
    from osgeo import ogr, osr

    ogr.UseExceptions()
    ds = ogr.Open(src)
    if ds is None:
        raise RuntimeError(f"não foi possível abrir {src}")
    layer = ds.GetLayer(0)
    if layer is None:
        raise RuntimeError(f"sem camada em {src}")

    src_srs = layer.GetSpatialRef()
    dst_srs = osr.SpatialReference()
    dst_srs.ImportFromEPSG(4326)
    try:
        dst_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    except Exception:
        pass
    transform = None
    if src_srs is not None:
        try:
            src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        except Exception:
            pass
        if not src_srs.IsSame(dst_srs):
            transform = osr.CoordinateTransformation(src_srs, dst_srs)

    layer.ResetReading()
    while True:
        feat = layer.GetNextFeature()
        if feat is None:
            break
        props = {}
        for i in range(feat.GetFieldCount()):
            name = feat.GetFieldDefnRef(i).GetName()
            props[name] = _field_value(feat, i)
        props = normalize_props(props)
        geom = feat.GetGeometryRef()
        geometry = None
        if geom is not None:
            g = geom.Clone()
            if transform is not None:
                try:
                    g.Transform(transform)
                except Exception:
                    pass
            geometry = json.loads(g.ExportToJson())
        yield {
            "type": "Feature",
            "properties": props,
            "geometry": geometry,
        }
    ds = None


def iter_features_from_geojson(src):
    with open(src, "r", encoding="utf-8") as f:
        fc = json.load(f)
    for feat in fc.get("features") or []:
        if not isinstance(feat, dict):
            continue
        yield {
            "type": "Feature",
            "properties": normalize_props(feat.get("properties") or {}),
            "geometry": feat.get("geometry"),
        }


def iter_features(src):
    lower = src.lower()
    if lower.endswith(".gpkg"):
        yield from iter_features_from_gpkg(src)
    else:
        yield from iter_features_from_geojson(src)


def main():
    if len(sys.argv) < 3:
        print(
            "uso: indexHeavyGeojson.py <pasta-saida> <arquivo1.gpkg|geojson> [arquivo2 ...]",
            file=sys.stderr,
        )
        sys.exit(2)
    out_dir = sys.argv[1]
    sources = sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)

    ndjson_path = os.path.join(out_dir, "features.ndjson")
    map_path = os.path.join(out_dir, "features.map.ndjson")
    bbox_path = os.path.join(out_dir, "bboxes.f64")
    off_path = os.path.join(out_dir, "offsets.u64")
    map_off_path = os.path.join(out_dir, "offsets.map.u64")
    meta_path = os.path.join(out_dir, "meta.json")

    offsets = []
    map_offsets = []
    bboxes = []
    count = 0
    off = 0
    map_off = 0
    source_meta = []

    print(f"indexando {len(sources)} origem(ns) → {out_dir}", flush=True)
    with open(ndjson_path, "w", encoding="utf-8") as full_out, open(
        map_path, "w", encoding="utf-8"
    ) as map_out:
        for src in sources:
            if not os.path.exists(src):
                raise FileNotFoundError(src)
            st = os.stat(src)
            source_meta.append(
                {
                    "file": os.path.basename(src),
                    "size": st.st_size,
                    "mtimeMs": int(st.st_mtime * 1000),
                }
            )
            print(f"  · {os.path.basename(src)} …", flush=True)
            n_src = 0
            for feat in iter_features(src):
                geom = feat.get("geometry") if isinstance(feat, dict) else None
                bboxes.extend(geom_bbox(geom))
                line = json.dumps(feat, ensure_ascii=False, separators=(",", ":")) + "\n"
                encoded = line.encode("utf-8")
                offsets.append(off)
                full_out.write(line)
                off += len(encoded)

                light = lighten_feature(feat)
                map_line = json.dumps(light, ensure_ascii=False, separators=(",", ":")) + "\n"
                map_encoded = map_line.encode("utf-8")
                map_offsets.append(map_off)
                map_out.write(map_line)
                map_off += len(map_encoded)

                count += 1
                n_src += 1
            print(f"    {n_src} feições", flush=True)

    with open(bbox_path, "wb") as bf:
        bf.write(struct.pack(f"<{len(bboxes)}d", *bboxes) if bboxes else b"")
    with open(off_path, "wb") as of:
        of.write(struct.pack(f"<{len(offsets)}Q", *offsets) if offsets else b"")
    with open(map_off_path, "wb") as of:
        of.write(struct.pack(f"<{len(map_offsets)}Q", *map_offsets) if map_offsets else b"")

    total_size = sum(s["size"] for s in source_meta)
    with open(meta_path, "w", encoding="utf-8") as mf:
        json.dump(
            {
                "version": 3,
                "count": count,
                "size": total_size,
                "sources": source_meta,
                "source": ",".join(s["file"] for s in source_meta),
                "format": "gpkg-parts",
                "crsOut": "EPSG:4326",
                "map": True,
                "mapPrecision": MAP_PRECISION,
            },
            mf,
        )
    map_mb = os.path.getsize(map_path) / (1024 * 1024)
    print(
        f"ok {count} feições → {out_dir} (mapa {map_mb:.1f} MB; origem {total_size / (1024 * 1024):.1f} MB)",
        flush=True,
    )


if __name__ == "__main__":
    main()
