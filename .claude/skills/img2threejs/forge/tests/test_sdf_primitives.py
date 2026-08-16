#!/usr/bin/env python3
"""Red contracts for implicit SDF descriptors and generated polygonizers."""

from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "implicit_character_torso_limb.json"


def import_forge_modules():
    module_names = ("generate_threejs_factory", "validate_sculpt_spec")
    original_modules = {name: sys.modules.pop(name, None) for name in module_names}
    original_path = sys.path[:]
    sys.path[:0] = [str(ROOT / "stage2_spec"), str(ROOT / "stage3_build")]
    try:
        from generate_threejs_factory import generate
        from validate_sculpt_spec import VALID_PRIMITIVES, validate_spec
    finally:
        sys.path[:] = original_path
        for name, module in original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    return generate, VALID_PRIMITIVES, validate_spec


generate, VALID_PRIMITIVES, validate_spec = import_forge_modules()


def load_fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class SdfPrimitiveContractTest(unittest.TestCase):
    def test_accepts_implicit_topology_with_maximum_sdf_resolution(self) -> None:
        spec = load_fixture()
        component = spec["componentTree"][0]
        component["geometryDescriptor"]["sdf"]["resolution"] = 64
        errors, warnings = validate_spec(spec)

        self.assertEqual(component["primitive"], "capsule")
        self.assertIn(component["primitive"], VALID_PRIMITIVES)
        self.assertEqual(component["topologyClass"], "implicit")
        self.assertEqual(errors, [])
        self.assertFalse(
            any("topologyClass" in warning for warning in warnings),
            warnings,
        )

    def test_rejects_invalid_sdf_primitive_operation_resolution_and_nonfinite_values(self) -> None:
        cases = (
            (
                "primitive",
                ("primitives", 0, "type"),
                "not-a-primitive",
                "geometryDescriptor.sdf.primitives[0].type",
                "must be one of",
            ),
            (
                "operation",
                ("operations", 0, "type"),
                "xor",
                "geometryDescriptor.sdf.operations[0].type",
                "must be one of",
            ),
            (
                "resolution",
                ("resolution",),
                65,
                "geometryDescriptor.sdf.resolution",
                "must not exceed 64",
            ),
            (
                "nonfinite radius",
                ("primitives", 0, "radius"),
                math.inf,
                "geometryDescriptor.sdf.primitives[0].radius",
                "must be finite",
            ),
        )
        for label, path, value, field_path, reason in cases:
            with self.subTest(label=label):
                spec = load_fixture()
                sdf = spec["componentTree"][0]["geometryDescriptor"]["sdf"]
                target = sdf
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value

                errors, _warnings = validate_spec(spec)

                self.assertTrue(
                    any(field_path in error and reason in error for error in errors),
                    errors,
                )

    def test_rejects_unsupported_sdf_transform_fields(self) -> None:
        spec = load_fixture()
        primitive = spec["componentTree"][0]["geometryDescriptor"]["sdf"]["primitives"][0]
        primitive["transform"] = {"center": [0.0, 0.0, 0.0]}

        errors, _warnings = validate_spec(spec)

        self.assertTrue(
            any(
                "geometryDescriptor.sdf.primitives[0].transform.center" in error
                and "is not supported" in error
                for error in errors
            ),
            errors,
        )

    def test_rejects_unsupported_sdf_primitive_fields(self) -> None:
        spec = load_fixture()
        primitive = spec["componentTree"][0]["geometryDescriptor"]["sdf"]["primitives"][0]
        primitive["position"] = [0.0, 0.0, 0.0]

        errors, _warnings = validate_spec(spec)

        self.assertTrue(
            any(
                "geometryDescriptor.sdf.primitives[0].position" in error
                and "is not supported" in error
                for error in errors
            ),
            errors,
        )

    def test_rejects_sdf_operation_output_id_collisions(self) -> None:
        cases = (
            ("primitive", {"id": "torso"}),
            ("prior operation", {"id": "blend"}),
        )
        for label, output in cases:
            with self.subTest(label=label):
                spec = load_fixture()
                operations = spec["componentTree"][0]["geometryDescriptor"]["sdf"]["operations"]
                operations[0].update(output)
                if label == "prior operation":
                    operations.append({"type": "intersect", "left": "blend", "right": "torso", "id": "blend"})

                errors, _warnings = validate_spec(spec)

                self.assertTrue(
                    any("geometryDescriptor.sdf.operations" in error and "duplicates" in error for error in errors),
                    errors,
                )

    def test_rejects_unsupported_sdf_operation_fields(self) -> None:
        spec = load_fixture()
        operation = spec["componentTree"][0]["geometryDescriptor"]["sdf"]["operations"][0]
        operation["blendWidth"] = 0.2

        errors, _warnings = validate_spec(spec)

        self.assertTrue(
            any(
                "geometryDescriptor.sdf.operations[0].blendWidth" in error
                and "is not supported" in error
                for error in errors
            ),
            errors,
        )

    def test_rejects_conflicting_sdf_operation_id_and_output(self) -> None:
        spec = load_fixture()
        operation = spec["componentTree"][0]["geometryDescriptor"]["sdf"]["operations"][0]
        operation.update({"id": "blend", "output": "alternate-blend"})

        errors, _warnings = validate_spec(spec)

        self.assertTrue(
            any(
                "geometryDescriptor.sdf.operations[0].id" in error and "cannot both be set" in error
                for error in errors
            ),
            errors,
        )

    def test_rejects_collapsed_or_reversed_sdf_bounds(self) -> None:
        cases = (
            ("collapsed", [0.0, -1.0, -1.0], [0.0, 1.0, 1.0]),
            ("reversed", [1.0, -1.0, -1.0], [0.0, 1.0, 1.0]),
        )
        for label, minimum, maximum in cases:
            with self.subTest(label=label):
                spec = load_fixture()
                sdf = spec["componentTree"][0]["geometryDescriptor"]["sdf"]
                sdf["bounds"] = {"min": minimum, "max": maximum}

                errors, _warnings = validate_spec(spec)

                self.assertTrue(
                    any(
                        "geometryDescriptor.sdf.bounds.min[0]" in error and "less than" in error
                        for error in errors
                    ),
                    errors,
                )

    def test_rejects_sdf_descriptor_cardinality_over_limits(self) -> None:
        cases = (("primitives", 33, 64), ("operations", 129, 128))
        for field, multiplier, limit in cases:
            with self.subTest(field=field):
                spec = load_fixture()
                sdf = spec["componentTree"][0]["geometryDescriptor"]["sdf"]
                sdf[field] *= multiplier

                errors, _warnings = validate_spec(spec)

                self.assertTrue(
                    any(
                        f"geometryDescriptor.sdf.{field}" in error
                        and f"must not contain more than {limit}" in error
                        for error in errors
                    ),
                    errors,
                )

    def test_generates_sdf_and_polygonizer_markers(self) -> None:
        spec = load_fixture()
        sdf = spec["componentTree"][0]["geometryDescriptor"]["sdf"]
        generated = generate(spec, "blockout")

        self.assertIn("function sdfCapsule", generated)
        self.assertIn("function smin", generated)
        self.assertIn("function polygonizeSdf", generated)
        polygonizer_start = generated.index("function polygonizeSdf")
        polygonizer_end = generated.index("return geometry;", polygonizer_start)
        self.assertIn("computeVertexNormals()", generated[polygonizer_start:polygonizer_end])
        for marker in (
            '"type": "capsule"',
            '"type": "smooth-union"',
            '"resolution": 32',
            '"radius": 0.16',
            '"height": 1.1',
        ):
            self.assertIn(marker, generated)
        self.assertIn(f"polygonizeSdf({json.dumps(sdf)})", generated)

    def test_generates_inverse_quaternion_for_multi_axis_sdf_rotation(self) -> None:
        spec = load_fixture()
        primitive = spec["componentTree"][0]["geometryDescriptor"]["sdf"]["primitives"][0]
        primitive["transform"] = {"rotation": [0.37, -0.61, 1.13]}

        generated = generate(spec, "blockout")

        self.assertIn("setFromEuler", generated)
        self.assertIn(".invert()", generated)


if __name__ == "__main__":
    unittest.main(verbosity=2)
