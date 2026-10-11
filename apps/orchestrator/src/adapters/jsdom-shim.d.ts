// jsdom ships without types and the repo has no @types/jsdom. The adapter tests only build a
// document from saved HTML fixtures, so this is all they need. (Remove if @types/jsdom is added.)
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: { readonly document: unknown };
  }
}
