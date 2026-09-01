/**
 * The entity schemas, served as MCP resources.
 *
 * These are the authoritative field documentation — each is generated from, and
 * cites, the migration that defines it. Serving them means an agent can read what
 * a column actually means without a round trip to the repository, which matters
 * most for the fields whose names undersell them (`scope_boundary` is the only
 * defence against overlapping capabilities; `when_`/`then_` carry underscores
 * because they are reserved words).
 *
 * Imported statically rather than read from disk: the MCP server may run from a
 * plugin directory with no fixed relationship to the repository root, and a
 * resource that resolves only when the cwd happens to be right is a resource that
 * fails in the one place it ships.
 */

import acceptanceCriterion from "../../schemas/acceptance-criterion.schema.json" with { type: "json" };
import capability from "../../schemas/capability.schema.json" with { type: "json" };
import feature from "../../schemas/feature.schema.json" with { type: "json" };
import product from "../../schemas/product.schema.json" with { type: "json" };
import story from "../../schemas/story.schema.json" with { type: "json" };

export interface SchemaResource {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
  readonly description: string;
  readonly schema: unknown;
}

const entry = (name: string, title: string, schema: any): SchemaResource => ({
  name: `${name}-schema`,
  uri: `backlog://schema/${name}`,
  title: `${title} schema`,
  description:
    typeof schema?.description === "string"
      ? schema.description
      : `JSON Schema for the ${title} entity.`,
  schema,
});

export const schemaResources: SchemaResource[] = [
  entry("product", "Product", product),
  entry("capability", "Capability", capability),
  entry("feature", "Feature", feature),
  entry("story", "User Story", story),
  entry("acceptance-criterion", "Acceptance Criterion", acceptanceCriterion),
];
