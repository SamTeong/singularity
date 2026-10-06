from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from forge.stage4_review.validate_render_profile import validate_file, validate_profile


PROFILE = Path(__file__).resolve().parents[2] / "docs" / "specs" / "render-profile.v2.example.json"


class RenderProfileTest(unittest.TestCase):
    def test_example_profile_passes(self) -> None:
        result = validate_file(PROFILE)
        self.assertTrue(result["passed"], result)
        self.assertEqual(result["passIds"], [
            "beauty",
            "alpha-silhouette",
            "semantic-id",
            "depth",
            "normal",
            "roughness-material-id",
        ])

    def test_profile_rejects_wrong_color_space(self) -> None:
        profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        profile["renderer"]["outputColorSpace"] = "LinearSRGBColorSpace"
        result = validate_profile(profile)
        self.assertFalse(result["passed"])
        self.assertTrue(any("outputColorSpace" in error for error in result["errors"]))

    def test_profile_rejects_missing_pass(self) -> None:
        profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        profile["passes"] = profile["passes"][:-1]
        result = validate_profile(profile)
        self.assertFalse(result["passed"])
        self.assertTrue(any("passes must contain exactly" in error for error in result["errors"]))


if __name__ == "__main__":
    unittest.main()
