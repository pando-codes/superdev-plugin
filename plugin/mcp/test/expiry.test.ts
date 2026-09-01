/**
 * When the plugin warns that a key is about to stop working.
 *
 * WHY THIS IS ITS OWN FILE, AND ITS OWN FUNCTION
 *
 * The warning exists because of an asymmetry that cannot be fixed at the other
 * end: a lapsed key gets a 401 whose message deliberately will not distinguish
 * invalid from revoked from expired, since distinguishing them would confirm to
 * a stranger that a key exists. That is right at the API boundary and useless to
 * the person whose agent just stopped. The only moment anyone can be told is
 * while the key still works, which makes this small function the entire
 * mechanism.
 *
 * The failure it prevents is not one bad afternoon. Keys minted in the same week
 * expire in the same week, so a cohort of design partners onboarded together
 * fails together, ninety days later, with the same uninformative message.
 */

import { describe, expect, test } from "bun:test";
import { expiryWarning, grantExpiryWarning } from "../src/stdio.ts";

describe("warning about an expiring key", () => {
  test("says nothing while the key has plenty of life", () => {
    expect(expiryWarning(90)).toBeUndefined();
    expect(expiryWarning(15)).toBeUndefined();
  });

  test("warns from the threshold inward, and names the number of days", () => {
    expect(expiryWarning(14)).toContain("14 days");
    expect(expiryWarning(3)).toContain("3 days");
  });

  test("gets the singular right, because '1 days' reads like a bug", () => {
    expect(expiryWarning(1)).toContain("1 day.");
    expect(expiryWarning(1)).not.toContain("1 days");
  });

  test("the last day is louder, and does not say 'in 0 days'", () => {
    const today = expiryWarning(0);
    expect(today).toContain("TODAY");
    expect(today).not.toContain("0 day");
  });

  test("a negative figure still warns rather than going quiet", () => {
    // The resolver refuses to return a row for an expired key, so this should be
    // unreachable. It is handled anyway: of the two ways to be wrong, warning
    // about a key that is fine is recoverable and staying silent about one that
    // is dead is the failure this whole file exists to prevent.
    expect(expiryWarning(-2)).toContain("TODAY");
  });

  test("says nothing for a key that never expires", () => {
    // `--no-expiry` is a deliberate option in mint-key, so null is a real state
    // and not a missing value.
    expect(expiryWarning(null)).toBeUndefined();
  });

  test("says nothing when the server did not send the field at all", () => {
    // An older API has no `key` block. A client must never warn about a
    // credential on the strength of a field it never received.
    expect(expiryWarning(undefined)).toBeUndefined();
    expect(expiryWarning("soon")).toBeUndefined();
    expect(expiryWarning(Number.NaN)).toBeUndefined();
  });
});

/**
 * 046. The grant's warning, which is the one that actually stops a machine.
 *
 * A key's expiry is a nuisance for one agent. A grant's is every agent on the
 * machine, simultaneously, with a 401 that is deliberately unable to say why —
 * and grants minted in the same week expire in the same week, so a team
 * onboarded together stops together.
 */
describe("warning about the orchestrator grant", () => {
  test("a longer fuse than a key's, because the fix takes longer", () => {
    // 14 days is inside a key's window and comfortably outside nothing here.
    expect(expiryWarning(20)).toBeUndefined();
    expect(grantExpiryWarning(20)).toBeDefined();
  });

  test("says nothing while there is genuinely nothing to do", () => {
    expect(grantExpiryWarning(31)).toBeUndefined();
    expect(grantExpiryWarning(90)).toBeUndefined();
  });

  test("names the blast radius, or it reads as one server's problem", () => {
    const soon = grantExpiryWarning(3)!;
    expect(soon).toContain("every agent");
    // And distinguishes itself from the key warning, which is the message a
    // reader will otherwise assume this is a duplicate of.
    expect(soon).toContain("ORCHESTRATOR GRANT");
  });

  test("the last day is louder, and does not say 'in 0 days'", () => {
    const today = grantExpiryWarning(0)!;
    expect(today).toContain("TODAY");
    expect(today).not.toContain("0 day");
  });

  test("says nothing when the backlog predates 046 and sent no field", () => {
    // Silence, not zero. A client must never warn on the strength of a field it
    // never received — that would make every older backlog look like an
    // emergency.
    expect(grantExpiryWarning(undefined)).toBeUndefined();
  });
});
