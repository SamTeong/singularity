import json

d = json.load(open("object-sculpt-spec.json"))

def comp(id_, name, level, primitive, topologyClass, topologyRationale, parent,
         dims, pos, rot=(0,0,0), scale=(1,1,1), material="structuralSteel",
         importance=0.6, confidence=0.7, uvStrategy="generated procedural coordinates",
         edge_bevel=0.02, local_features=None, notes="", role="structural", attachment=None):
    return {
        "id": id_, "name": name, "level": level, "role": role,
        "importance": importance, "confidence": confidence,
        "primitive": primitive, "topologyClass": topologyClass,
        "topologyRationale": topologyRationale,
        "geometryDescriptor": {
            "topologyIntent": f"{level}-scale {primitive} block, chamfer-ready edges",
            "edgeTreatment": {"type": "bevel" if edge_bevel else "none", "bevelRadius": edge_bevel, "segments": 2},
            "deformationStack": [],
            "uvStrategy": uvStrategy,
            "normalStrategy": "vertex normals from generated geometry"
        },
        "parent": parent,
        "attachment": attachment,
        "dimensions": {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters", "confidence": confidence},
        "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)},
        "actionProfile": {
            "animationRole": "static-set-dressing" if level != "macro" else "static-structure",
            "pivot": {"mode": "base" if level == "macro" else "center", "localPosition": [0,0,0], "axis": [0,1,0], "confidence": 0.6},
            "transformChannels": {"translate": True, "rotate": True, "scale": True, "bend": False, "twist": False,
                                    "detach": False, "visibility": True, "materialState": level != "macro"},
            "sockets": [],
            "collider": {"type": "box", "offset": [0,0,0], "scale": [1,1,1], "isTrigger": False, "notes": "simplified box proxy; static set-dressing does not need a tight collider"},
            "constraints": [],
            "destruction": {"breakable": False, "fractureGroup": id_, "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": material}
        },
        "material": material,
        "materialLayers": [material],
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": local_features or [],
        "surfaceDetail": {
            "macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02,
            "normalPattern": "panel-seam" if material == "structuralSteel" else "",
            "displacementPattern": "", "occlusionPattern": "cavity darkening at seams",
            "edgeWearPattern": "", "notes": notes
        },
        "evidenceRefs": ["image-analysis.md#layer-3", "di.json"],
        "details": [],
        "fidelityTier": "structural"
    }

W, H, D = 14.0, 11.0, 14.0  # room shell approx meters

tree = []

# ---- MACRO: room shell ----
tree.append(comp("root", "NERV-style Tactical Command Room", "macro", "box", "assembled-solid",
    "Top-level Group; not a single mesh -- pure organizational root for the whole composite set.",
    None, (W, H, D), (0, 0, 0), material="structuralSteel", importance=1.0, confidence=0.7, role="body"))

tree.append(comp("roomShell", "Room shell (floor + rear/side structure)", "macro", "box", "hollow-shell",
    "Open-top, open-front rectangular shell inferred from the dollhouse-cutaway framing; back/ceiling/camera-side walls are the unresolved sides flagged in Layer 8 and are intentionally omitted rather than invented.",
    "root", (W, 0.4, D), (0, -0.2, 0), material="structuralSteel", importance=0.7, confidence=0.6,
    local_features=[{"id": "det-structural-column-panel-seam", "description": "tileable riveted/paneled plate-seam normal detail"}],
    notes="floor slab only; walls represented by the flanking macro parts (monitor towers, columns) rather than a literal box wall"))

# ---- MACRO: central dais ----
tree.append(comp("centralDais", "Central raised command dais", "macro", "extrude", "faceted-solid",
    "Bevelled octagonal deck read directly off the silhouette (Layer 2) -- an extruded octagon profile with a chamfered top edge, not a boolean-cut box.",
    "root", (6.4, 1.1, 4.6), (0, 0.55, 0.6), material="consoleDeck", importance=1.0, confidence=0.75,
    local_features=[{"id": "det-dais-guardrail-lip", "description": "raised bevelled guard-rail lip around the octagonal deck edge"}],
    role="body"))
tree.append(comp("daisConsoleCenter", "Dais center console + 4-monitor stack", "meso", "box", "assembled-solid",
    "Boxy console desk topped by a repeated screen-module cluster (small flat panels).", "centralDais",
    (1.0, 0.9, 0.6), (0, 1.0, -0.2), material="structuralSteel", importance=0.8, confidence=0.6))
tree.append(comp("daisConsoleLeft", "Dais left winged console", "meso", "box", "assembled-solid",
    "Winged desk silhouette flanking the center console.", "centralDais",
    (1.6, 0.85, 0.9), (-1.9, 0.9, 0.1), rot=(0, 0.35, 0), material="structuralSteel", importance=0.7, confidence=0.55))
tree.append(comp("daisConsoleRight", "Dais right winged console", "meso", "box", "assembled-solid",
    "Mirror of daisConsoleLeft.", "centralDais",
    (1.6, 0.85, 0.9), (1.9, 0.9, 0.1), rot=(0, -0.35, 0), material="structuralSteel", importance=0.7, confidence=0.55))

# ---- MACRO: logo monument ----
tree.append(comp("logoMonument", "Central logo monument", "macro", "box", "assembled-solid",
    "Tall plinth+shaft+backlit-panel stack directly behind the dais; the emblem itself is authored generic/abstract per the projection-route skip reason (no reproduction of the source mark).",
    "root", (2.6, 6.5, 1.4), (0, 3.8, -3.8), material="structuralSteel", importance=0.85, confidence=0.65,
    local_features=[{"id": "det-logo-emblem-glyph", "description": "abstract angular emissive emblem + text plate, generic (non-reproduction)"}]))
tree.append(comp("logoEmblemPanel", "Backlit emblem panel", "meso", "plane-card", "planar-thin-shell",
    "Flat emissive card mounted on the monument face -- a thin panel, not a solid, per Layer 5/6 (self-lit, not reflective).", "logoMonument",
    (1.6, 2.2, 0.05), (0, 1.6, 0.73), material="screenEmissive", importance=0.75, confidence=0.6))
tree.append(comp("logoTextPlate", "Text plate", "micro", "plane-card", "planar-thin-shell",
    "Narrow emissive text band below the emblem.", "logoMonument",
    (1.8, 0.5, 0.03), (0, 0.15, 0.73), material="screenEmissive", importance=0.4, confidence=0.6))

# ---- MACRO pairs: vice-command platforms ----
for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"viceCommandPlatform.{side}", f"Vice-command platform ({side})", "macro", "extrude", "faceted-solid",
        "Lower-tier bevelled rounded-rect platform, mirrors the dais language at smaller scale.",
        "root", (2.6, 0.7, 2.2), (sx * 5.6, 0.35, 3.6), material="consoleDeck", importance=0.55, confidence=0.6,
        local_features=[{"id": "det-vice-command-desk-wing", "description": "winged desk silhouette flanking a smaller centered console"}]))
    tree.append(comp(f"viceCommandDesk.{side}", f"Vice-command desk ({side})", "meso", "box", "assembled-solid",
        "Console desk on the vice-command platform.", f"viceCommandPlatform.{side}",
        (1.4, 0.8, 0.7), (0, 0.75, 0), material="structuralSteel", importance=0.5, confidence=0.5))

# ---- MACRO pairs: staircases ----
for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"staircase.{side}", f"Staircase ({side})", "macro", "box", "assembled-solid",
        "Stringer + tread-run silhouette (Layer 3 meso: 2 flights meeting a mid-landing); individual treads are hand-authored as a linear repeat in code rather than the spec's radial-only repetitionSystem emitter (documented in risks).",
        "root", (1.6, 5.0, 3.2), (sx * 4.4, 2.5, -1.2), rot=(0, sx * -0.12, 0), material="structuralSteel",
        importance=0.75, confidence=0.6,
        local_features=[{"id": "det-stair-handrail-tube", "description": "thin tubular handrail with vertical baluster repeat"}]))
    tree.append(comp(f"stairHandrail.{side}", f"Stair handrail ({side})", "meso", "tube", "curve-swept-solid",
        "Thin tube swept along the stair run.", f"staircase.{side}",
        (0.05, 5.0, 0.05), (0.7, 0, 0), material="accentTrim", importance=0.35, confidence=0.55))

# ---- MACRO pairs: catwalks ----
for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"catwalk.{side}", f"Catwalk / bridge truss ({side})", "macro", "curve-sweep", "curve-swept-solid",
        "Truncated-triangular truss (top chord + diagonal web + bottom chord) bridging the stair mid-landing to the room's mid-height, matching Layer 2's lofted-beam read.",
        "root", (3.0, 0.6, 1.0), (sx * 3.0, 4.6, -3.2), rot=(0, sx * -0.12, 0), material="structuralSteel",
        importance=0.7, confidence=0.55,
        local_features=[{"id": "det-catwalk-truss-web", "description": "diagonal web between top/bottom chord"}]))

# ---- MACRO: floor pit ----
tree.append(comp("floorPit", "Sunken octagonal floor pit", "macro", "extrude", "faceted-solid",
    "Bevelled walkway rim around a faceted inward-sloping sunken octagon -- the single most identity-defining negative-space feature (Layer 7).",
    "root", (5.2, 1.4, 5.2), (0, -0.7, 2.6), material="pitGlass", importance=0.9, confidence=0.65,
    local_features=[{"id": "det-pit-inner-slope-facets", "description": "faceted glossy-dark inward-sloping inner walls"},
                     {"id": "det-floor-pit-emitter-strip", "description": "flush emissive strip at the very bottom center"}]))
tree.append(comp("floorPitEmitterStrip", "Pit floor emitter strip", "micro", "box", "assembled-solid",
    "Flush bright accent strip at the pit's bottom center.", "floorPit",
    (1.0, 0.03, 0.2), (0, -0.68, 2.6), material="accentTrim", importance=0.3, confidence=0.6))

# ---- MACRO pairs: monitor-wall towers ----
for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"monitorWallTower.{side}", f"Monitor-wall tower ({side})", "macro", "box", "planar-thin-shell",
        "Raked backing wall (leans inward toward the room's central axis at the top) carrying the tiled screen grid -- the second most identity-defining feature (Layer 7). Screen tiles are hand-authored as a 2D grid loop, not the spec's radial-only repetitionSystem.",
        "root", (0.5, 8.0, 8.0), (sx * 6.4, 4.0, -1.0), rot=(0, sx * 0.55, sx * -0.06), material="structuralSteel",
        importance=0.9, confidence=0.6,
        local_features=[{"id": "det-screen-tile-grid", "description": "non-uniform tiled grid of individually framed rectangular screens"},
                         {"id": "det-wall-tower-rake", "description": "wall leans inward toward the room's central axis at the top"}]))
    tree.append(comp(f"wallNameplate.{side}", f"Wall nameplate ({side})", "micro", "plane-card", "planar-thin-shell",
        "Small signage rectangle distinct from the screen tiles.", f"monitorWallTower.{side}",
        (0.9, 0.3, 0.02), (0, -3.2, 4.1), material="screenEmissive", importance=0.25, confidence=0.6))

d["componentTree"] = tree

# ---- materials ----
def mat(id_, name, base_hex, metalness, roughness, emissive=None, emissive_intensity=0.0,
        clearcoat=0.0, notes=""):
    m = {
        "id": id_, "name": name, "type": "physical" if clearcoat or emissive else "standard",
        "shaderModel": "MeshPhysicalMaterial" if (clearcoat or emissive) else "MeshStandardMaterial",
        "baseColor": base_hex, "color": base_hex,
        "albedo": {"dominant": base_hex, "secondary": [], "samplingNotes": notes},
        "colorVariation": {"palette": [base_hex], "pattern": "panel-tiled" if id_ == "structuralSteel" else "flat",
                             "amplitude": 0.1, "heightCorrelation": 0.2},
        "metalness": metalness, "roughness": roughness,
        "textureResolution": 1024,
        "textureProjection": {"mode": "generated-canvas", "repeat": [1,1], "anisotropy": 8,
                                "texelDensityIntent": "generated CanvasTexture per material, procedural (no photo bake)"},
        "surfaceFrequencyBands": [
            {"id": "macro", "frequency": 1.0, "amplitude": 0.3, "role": "broad color/value breakup"},
            {"id": "meso", "frequency": 8.0, "amplitude": 0.15, "role": "panel seams / edge highlights"},
            {"id": "micro", "frequency": 40.0, "amplitude": 0.05, "role": "fine grain / dither"}
        ],
        "emissive": emissive, "emissiveIntensity": emissive_intensity, "clearcoat": clearcoat,
        "localOverrides": [], "notes": notes
    }
    return m

materials = [
    mat("structuralSteel", "Painted structural steel", "#3A4249", 0.6, 0.55,
        notes="dark blue-grey satin steel; procedural CanvasTexture panel-seam pattern for meso normal-ish variation"),
    mat("accentTrim", "Burnt-orange structural accent", "#F26400", 0.3, 0.45,
        notes="thin edge/trim treatment only, applied to beams/stair stringers/wall capitals -- not a fill color"),
    mat("consoleDeck", "Console/dais composite deck", "#2E6F6B", 0.1, 0.25,
        notes="satin-gloss dielectric deck laminate"),
    mat("screenEmissive", "Screen / emblem emissive panel", "#0A0F0C", 0.4, 0.5,
        emissive="#52F29A", emissive_intensity=1.6,
        notes="near-black bezel + generated-canvas emissive inner panel; per-instance brightness/hue varied via localOverrides"),
    mat("pitGlass", "Floor-pit glossy composite", "#04100E", 0.05, 0.15, clearcoat=0.6,
        notes="glossy-dark dielectric, faint reflective cue on the inner slope facets"),
    mat("darkMatte", "Dark matte (chairs / cart bodies)", "#15181A", 0.05, 0.75,
        notes="matte fabric/plastic for task chairs and satellite cart bodies"),
]
# per-instance emissive local overrides (Layer 6 gradient: edge darker -> hot near-white patch)
materials[3]["localOverrides"] = [
    {"target": "wallScreenGrid instances", "param": "emissiveIntensity", "range": [0.8, 2.4],
     "rule": "randomized per-instance within range, seeded, to read as mixed mid-value cyan-green with occasional near-white hot screens"},
    {"target": "logoEmblemPanel", "param": "emissiveIntensity", "value": 2.0},
]
d["materials"] = materials

# ---- repetition systems (radial-appropriate only; grid/linear repeats are hand-authored in code) ----
d["repetitionSystems"] = [
    {"id": "taskChair", "level": "meso", "parent": "centralDais", "count": 3, "primitive": "capsule",
     "material": "darkMatte", "instanceScale": [0.22, 0.22, 0.22],
     "placement": {"mode": "radial", "axis": [0, 1, 0], "radius": 1.6, "startAngleDeg": -35},
     "notes": "3 task chairs across the dais consoles"},
    {"id": "satelliteCart", "level": "meso", "parent": "floorPit", "count": 4, "primitive": "box",
     "material": "structuralSteel", "instanceScale": [0.35, 0.55, 0.3],
     "placement": {"mode": "radial", "axis": [0, 1, 0], "radius": 3.4, "startAngleDeg": 45},
     "notes": "4 satellite console carts flanking the pit rim"},
]

with open("object-sculpt-spec.json", "w") as f:
    json.dump(d, f, indent=2)

print("componentTree:", len(tree))
print("macro:", sum(1 for c in tree if c["level"] == "macro"))
print("meso:", sum(1 for c in tree if c["level"] == "meso"))
print("micro:", sum(1 for c in tree if c["level"] == "micro"))
print("materials:", len(materials))
print("repetitionSystems:", len(d["repetitionSystems"]))
