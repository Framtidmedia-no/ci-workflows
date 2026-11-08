#!/usr/bin/env python3
"""Test av poste-steget i .github/workflows/codex-review.yml (GR-1733).

Steget henter Python-blokken ut av workflow-filen (mellom `python3 - <<'PY'` og `PY`) og kjører den
mot en falsk `gh`. Poenget er å bevise at et svar fra modellen aldri kan gjøre mer enn å legge inn
én review med validerte inline-kommentarer på filer som finnes i diffen.

Kjør: python3 tests/codex-review.test.py
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "codex-review.yml"


def hent_poste_skript() -> str:
    tekst = WORKFLOW.read_text(encoding="utf-8")
    m = re.search(r"python3 - <<'PY'\n(.*?)\n[ \t]*PY\n", tekst, re.S)
    if not m:
        raise AssertionError("fant ikke python-blokken (python3 - <<'PY' ... PY) i codex-review.yml")
    return textwrap.dedent(m.group(1))


class PosteSteg(unittest.TestCase):
    def kjor(self, svar, filer=("src/a.ts", "api/b.ts"), gh_feiler=0, maks="15", skriv_svar=True):
        """gh_feiler = antall første gh-kall som skal feile (simulerer 422 fra GitHub)."""
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            bin_ = d / "bin"
            bin_.mkdir()
            logg = d / "gh-kall.jsonl"
            teller = d / "teller"
            teller.write_text("0")
            (bin_ / "gh").write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                f"logg = open({str(logg)!r}, 'a')\n"
                f"teller = {str(teller)!r}\n"
                "n = int(open(teller).read()); open(teller, 'w').write(str(n + 1))\n"
                "logg.write(json.dumps({'args': sys.argv[1:], 'stdin': sys.stdin.read()}) + '\\n')\n"
                f"sys.exit(1 if n < {gh_feiler} else 0)\n"
            )
            (bin_ / "gh").chmod((bin_ / "gh").stat().st_mode | stat.S_IEXEC)
            ut = d / "codex-out.json"
            if skriv_svar:
                ut.write_text(svar if isinstance(svar, str) else json.dumps(svar), encoding="utf-8")
            fil_liste = d / "files.txt"
            fil_liste.write_text("\n".join(filer) + "\n")
            skript = d / "poste.py"
            skript.write_text(hent_poste_skript())
            env = {
                "PATH": f"{bin_}:{os.environ['PATH']}",
                "GH_TOKEN": "test",
                "REPO": "Gange-Rolv-AS/eksempel",
                "PR": "7",
                "HEAD_SHA": "a" * 40,
                "OUT": str(ut),
                "FILES": str(fil_liste),
                "MAKS": maks,
            }
            r = subprocess.run([sys.executable, str(skript)], env=env, capture_output=True, text=True)
            kall = [json.loads(l) for l in logg.read_text().splitlines()] if logg.exists() else []
            return r, kall

    def test_gyldig_funn_gir_en_review_med_inline_kommentar(self):
        r, kall = self.kjor({"findings": [{"path": "src/a.ts", "line": 12, "severity": "HØY", "body": "Mangler auth-sjekk."}]})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(kall), 1)
        self.assertEqual(kall[0]["args"][:2], ["api", "repos/Gange-Rolv-AS/eksempel/pulls/7/reviews"])
        payload = json.loads(kall[0]["stdin"])
        self.assertEqual(payload["event"], "COMMENT")
        self.assertEqual(payload["commit_id"], "a" * 40)
        self.assertEqual(payload["comments"], [{"path": "src/a.ts", "line": 12, "side": "RIGHT", "body": "[HØY] Mangler auth-sjekk."}])

    def test_ingen_funn_poster_ingenting(self):
        r, kall = self.kjor({"findings": []})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(kall, [])

    def test_fil_utenfor_diffen_droppes(self):
        r, kall = self.kjor({"findings": [{"path": "../../etc/passwd", "line": 1, "severity": "KRITISK", "body": "x"}]})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(kall, [])

    def test_ukjent_alvorlighet_og_ugyldig_linje_droppes(self):
        funn = [
            {"path": "src/a.ts", "line": 3, "severity": "LAV", "body": "stil"},
            {"path": "src/a.ts", "line": 0, "severity": "HØY", "body": "linje null"},
            {"path": "src/a.ts", "line": "3", "severity": "HØY", "body": "linje som tekst"},
            {"path": "src/a.ts", "line": 4, "severity": "HØY", "body": "   "},
        ]
        r, kall = self.kjor({"findings": funn})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(kall, [])

    def test_hemmeligheter_i_teksten_fjernes(self):
        hemmelig = "sk-proj-" + "A1b2C3d4" * 6
        r, kall = self.kjor({"findings": [{"path": "src/a.ts", "line": 5, "severity": "KRITISK", "body": f"Nøkkel {hemmelig} ligger i koden, og password: hunter2hunter2"}]})
        self.assertEqual(r.returncode, 0)
        body = json.loads(kall[0]["stdin"])["comments"][0]["body"]
        self.assertNotIn(hemmelig, body)
        self.assertNotIn("hunter2", body)

    def test_tak_paa_antall_funn_og_lengde(self):
        funn = [{"path": "src/a.ts", "line": i + 1, "severity": "MIDDELS", "body": "x" * 5000} for i in range(40)]
        r, kall = self.kjor({"findings": funn}, maks="15")
        payload = json.loads(kall[0]["stdin"])
        self.assertEqual(len(payload["comments"]), 15)
        self.assertTrue(all(len(c["body"]) <= 1300 for c in payload["comments"]))

    def test_alvorligste_funn_kommer_foerst_naar_taket_slaar_inn(self):
        funn = [{"path": "src/a.ts", "line": i + 1, "severity": "MIDDELS", "body": "m"} for i in range(5)]
        funn.append({"path": "api/b.ts", "line": 9, "severity": "KRITISK", "body": "k"})
        r, kall = self.kjor({"findings": funn}, maks="3")
        kommentarer = json.loads(kall[0]["stdin"])["comments"]
        self.assertEqual(kommentarer[0]["body"], "[KRITISK] k")

    def test_ugyldig_json_og_manglende_fil_feiler_aldri_jobben(self):
        r, kall = self.kjor("dette er ikke json")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(kall, [])
        self.assertIn("::warning::", r.stdout)
        r, kall = self.kjor(None, skriv_svar=False)
        self.assertEqual(r.returncode, 0)
        self.assertIn("::warning::", r.stdout)

    def test_422_fra_github_gir_samlet_kommentar_uten_inline(self):
        r, kall = self.kjor({"findings": [{"path": "src/a.ts", "line": 999, "severity": "HØY", "body": "Linjen finnes ikke i diffen."}]}, gh_feiler=1)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(kall), 2)
        fallback = json.loads(kall[1]["stdin"])
        self.assertNotIn("comments", fallback)
        self.assertIn("src/a.ts:999", fallback["body"])
        self.assertIn("[HØY]", fallback["body"])

    def test_begge_kall_feiler_gir_advarsel_ikke_feil(self):
        r, kall = self.kjor({"findings": [{"path": "src/a.ts", "line": 1, "severity": "HØY", "body": "x"}]}, gh_feiler=2)
        self.assertEqual(r.returncode, 0)
        self.assertIn("::warning::", r.stdout)

    def test_svar_uten_findings_nokkel_er_ingen_funn(self):
        r, kall = self.kjor({"noe": "annet"})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(kall, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
