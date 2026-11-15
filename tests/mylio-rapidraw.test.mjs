import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Mylio conversion mappings and review-only safeguards", () => {
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(
    python,
    ["-m", "unittest", "discover", "-s", "tests", "-p", "test_mylio_rapidraw.py", "-v"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
