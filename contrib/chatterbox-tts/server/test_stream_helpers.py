"""Pure helper tests; deliberately does not import or load the ML service."""
import ast
import base64
import json
import math
import os
from pathlib import Path
import re
from typing import Any
import unittest


SERVICE_PATH = Path(__file__).with_name("chatterbox-service.py")
SOURCE = SERVICE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
CONSTANTS = {
    "STREAM_PROTOCOL_VERSION", "FIRST_CHUNK_CHARS", "SECOND_CHUNK_CHARS",
    "LATER_CHUNK_CHARS",
    "MAX_REQUEST_BYTES", "MAX_INPUT_CHARS", "MAX_STREAM_CHUNKS",
    "MAX_VOICE_CHARS", "MAX_MODEL_CHARS", "STREAM_FIELDS", "_SENTENCE_END",
}
FUNCTIONS = {
    "_normalize_input", "_prefix_length", "split_speech_text", "_ndjson_line",
    "_audio_record", "_validate_stream_payload",
}


def load_pure_helpers():
    body = []
    for node in TREE.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = {target.id for target in targets if isinstance(target, ast.Name)}
            if names & CONSTANTS:
                body.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in FUNCTIONS:
            body.append(node)
    namespace = {"re": re, "json": json, "base64": base64, "math": math, "os": os}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(SERVICE_PATH), "exec"), namespace)
    return namespace


H: Any = load_pure_helpers()


class StreamHelperTests(unittest.TestCase):
    def test_sentence_whitespace_and_hard_cut_boundaries(self):
        split = H["split_speech_text"]
        text = "  Quick first.   Second sentence stays here.  " + "word " * 140
        chunks = split(text)
        self.assertTrue(chunks[0].startswith("Quick first."))
        self.assertGreaterEqual(len(chunks[0]), 140)
        self.assertLessEqual(len(chunks[0]), H["FIRST_CHUNK_CHARS"])
        self.assertTrue(all(0 < len(chunk) <= H["LATER_CHUNK_CHARS"] for chunk in chunks[1:]))
        self.assertEqual(" ".join(chunks), H["_normalize_input"](text))
        self.assertEqual(split("x" * 565), ["x" * 160, "x" * 160, "x" * 160, "x" * 85])
        self.assertEqual(split("Short one. Short two."), ["Short one. Short two."])
        opening = ("O" * 140) + "."
        after_heading = split(opening + " Heading. " + ("word " * 100))
        self.assertTrue(after_heading[1].startswith("Heading."))
        self.assertGreaterEqual(len(after_heading[1]), 80)

    def test_configured_second_chunk_creates_startup_buffer(self):
        split = H["split_speech_text"]
        names = ("FIRST_CHUNK_CHARS", "SECOND_CHUNK_CHARS", "LATER_CHUNK_CHARS")
        previous = tuple(H[name] for name in names)
        try:
            H.update(dict(zip(names, (120, 80, 120), strict=True)))
            self.assertEqual(
                [len(chunk) for chunk in split("x" * 490)],
                [120, 80, 120, 120, 50],
            )
        finally:
            H.update(dict(zip(names, previous, strict=True)))

    def test_later_chunks_prefer_last_complete_sentence(self):
        split = H["split_speech_text"]
        first = "First."
        later = ("A sentence with words. " * 30).strip()
        chunks = split(f"{first} {later}")
        self.assertTrue(chunks[0].startswith(first))
        self.assertGreaterEqual(len(chunks[0]), 140)
        self.assertTrue(chunks[1].endswith("."))
        self.assertLessEqual(len(chunks[1]), H["LATER_CHUNK_CHARS"])

    def test_strict_payload_preflight(self):
        validate = H["_validate_stream_payload"]
        text, model, voice, speed, chunks = validate({
            "model": "chatterbox", "input": " Hello\nworld. ", "voice": " alloy ",
            "response_format": "WAV", "speed": 1,
        })
        self.assertEqual((text, model, voice, speed), ("Hello world.", "chatterbox", "alloy", 1.0))
        self.assertEqual(chunks, ["Hello world."])
        bad = [
            None,
            {"input": "ok", "unknown": 1},
            {"input": 3},
            {"input": " "},
            {"input": "ok", "model": 3},
            {"input": "ok", "model": ""},
            {"input": "ok", "voice": ""},
            {"input": "ok", "voice": 3},
            {"input": "ok", "response_format": "mp3"},
            {"input": "ok", "response_format": 3},
            {"input": "ok", "speed": True},
            {"input": "ok", "speed": float("nan")},
            {"input": "ok", "speed": float("inf")},
            {"input": "ok", "speed": 0.24},
            {"input": "ok", "speed": 4.01},
        ]
        for payload in bad:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    validate(payload)

    def test_input_and_chunk_count_limits_are_preflighted(self):
        validate = H["_validate_stream_payload"]
        with self.assertRaisesRegex(ValueError, "characters"):
            validate({"input": "x" * (H["MAX_INPUT_CHARS"] + 1)})
        _, _, _, _, chunks = validate({"input": "x" * H["MAX_INPUT_CHARS"]})
        self.assertLessEqual(len(chunks), H["MAX_STREAM_CHUNKS"])

    def test_compact_utf8_protocol_record_shapes(self):
        line = H["_ndjson_line"]({"type": "error", "error": "échec"})
        self.assertTrue(line.endswith(b"\n"))
        self.assertNotIn(b": ", line)
        self.assertEqual(json.loads(line), {"type": "error", "error": "échec"})
        audio = H["_audio_record"](2, b"RIFFdataWAVE")
        record = json.loads(audio)
        self.assertEqual(set(record), {"type", "index", "audio", "mime_type"})
        self.assertEqual(record["index"], 2)
        self.assertEqual(record["mime_type"], "audio/wav")
        self.assertEqual(base64.b64decode(record["audio"], validate=True), b"RIFFdataWAVE")

    def test_condition_cache_identity_mentions_exaggeration(self):
        function = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "_ensure_conditionals")
        assignments = [node for node in ast.walk(function) if isinstance(node, ast.Assign)]
        key_values = [ast.unparse(node.value) for node in assignments
                      if any(isinstance(target, ast.Name) and target.id == "key" for target in node.targets)]
        self.assertTrue(key_values)
        self.assertTrue(all("exaggeration" in value for value in key_values))

    def test_shared_lock_helper_is_used_by_legacy_stream_and_warmup(self):
        generate = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "_generate_audio")
        self.assertTrue(any(isinstance(node, ast.With) and "_synthesis_lock" in ast.unparse(node.items[0].context_expr)
                            for node in ast.walk(generate)))
        legacy = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "speech")
        stream = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "speech_stream")
        self.assertTrue(any(isinstance(node, ast.Call) and ast.unparse(node.func) == "_generate_audio" for node in ast.walk(legacy)))
        generator = next(node for node in stream.body if isinstance(node, ast.FunctionDef) and node.name == "generate_stream")
        self.assertTrue(any(isinstance(node, ast.Call) and ast.unparse(node.func) == "_generate_audio" for node in ast.walk(generator)))
        self.assertFalse(any(isinstance(node, ast.Name) and node.id == "request" for node in ast.walk(generator)),
                         "the Flask generator must use only pre-resolved values")
        main_guard = next(node for node in TREE.body if isinstance(node, ast.If) and "__main__" in ast.unparse(node.test))
        self.assertTrue(any(isinstance(node, ast.Call) and ast.unparse(node.func) == "_generate_audio" for node in ast.walk(main_guard)))


if __name__ == "__main__":
    unittest.main()
