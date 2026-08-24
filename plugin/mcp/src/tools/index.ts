import { evidenceTools } from "./evidence.ts";
import { linkTools } from "./links.ts";
import { readTools } from "./reads.ts";
import { tenantTools } from "./tenants.ts";
import type { ToolDefinition } from "./types.ts";
import { workTools } from "./work.ts";
import { writeTools } from "./writes.ts";

export type { ToolDefinition } from "./types.ts";

export const allTools: ToolDefinition[] = [
  ...readTools,
  ...writeTools,
  ...linkTools,
  ...evidenceTools,
  ...workTools,
  ...tenantTools,
];

export const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
