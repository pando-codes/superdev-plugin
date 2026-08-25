/**
 * The diagnostic, and the two properties that decide whether it is worth having.
 *
 * IT MUST NOT LEAK A CREDENTIAL. Its output goes into a transcript by
 * construction — that is what it is for — so a key reaching it is a key that has
 * to be re-minted. Asserted directly, against a report generated from a machine
 * holding every kind of credential at once.
 *
 * IT MUST NOT CALL A STATE PROBLEM WHEN IT IS NOT ONE. A grant-only machine is
 * the arrangement this system wants, and a report that flags its absent
 * config.json as a fault sends the reader to break a working setup. That is the
 * failure the tool exists to prevent, arriving from inside the tool.
 *
 * Everything here drives `diagnose` directly rather than through a session: it
 * is a pure function of the environment and the filesystem, which is the
 * property that makes it answer in the states worth diagnosing.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, render } from "../src/doctor.ts";

const scratch: string[] = [];

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "superdev-doctor-"));
  scratch.push(made);
  return made;
}

function writeJson(root: string, name: string, body: unknown, mode = 0o600): void {
  mkdirSync(join(root, ".superdev"), { recursive: true });
  writeFileSync(join(root, ".superdev", name), JSON.stringify(body), { mode });
}

/** A syntactically valid credential, and one this test can grep the report for. */
const SECRET = "pcat_live_UNIQUEsecretUNIQUEsecretUNIQUEsecretUNIQUEs";
const TEST_SECRET = "pcat_test_UNIQUEtestkeyUNIQUEtestkeyUNIQUEtestkeyUNIQ";

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

describe("what it must never print", () => {
  test("no credential appears in the report, from any of the places one can live", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", {
      api_url: "https://catalog.example",
      api_key: SECRET,
      keys: { engineer: SECRET, "product-manager": SECRET },
    });
    writeJson(home, "orchestrator.json", { api_url: "https://catalog.example", grant: SECRET });

    const d = diagnose(
      { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project, SUPERDEV_API_KEY: SECRET },
      project,
    );
    const report = render(d);

    // The whole secret, and the secret half of it, and the JSON as well as the
    // rendered text — the tool returns both and a client may show either.
    expect(report).not.toContain(SECRET);
    expect(report).not.toContain(SECRET.slice(14));
    expect(JSON.stringify(d)).not.toContain(SECRET.slice(14));

    // It did see them, though — a report that leaked nothing because it found
    // nothing would pass the assertions above and be worthless.
    expect(d.credentials.length).toBeGreaterThanOrEqual(4);
    expect(report).toContain("pcat_live_UNIQ");
  });

  test("a malformed credential is truncated too, and named as malformed", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", {
      api_url: "https://catalog.example",
      api_key: "not-a-key-but-still-a-secret-someone-pasted",
    });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    expect(render(d)).not.toContain("still-a-secret");
    expect(d.problems.join("\n")).toContain("not shaped like a credential");
  });
});

describe("a machine credentialled the way mint-grant leaves it", () => {
  function granted(): { env: NodeJS.ProcessEnv; project: string } {
    const home = dir();
    const project = dir();
    writeJson(home, "orchestrator.json", {
      api_url: "https://catalog.example",
      grant: SECRET,
    });
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);
    return { env: { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project };
  }

  test("reports NO problems — an absent config.json is the correct arrangement", () => {
    const { env, project } = granted();
    const d = diagnose(env, project);

    // The assertion this file exists for. A grant and no key is not a
    // half-configured machine; it is a configured one.
    expect(d.problems).toEqual([]);
    expect(render(d)).not.toContain("✗");
  });

  test("says all four servers would run, and names the unpinned one's default role", () => {
    const { env, project } = granted();
    const d = diagnose(env, project);

    expect(d.servers.map((s) => s.name)).toEqual([
      "catalog",
      "catalog-product-manager",
      "catalog-engineer",
      "catalog-quality-assurance",
    ]);
    for (const server of d.servers) expect(server.outcome).not.toContain("NOTHING");
    // The thing a reader cannot otherwise find out without reading stdio.ts.
    expect(d.servers[0]!.outcome).toContain("product-manager");
    expect(d.servers[0]!.detail).toContain("no role is declared");
  });

  test("sends the reader to whoami, because the local half is all it can check", () => {
    const { env, project } = granted();
    expect(diagnose(env, project).nextStep).toContain("catalog_whoami");
  });
});

describe("the states it exists to name", () => {
  test("a bare api_key and no grant: the pinned servers get nothing, and it says why", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", { api_url: "https://catalog.example", api_key: SECRET });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    expect(d.servers[0]!.outcome).toContain("configured api_key");
    for (const pinned of d.servers.slice(1)) {
      expect(pinned.outcome).toContain("NOTHING");
      // The rule from stdio.ts, surfaced where someone can act on it instead of
      // discovering it as three servers that mysteriously have no tools.
      expect(pinned.detail).toContain("will NOT use one");
    }
  });

  test("an unexpanded ${...} placeholder is reported, not silently ignored", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "orchestrator.json", { api_url: "https://catalog.example", grant: SECRET });

    // 0.6.0 shipped with all four servers in this state. The variable beats the
    // file it was meant to defer to, so the file is silenced and every message
    // points somewhere other than at the cause.
    const d = diagnose(
      { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project, SUPERDEV_API_URL: "${SUPERDEV_API_URL}" },
      project,
    );

    expect(d.environment.join("\n")).toContain("IGNORED");
    expect(d.problems.join("\n")).toContain("silenced");
  });

  test("a test credential against a live catalogue — valid apart, wrong together", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", {
      api_url: "https://pando-catalog-api.fly.dev",
      api_key: TEST_SECRET,
    });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    // It is rejected as though it were invalid, and nothing else in the system
    // is positioned to notice the pairing.
    expect(d.problems.join("\n")).toContain("TEST credential");
  });

  test("but the same credential against a local stack is fine", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", { api_url: "http://localhost:54321", api_key: TEST_SECRET });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);
    expect(d.problems.join("\n")).not.toContain("TEST credential");
  });

  test("a grant whose recorded expiry is near is a problem, without a network call", () => {
    const home = dir();
    const project = dir();
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    writeJson(home, "orchestrator.json", {
      api_url: "https://catalog.example",
      grant: SECRET,
      expires_at: soon,
    });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    expect(d.grantExpiresInDays).toBe(5);
    // The sentence has to say the blast radius, or it reads as this one server's
    // problem rather than the machine's.
    expect(d.problems.join("\n")).toContain("Every agent on this machine");
  });

  test("a grant with a comfortable expiry is reported and is not a problem", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "orchestrator.json", {
      api_url: "https://catalog.example",
      grant: SECRET,
      expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
    });
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    expect(d.grantExpiresInDays).toBe(80);
    expect(d.problems).toEqual([]);
    expect(render(d)).toContain("GRANT EXPIRY");
  });

  test("a grant minted before 046 recorded no expiry, and that is silence not zero", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "orchestrator.json", { api_url: "https://catalog.example", grant: SECRET });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    expect(d.grantExpiresInDays).toBeUndefined();
    expect(d.problems.join("\n")).not.toContain("expires in");
  });

  test("a world-readable credential file is a problem with a command attached", () => {
    const home = dir();
    const project = dir();
    writeJson(home, "orchestrator.json", { api_url: "https://catalog.example", grant: SECRET }, 0o644);

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);
    expect(d.problems.join("\n")).toContain("chmod 600");
  });

  test("malformed JSON is named as malformed, not as a missing key", () => {
    const home = dir();
    const project = dir();
    mkdirSync(join(home, ".superdev"), { recursive: true });
    writeFileSync(join(home, ".superdev", "config.json"), '{ "api_url": "x", }', { mode: 0o600 });

    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);
    expect(d.problems.join("\n")).toContain("not valid JSON");
  });

  test("nothing at all: it says so, rather than listing four broken servers", () => {
    const home = dir();
    const project = dir();
    const d = diagnose({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project);

    expect(d.credentials).toEqual([]);
    expect(d.nextStep).toContain("holds no credential");
    expect(d.nextStep).toContain("grant");
  });
});
