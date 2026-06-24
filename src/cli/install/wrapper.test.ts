import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSkillAsset } from "../../../scripts/gen-skill-asset.js";
import { skillMd } from "./assets.js";
import { ensureWrapper, packagedSkillPath } from "./wrapper.js";

// A unique temp scratch dir per test; the caller cleans it up in a finally.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "otacon-ensure-wrapper-"));
}

// A real packaged-asset file (what `ensureWrapper` symlinks user-scope wrappers to).
function pkgFile(dir: string): string {
  const path = join(dir, "pkg-SKILL.md");
  writeFileSync(path, skillMd());
  return path;
}

// In the source/test context this module resolves to src/skills/otacon/SKILL.md,
// which never exists, so the packaged path is unreachable, deterministically
// undefined. That is the source-run behavior callers rely on to copy instead.
test("packagedSkillPath is undefined when run from source", () => {
  expect(packagedSkillPath()).toBeUndefined();
});

// Drift guard: the shipped asset must byte-equal skillMd(). writeSkillAsset() is the
// exact write the build runs, so exercising it against a temp target proves the
// generator emits current protocol text (no stale copy in the package).
test("writeSkillAsset writes a byte-equal copy of skillMd()", () => {
  const target = join(tmpdir(), `otacon-skill-asset-${process.pid}-${Date.now()}.md`);
  try {
    const written = writeSkillAsset(target);
    expect(written).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(skillMd());
  } finally {
    rmSync(target, { force: true });
  }
});

// User scope + a real packaged file → a symlink to it. The link's resolved target
// equals the asset's, and a second identical call is a no-op (idempotent convergence).
test("ensureWrapper symlinks user-scope wrappers to the packaged file", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");

    const first = ensureWrapper(wrapper, "user", pkg);
    expect(first).toEqual({ mode: "symlink", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(true);
    expect(realpathSync(wrapper)).toBe(realpathSync(pkg));
    // The protocol text is reachable THROUGH the link (readFileSync follows it).
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());

    const second = ensureWrapper(wrapper, "user", pkg);
    expect(second).toEqual({ mode: "symlink", changed: false });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// User scope but no packaged path (source/npx) → there is nothing stable to link to,
// so the wrapper is a plain copy of skillMd().
test("ensureWrapper copies when there is no packaged path", () => {
  const dir = scratch();
  try {
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");
    const result = ensureWrapper(wrapper, "user", undefined);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
    // Idempotent: a matching copy is a no-op.
    expect(ensureWrapper(wrapper, "user", undefined)).toEqual({ mode: "copy", changed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Project scope always copies, even with a real packaged file: a committed wrapper
// must be machine-independent and cannot point at a machine-local global path.
test("ensureWrapper copies project-scope wrappers even with a packaged file", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "proj", ".claude", "skills", "otacon", "SKILL.md");
    const result = ensureWrapper(wrapper, "project", pkg);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// User scope + a real packaged file, but the linker throws (Windows/EPERM/EXDEV) →
// fall through to a copy. Proves the symlink-unsupported fallback.
test("ensureWrapper falls back to a copy when symlinking throws", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");
    const throwing = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, symlink"), {
        code: "EPERM",
      });
    };
    const result = ensureWrapper(wrapper, "user", pkg, throwing);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Downgrade self-heal: an existing symlink, then a call with no packaged path,
// becomes a regular-file copy (the stale link is cleared first).
test("ensureWrapper downgrades a symlink to a copy when the packaged path disappears", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");

    expect(ensureWrapper(wrapper, "user", pkg).mode).toBe("symlink");
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(true);

    const downgraded = ensureWrapper(wrapper, "user", undefined);
    expect(downgraded).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
