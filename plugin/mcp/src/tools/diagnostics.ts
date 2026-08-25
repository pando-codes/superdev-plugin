/**
 * The one tool that answers when nothing else does.
 *
 * Every other tool in this package reaches the catalogue, which means every
 * other tool is useless in exactly the state a person most needs help: no
 * credential, a rejected one, or a catalogue that cannot be reached. This one
 * touches neither the client nor the network, so `server.ts` exempts it from
 * the unconfigured short-circuit that makes the rest answer with instructions.
 *
 * It is deliberately not called `catalog_status`. What it reports is not the
 * catalogue's state — it has no way to know that — but THIS MACHINE's.
 */

import { diagnose, render } from "../doctor.ts";
import type { ToolDefinition } from "./types.ts";

export const diagnosticTools: ToolDefinition[] = [
  {
    name: "catalog_doctor",
    title: "Diagnose this machine's catalogue setup",
    description:
      "Report what credentials this machine holds, which files and environment variables " +
      "supplied them, and what each of the four catalog servers would run on. Call this " +
      "FIRST whenever a catalog tool answers with setup instructions, returns 401, or is " +
      "missing from the session — it turns 'something is wrong with superdev' into a named " +
      "file and a named fix.\n\n" +
      "MAKES NO NETWORK CALL, deliberately: the states most worth diagnosing include a " +
      "catalogue that cannot be reached, and it answers in all of them. The half it cannot " +
      "answer is whether the catalogue ACCEPTS the credential — that is catalog_whoami, and " +
      "the report says so when nothing local is wrong.\n\n" +
      "Shows credential prefixes only. Show the output to the user: every fix it names is a " +
      "file on their machine and only they can apply it.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    worksUnconfigured: true,
    // The signature is the shared one, and the client argument is genuinely
    // unused rather than merely unnecessary — see the header.
    handler: async () => {
      const diagnosis = diagnose();
      return { report: render(diagnosis), ...diagnosis };
    },
  },
];
