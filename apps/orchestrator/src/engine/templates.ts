// Workflow template values (§7.1): strings such as "$params.sources", "$item.company",
// "$steps.dedupe.output", "$profile.fitThreshold", "$producer.output" or "$branch" in a step's
// `input`, `over` or `options`. The engine resolves them against the run; the task input
// builders then add what the database knows (inputs.ts).

export interface TemplateScope {
  /** The run's parameters, over the effective Search Profile fields (so $params.sources works). */
  params: Record<string, unknown>;
  /** The effective Search Profile (with the run's overrides), or null. */
  profile: Record<string, unknown> | null;
  /** The current item of a map or a per-job branch. */
  item?: unknown;
  /** The output of an earlier step, looked up in this branch first, then at run level. */
  steps?: (key: string) => unknown;
  /** A gate checker's producer output. */
  producer?: unknown;
  /** The branch key (job id). */
  branch?: string;
}

function walk(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveReference(ref: string, scope: TemplateScope): unknown {
  const [head, ...rest] = ref.slice(1).split(".");
  switch (head) {
    case "params":
      return walk(scope.params, rest);
    case "profile":
      return walk(scope.profile, rest);
    case "item":
      return walk(scope.item, rest);
    case "branch":
      return rest.length === 0 ? scope.branch : undefined;
    case "producer":
      // "$producer.output[.path]"
      return rest[0] === "output" ? walk(scope.producer, rest.slice(1)) : undefined;
    case "steps": {
      // "$steps.<key>.output[.path]"
      const [key, field, ...path] = rest;
      if (!key || field !== "output" || !scope.steps) return undefined;
      return walk(scope.steps(key), path);
    }
    default:
      return undefined;
  }
}

/** Resolve every "$…" string in a value (objects and arrays recursively); literals pass through. */
export function resolveTemplate(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === "string") return value.startsWith("$") ? resolveReference(value, scope) : value;
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, scope));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplate(v, scope)]));
  }
  return value;
}

/** A map's `over`: a list, or the `items` of a filter's output. Null when it is neither. */
export function resolveList(over: string, scope: TemplateScope): unknown[] | null {
  const value = resolveTemplate(over, scope);
  if (Array.isArray(value)) return value;
  const items = (value as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? items : null;
}
