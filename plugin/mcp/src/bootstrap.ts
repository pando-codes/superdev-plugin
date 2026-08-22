/**
 * 040. The one server that exists to stop existing.
 *
 * WHY THERE IS A THIRD KIND OF SERVER AT ALL
 *
 * stdio.ts has had two: a configured one, and an inert one that registers every
 * tool and answers each with the instructions a person has to act on. That
 * second kind is right whenever the fix needs a person — a missing grant, an
 * expired one, a catalogue nobody can reach.
 *
 * One failure is not like that. A machine holding a live grant, in a repository
 * with no product binding, is stuck on something 040 gave the grant the
 * authority to fix. Answering that with "ask a person to visit the portal" would
 * be telling the session to go and get a thing it is already holding.
 *
 * So this server offers exactly one tool, and calling it ends the reason this
 * server exists.
 *
 * WHY EXACTLY ONE TOOL, AND ONLY ON THE PRODUCT-MANAGER SERVER
 *
 * Registering the catalogue surface here would be a lie: this server has no key,
 * and every one of those tools would refuse. Worse, it would invite an agent to
 * plan around them.
 *
 * And it is offered only where the pinned role is `product-manager`, because
 * that is the role that creates products everywhere else in this system
 * (roles.ts, 026). A builder that could conjure the product it then writes
 * features under would be choosing its own subject, which is the same shape of
 * mistake as choosing its own role.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { provisionProduct, RegistrationError } from "./grant.ts";
import { originRemote, writeProductBinding } from "./repository.ts";

export interface BootstrapOptions {
  readonly apiUrl: string;
  readonly grant: string;
  readonly productPath: string;
  readonly projectDir: string;
  /** Said on stderr, so the same sentence reaches the log and the tool result. */
  readonly note: (line: string) => void;
}

export function createBootstrapServer(options: BootstrapOptions): McpServer {
  const remote = originRemote(options.projectDir);

  const server = new McpServer(
    { name: "superdev-catalog", version: "0.1.0" },
    {
      instructions:
        "THIS REPOSITORY IS NOT BOUND TO A PRODUCT YET, and this server holds no key " +
        "because of it — a key is minted for a product, and there is not one to mint " +
        "against.\n\n" +
        "This machine's grant can create it. Call catalog_bind_repository once, with the " +
        "product this repository is. Everything else in the catalogue stays unavailable " +
        "until the session is reloaded afterwards, because the servers resolve their " +
        "credentials at startup.\n\n" +
        (remote === undefined
          ? "This checkout reports no git remote, so the product will be created without " +
            "one. That works, and it means nothing stops a second machine creating a " +
            "SECOND product for the same code."
          : `The repository will be recorded as ${remote}, read from this checkout rather ` +
            "than from anything a caller types — so a second machine cloning it is handed " +
            "this same product instead of making another."),
    },
  );

  server.registerTool(
    "catalog_bind_repository",
    {
      title: "Bind this repository to a product",
      description:
        "Create the product this repository is, in this machine's account, and write the " +
        "binding at .superdev/product.json. Call this once.\n\n" +
        "IF A PRODUCT FOR THIS REPOSITORY ALREADY EXISTS, THIS JOINS IT. That is the " +
        "ordinary case for the second machine to clone a repository, and it is reported as " +
        "created: false rather than as a failure. The key you propose is ignored in that " +
        "case — the product that already holds this repository keeps its own.\n\n" +
        "The key is permanent. There is no tool anywhere in this system to rename or delete " +
        "a product, because its key scopes every capability, feature, story, and criterion " +
        "underneath it. Usually the repository name; agonise over the display name less.\n\n" +
        "AFTER THIS SUCCEEDS the session must be reloaded before any catalogue tool works: " +
        "this server resolved its credentials at startup and cannot re-register itself " +
        "mid-session. Say so plainly to the user rather than retrying.",
      inputSchema: {
        product_key: z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9-]*$/,
            "lowercase kebab-case, e.g. 'reelmates'. Permanent — it scopes every row underneath it.",
          )
          .describe("kebab-case slug, globally unique. Permanent."),
        name: z.string().min(1).describe("Display name, e.g. 'ReelMates'."),
      },
    },
    async (args: { product_key: string; name: string }) => {
      try {
        const product = await provisionProduct(options.apiUrl, options.grant, {
          key: args.product_key,
          name: args.name,
          ...(remote ? { repo: remote } : {}),
        });

        writeProductBinding(options.productPath, product.productKey, remote);
        options.note(
          `bound this repository to product "${product.productKey}" ` +
            `(${product.created ? "created" : "already existed"}); wrote ${options.productPath}`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text:
                (product.created
                  ? `Created product "${product.productKey}" (${product.name}).`
                  : `This repository is already catalogued as "${product.productKey}" ` +
                    `(${product.name}) — joined it rather than creating a second one.`) +
                `\n\nWrote ${options.productPath}. COMMIT IT: the binding is a fact about ` +
                `the repository, not a local preference, and a colleague's checkout needs ` +
                `it too.\n\n` +
                `Reload the session for the catalogue tools to work — the servers resolve ` +
                `their credentials at startup, so this one is still holding none.`,
            },
          ],
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const forbidden = error instanceof RegistrationError && error.status === 403;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Could not create the product: ${detail}` +
                (forbidden
                  ? `\n\nThis machine's grant exists and may not create products — that is a ` +
                    `ceiling on the grant itself (040), so the fix is a grant minted with ` +
                    `--may-create-products, not a change here. Only the person holding the ` +
                    `catalogue's owner credential can issue one.`
                  : ""),
            },
          ],
          isError: true as const,
        };
      }
    },
  );

  return server;
}
