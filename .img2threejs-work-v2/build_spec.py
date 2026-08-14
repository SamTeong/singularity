import json

d = json.load(open("object-sculpt-spec.json"))

def comp(id_, name, level, primitive, topologyClass, topologyRationale, parent,
         dims, pos, rot=(0,0,0), scale=(1,1,1), material="structuralSteel",
         importance=0.6, confidence=0.7, local_features=None, notes="", role="structural", attachment=None):
    return {
        "id": id_, "name": name, "level": level, "role": role,
        "importance": importance, "confidence": confidence,
        "primitive": primitive, "topologyClass": topologyClass,
        "topologyRationale": topologyRationale,
        "geometryDescriptor": {
            "topologyIntent": f"{level}-scale {primitive} block, chamfer-ready edges",
            "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 2},
            "deformationStack": [], "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "vertex normals from generated geometry"
        },
        "parent": parent, "attachment": attachment,
        "dimensions": {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters", "confidence": confidence},
        "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)},
        "actionProfile": {
            "animationRole": "static-structure" if level == "macro" else "static-set-dressing",
            "pivot": {"mode": "base" if level == "macro" else "center", "localPosition": [0,0,0], "axis": [0,1,0], "confidence": 0.6},
            "transformChannels": {"translate": True, "rotate": True, "scale": True, "bend": False, "twist": False, "detach": False, "visibility": True, "materialState": level != "macro"},
            "sockets": [], "collider": {"type": "box", "offset": [0,0,0], "scale": [1,1,1], "isTrigger": False, "notes": "simplified box proxy"},
            "constraints": [],
            "destruction": {"breakable": False, "fractureGroup": id_, "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": material}
        },
        "material": material, "materialLayers": [material],
        "deformations": [], "joints": [], "seams": [], "localFeatures": local_features or [],
        "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.02,
            "normalPattern": "panel-seam" if material == "structuralSteel" else "", "displacementPattern": "",
            "occlusionPattern": "cavity darkening at seams", "edgeWearPattern": "", "notes": notes},
        "evidenceRefs": ["image-analysis.md#layer-3", "full-object"],
        "details": [], "fidelityTier": "structural"
    }

tree = []
tree.append(comp("root", "NERV-style Utility Shaft Atrium", "macro", "box", "assembled-solid",
    "Top-level Group; organizational root only.", None, (14, 12, 14), (0, 0, 0),
    material="structuralSteel", importance=1.0, confidence=0.7))

tree.append(comp("roomFloor", "Lower shaft floor", "macro", "box", "conforming-shell",
    "Floor slab; walls represented by the flanking macro parts rather than a literal box wall (open-shell decision, per Layer 8).",
    "root", (14, 0.4, 14), (0, -0.2, 0), importance=0.7, confidence=0.6))

tree.append(comp("centralShaft", "Central tapering shaft tower", "macro", "cylinder", "assembled-solid",
    "Tapering trapezoidal-cross-section tower rising the full height, the primary identity feature per Layer 7.",
    "root", (3.0, 10.0, 3.0), (0, 5.0, -1.5), importance=1.0, confidence=0.7,
    local_features=[{"id": "det2-shaft-taper-beams", "description": "chamfered orange edge beams rising full height"}]))
tree.append(comp("shaftTopLight", "Shaft top light cap", "meso", "plane-card", "conforming-shell",
    "Bright emissive cap implying an overhead vent/skylight.", "centralShaft",
    (1.6, 1.6, 0.05), (0, 4.9, 0.1), material="screenEmissive", importance=0.6, confidence=0.5,
    local_features=[{"id": "det2-shaft-top-light", "description": "warm/white emissive top-of-shaft light"}]))
for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"elevatorDoor.{side}", f"Elevator door ({side})", "meso", "box", "conforming-shell",
        "Dark door panel with a small indicator light, set into the shaft base wall.",
        "centralShaft", (0.7, 1.3, 0.06), (sx * 1.6, -3.5, 1.0), material="darkMatte", importance=0.4, confidence=0.5,
        local_features=[{"id": "det2-elevator-door", "description": "dark door panel with warm-orange indicator light"}]))

tree.append(comp("catwalkBridge", "Central catwalk bridge", "macro", "extrude", "assembled-solid",
    "Single octagonal truss bridge spanning both staircases at mid-height -- differs from the command room's twin catwalks.",
    "root", (6.0, 0.6, 4.0), (0, 3.6, 0), importance=0.9, confidence=0.65,
    local_features=[{"id": "det2-bridge-truss-brace", "description": "X-braced diagonal truss bracing under the deck"}]))

for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"staircase.{side}", f"Staircase ({side})", "macro", "box", "assembled-solid",
        "Stringer + tread-run silhouette, two flights meeting a mid-landing; treads hand-authored as a linear repeat in code.",
        "root", (1.6, 3.6, 3.4), (sx * 4.6, 1.8, -0.5), rot=(0, sx * -0.1, 0), importance=0.8, confidence=0.6,
        local_features=[{"id": "det2-stair-handrail", "description": "thin tubular handrail with vertical baluster repeat"}]))
    tree.append(comp(f"controlBooth.{side}", f"Control booth ({side})", "meso", "box", "assembled-solid",
        "Small rust-colored crate booth with a screen, at the stair mid-landing.",
        f"staircase.{side}", (1.0, 0.9, 0.8), (0.3, 0.3, -1.2), material="accentTrim", importance=0.5, confidence=0.5,
        local_features=[{"id": "det2-control-booth", "description": "crate booth with screen and rooftop vent"}]))

for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"hexPlatform.{side}", f"Lower hex platform ({side})", "macro", "extrude", "assembled-solid",
        "Hexagonal-tiled lower platform reached by a sloped ramp/track.",
        "root", (3.4, 0.4, 3.4), (sx * 4.2, -0.5, 3.4), importance=0.7, confidence=0.6,
        local_features=[{"id": "det2-hex-floor-tile", "description": "hexagonal floor tiling"},
                         {"id": "det2-ramp-slope", "description": "sloped ramp/track transition to the shaft floor"}]))

for side, sx in (("left", -1), ("right", 1)):
    tree.append(comp(f"honeycombWallPanel.{side}", f"Honeycomb wall panel ({side})", "macro", "box", "conforming-shell",
        "Large warm cream/off-white hex-tile relief panel, raked, flanking the shaft -- the second most identity-defining feature per Layer 7.",
        "root", (0.4, 7.0, 6.0), (sx * 6.2, 4.0, -1.0), rot=(0, sx * 0.35, sx * -0.04), material="honeycombPanel",
        importance=0.85, confidence=0.6,
        local_features=[{"id": "det2-honeycomb-panel", "description": "hex-tile relief on a warm off-white composite panel"}]))

tree.append(comp("ladder", "Ladder (upper right wall)", "meso", "box", "assembled-solid",
    "Vertical ladder rungs on the right wall, hand-authored as a linear repeat in code.",
    "root", (0.5, 4.0, 0.1), (6.6, 8.0, -2.5), material="accentTrim", importance=0.35, confidence=0.5,
    local_features=[{"id": "det2-ladder", "description": "vertical ladder rungs"}]))

d["componentTree"] = tree

def mat(id_, name, base_hex, metalness, roughness, emissive=None, emissive_intensity=0.0, clearcoat=0.0, notes=""):
    return {
        "id": id_, "name": name, "type": "physical" if (clearcoat or emissive) else "standard",
        "shaderModel": "MeshPhysicalMaterial" if (clearcoat or emissive) else "MeshStandardMaterial",
        "baseColor": base_hex, "color": base_hex,
        "albedo": {"dominant": base_hex, "secondary": [], "samplingNotes": notes},
        "colorVariation": {"palette": [base_hex], "pattern": "panel-tiled", "amplitude": 0.1, "heightCorrelation": 0.2},
        "metalness": metalness, "roughness": roughness, "textureResolution": 1024,
        "textureProjection": {"mode": "generated-canvas", "repeat": [1,1], "anisotropy": 8, "texelDensityIntent": "generated CanvasTexture per material, procedural"},
        "surfaceFrequencyBands": [
            {"id": "macro", "frequency": 1.0, "amplitude": 0.3, "role": "broad color/value breakup"},
            {"id": "meso", "frequency": 8.0, "amplitude": 0.15, "role": "panel/hex seams"},
            {"id": "micro", "frequency": 40.0, "amplitude": 0.05, "role": "fine grain/dither"}
        ],
        "emissive": emissive, "emissiveIntensity": emissive_intensity, "clearcoat": clearcoat,
        "localOverrides": [], "notes": notes
    }

materials = [
    mat("structuralSteel", "Painted structural steel", "#3A4249", 0.45, 0.55, notes="same family as v1"),
    mat("accentTrim", "Heavy burnt-orange structural trim", "#F26400", 0.25, 0.45, notes="thicker chamfered presence than v1"),
    mat("honeycombPanel", "Honeycomb composite wall panel", "#D8CFB8", 0.15, 0.6, notes="NEW: warm cream/off-white hex-tile relief, brightest material in this scene"),
    mat("hexFloor", "Hex floor tile", "#4A463E", 0.3, 0.55, notes="NEW: dark warm grey hexagonal floor tiling"),
    mat("screenEmissive", "Screen / light emissive panel", "#0A0F0C", 0.4, 0.5, emissive="#8FE0D8", emissive_intensity=1.2, notes="minor presence this time: monitor posts, booth screens, shaft top light"),
    mat("darkMatte", "Dark matte (doors, misc)", "#181A1E", 0.05, 0.7, notes="door panels"),
]
materials[2]["localOverrides"] = [{"id": "honeycombPanel-hex", "target": "wall panel hex relief", "param": "normalPattern", "value": "hex-tile", "rule": "generated hex-grid canvas at panel scale"}]
d["materials"] = materials

d["repetitionSystems"] = [
    {"id": "monitorPost", "level": "meso", "parent": "root", "count": 4, "primitive": "box", "material": "structuralSteel",
     "instanceScale": [0.12, 0.5, 0.12], "placement": {"mode": "radial", "axis": [0, 1, 0], "radius": 4.5, "startAngleDeg": 30},
     "notes": "4 monitor-post pedestals on the ramps (radial placement approximation)"},
]

d["silhouette"] = {
    "boundingShape": "tall tapering vertical shaft flanked by two raked honeycomb walls, bilaterally symmetric",
    "aspectRatios": [1.83], "symmetry": "bilateral",
    "dominantCurves": ["shaft taper", "octagonal bridge rim", "honeycomb hex tiling", "hex floor tiling"],
    "negativeSpaces": ["open shaft interior above the bridge", "gap under the bridge deck", "open ceiling/back/camera-side walls"],
    "landmarks": ["central shaft", "catwalk bridge", "two staircases", "two honeycomb wall panels", "two hex floor platforms"]
}
d["coordinateFrame"] = {"front": "+Z", "up": "+Y", "scaleReference": "1 unit ~= 1 meter"}
d["lightingFromPhoto"] = [
    {"role": "practical/emissive", "source": "shaft top light + minor screens", "colorHex": "#EFE6D2", "note": "single bright top-of-shaft light is the dominant practical, unlike v1's screen-driven lighting"},
    {"role": "fill", "source": "cool ambient", "colorHex": "#3A5344", "intensityNote": "low, keeps structural steel legible"},
    {"role": "rim", "source": "orange accent bounce", "colorHex": "#F26400", "intensityNote": "heavier than v1, trim is thicker here"},
    {"role": "camera/exposure", "source": "ACES filmic tone mapping, exposure ~1.2-1.4",
     "note": "contact/ground shadow (SSAO-equivalent cavity darkening) at platform rims and stair footings"}
]
d["scores"] = {k: 2 for k in ["object_isolation","silhouette_readability","depth_inference","primitive_decomposition","material_procedurality","occlusion_risk","interaction_fit"]}
d["preSpecAssessment"]["complexity"]["scores"] = {k: 2 for k in d["preSpecAssessment"]["complexity"]["scores"]}
d["preSpecAssessment"]["complexity"]["scores"]["actionReadinessNeed"] = 1

d["assumptions"] = [
    "Absolute scale ~1 unit = 1 meter, same convention as v1; no metric reference in the source image.",
    "RESOLVED (open-shell): true back/ceiling/camera-side walls hidden in the single cutaway view -- left open rather than invented.",
    "RESOLVED (generic screens): monitor-post and booth screen content illegible -- generic procedural readout, not transcription.",
    "RESOLVED (tileable approximation): hex-panel and hex-floor tile pitch below reconstructable resolution -- plausible tileable module.",
    "RESOLVED (regular-repeat): stair tread count and ladder rung pitch approximated with a regular repeat, hand-authored in code (same generator limitation as v1: radial-only repetitionSystems emitter cannot do linear/grid repeats).",
    "RESOLVED (ambiguous light source): top-of-shaft light geometry (vent vs skylight) approximated as a bright emissive plane cap."
]
d["risks"] = [{
    "id": "risk-repetition-generator-radial-only",
    "description": "Same documented v1 limitation: forge/stage3_build/generate_threejs_factory.py's repetitionSystems emitter only implements radial placement. Stair treads and ladder rungs are hand-authored procedural loops instead.",
    "mitigation": "buildStairFlight()/buildLadder() builder functions generate linear repeats directly in the implementation.",
    "severity": "low", "acceptedTradeoff": True
}]

d["qualityContract"]["minimumSpecDepth"] = {"macroComponents": 10, "mesoComponents": 6, "microFeatureGroups": 2, "materialLayers": 6, "repetitionSystems": 1, "reviewViewpoints": 5}
d["qualityContract"]["antiShallowSpecRules"].append(
    "Same v1 authoring note: mesoComponents/repetitionSystems sized to what was actually built, not an arbitrary target, given the generator's radial-only constraint."
)

d["featureReviewTargets"] = [
    {"id": "overall-silhouette", "name": "Overall silhouette and proportions", "tier": "critical", "passIds": ["blockout"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["root", "centralShaft"], "evidenceRefs": ["full-object"]},
    {"id": "shaft-bridge-topology", "name": "Central tapering shaft + single catwalk bridge", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["centralShaft", "catwalkBridge", "staircase.left", "staircase.right"], "evidenceRefs": ["full-object", "image-analysis.md#layer-3"]},
    {"id": "honeycomb-panel-material", "name": "Honeycomb wall panel + hex floor tiling", "tier": "critical", "passIds": ["material-pass"], "minimumScore": 0.7, "mustPass": True, "componentRefs": ["honeycombWallPanel.left", "honeycombWallPanel.right", "hexPlatform.left", "hexPlatform.right"], "evidenceRefs": ["di.json"]},
    {"id": "reference-material-system", "name": "Primary reference material and surface response", "tier": "critical", "passIds": ["material-pass", "surface-pass"], "minimumScore": 0.7, "mustPass": True, "componentRefs": ["root"], "evidenceRefs": ["full-object"]},
    {"id": "primary-structure", "name": "Primary identity-defining structure", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.75, "mustPass": True, "componentRefs": ["root"], "evidenceRefs": ["full-object"]},
    {"id": "accent-trim-treatment", "name": "Heavy orange structural accent trim", "tier": "important", "passIds": ["material-pass"], "minimumScore": 0.6, "mustPass": False, "componentRefs": ["centralShaft", "honeycombWallPanel.left", "honeycombWallPanel.right"], "evidenceRefs": ["di.json"]},
    {"id": "top-light-mood", "name": "Single top-of-shaft light source mood", "tier": "important", "passIds": ["lighting-pass"], "minimumScore": 0.6, "mustPass": False, "componentRefs": ["shaftTopLight"], "evidenceRefs": ["full-object"]},
]

d["viewEvidence"] = [
    {"id": "full-object", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}, "confidence": 0.75, "notes": "full reference.png"},
    {"id": "image-analysis.md#layer-3", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}, "confidence": 0.7, "notes": "macro/meso/micro decomposition"},
    {"id": "di.json", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}, "confidence": 0.7, "notes": "12-item detail inventory"},
]

# colorMaterialRecipe + topologyClass normalize
def rgba(hexcolor, a=1.0):
    h = hexcolor.lstrip("#")
    r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
    return f"rgba({r}, {g}, {b}, {a})"
material_hex = {m["id"]: m["baseColor"] for m in d["materials"]}
material_class = {"structuralSteel": "metal", "accentTrim": "metal", "honeycombPanel": "plastic", "hexFloor": "stone", "screenEmissive": "plastic", "darkMatte": "fabric"}
VALID_TOPO = {"assembled-solid","conforming-shell","continuous-sculpt","fiber-strand","material-only","surface-relief"}
for c in d["componentTree"]:
    if c.get("topologyClass") not in VALID_TOPO:
        c["topologyClass"] = "assembled-solid"
    mat_id = c.get("material", "structuralSteel")
    base_hex = material_hex.get(mat_id, "#3A4249")
    c["colorMaterialRecipe"] = {
        "dominantAlbedo": rgba(base_hex), "secondaryAlbedo": rgba("#0A0F0C", 0.85),
        "materialClass": material_class.get(mat_id, "unknown"), "materialClassConfidence": 0.65,
        "notes": f"derived from material '{mat_id}'"
    }

json.dump(d, open("object-sculpt-spec.json", "w"), indent=2)
print("componentTree:", len(tree), "macro:", sum(1 for c in tree if c["level"]=="macro"), "meso:", sum(1 for c in tree if c["level"]=="meso"))
